import { z } from "zod";
import {
  LlmError,
  LlmRefusalError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "../types.ts";

/**
 * Google Gemini, over the REST API (P1a-T1).
 *
 * The development provider: a real free tier with no card, which is what lets
 * the AI layer be built and evaluated before anyone pays for anything. Written
 * against `generativelanguage.googleapis.com/v1beta` with no SDK — the surface
 * we use is one POST, and T1 requires us to own retries, timeouts and usage
 * accounting anyway, which is most of what an SDK would have contributed.
 *
 * Two Gemini-specific shapes worth knowing:
 *
 *   - **System instructions are a separate field** (`systemInstruction`), not a
 *     message with a role. Putting them in `contents` would make them ordinary
 *     user text, which is exactly the position customer content occupies.
 *   - **A blocked response is a 200.** Safety refusals arrive as an empty
 *     candidate list with a `promptFeedback.blockReason`, or a candidate whose
 *     `finishReason` is `SAFETY`. Code that reads `candidates[0]` without
 *     checking throws on a perfectly normal API outcome.
 */

export const GEMINI_PROVIDER = "gemini";

const usageSchema = z
  .object({
    promptTokenCount: z.number().int().nonnegative().optional(),
    candidatesTokenCount: z.number().int().nonnegative().optional(),
    // Reported for thinking-capable models; billed as output.
    thoughtsTokenCount: z.number().int().nonnegative().optional(),
    totalTokenCount: z.number().int().nonnegative().optional(),
  })
  .loose();

const responseSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            content: z
              .object({
                parts: z.array(z.object({ text: z.string().optional() }).loose()).optional(),
              })
              .loose()
              .optional(),
            finishReason: z.string().optional(),
          })
          .loose(),
      )
      .optional(),
    promptFeedback: z.object({ blockReason: z.string().optional() }).loose().optional(),
    usageMetadata: usageSchema.optional(),
    modelVersion: z.string().optional(),
  })
  .loose();

const errorSchema = z
  .object({
    error: z
      .object({
        code: z.number().int().optional(),
        message: z.string().optional(),
        status: z.string().optional(),
      })
      .loose(),
  })
  .loose();

export type GeminiFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type GeminiOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: GeminiFetch;
};

/** Google returns `RetryInfo` details on 429; fall back to the header. */
function retryAfterFrom(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;

  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
}

/**
 * Extra output budget reserved for a thinking model's reasoning.
 *
 * Sized from measurement, not guesswork: the flash tier spent 350–620 thinking
 * tokens on a short reply prompt, so 1024 leaves the caller's own budget intact
 * on every model tried. A non-thinking model simply never reaches it.
 */
const THINKING_HEADROOM_TOKENS = 1_024;

export function createGeminiProvider(options: GeminiOptions): LlmProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com").replace(
    /\/+$/,
    "",
  );

  return {
    name: GEMINI_PROVIDER,
    model: options.model,

    async complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      // A per-request model overrides the provider's default — how per-task
      // routing (src/ai/client.ts) reaches the wire.
      const model = request.model ?? options.model;
      const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

      const body = {
        contents: request.messages.map((message) => ({
          // Gemini's assistant role is "model", not "assistant".
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.text }],
        })),
        ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
        generationConfig: {
          // Gemini counts *thinking* tokens against `maxOutputTokens`, which
          // the caller sets to mean "how long may the answer be". On a thinking
          // model the two readings collide badly: measured here, 3.5-flash and
          // 3.6-flash each spent ~615 tokens reasoning against a 640 budget and
          // returned 21 tokens of truncated Turkish — then the empty-reply
          // retry ran until the request deadline.
          //
          // Headroom rather than `thinkingConfig`, because the budget field is
          // a hint the model may exceed (measured: 381 thoughts against a
          // requested 128) and its shape differs across model generations. The
          // headroom costs nothing extra: those thinking tokens are billed
          // either way, and a truncated call pays for them while producing
          // nothing usable.
          maxOutputTokens: request.maxOutputTokens + THINKING_HEADROOM_TOKENS,
          ...(request.responseSchema
            ? {
                responseMimeType: "application/json",
                responseSchema: request.responseSchema,
              }
            : {}),
        },
      };

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          // Header rather than `?key=`: an API key in a URL leaks into access
          // logs, browser history and error reports.
          headers: {
            "x-goog-api-key": options.apiKey,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        // An abort is our own timeout firing, not a provider fault.
        if (error instanceof Error && error.name === "AbortError") throw error;

        throw new LlmError(
          `Could not reach Gemini: ${error instanceof Error ? error.message : "unknown error"}`,
          { provider: GEMINI_PROVIDER, retryable: true },
        );
      }

      if (!response.ok) throw await classify(response);

      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new LlmError(
          `Unexpected Gemini response shape: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
          { provider: GEMINI_PROVIDER, retryable: false },
        );
      }

      const data = parsed.data;

      // A prompt-level block: no candidates at all.
      if (data.promptFeedback?.blockReason) {
        throw new LlmRefusalError(GEMINI_PROVIDER, data.promptFeedback.blockReason);
      }

      const candidate = data.candidates?.[0];
      if (!candidate) {
        throw new LlmError("Gemini returned no candidates.", {
          provider: GEMINI_PROVIDER,
          // Empty candidates with no block reason is transient in practice.
          retryable: true,
        });
      }

      const finishReason = (candidate.finishReason ?? "stop").toLowerCase();
      if (finishReason === "safety" || finishReason === "prohibited_content") {
        throw new LlmRefusalError(GEMINI_PROVIDER, finishReason);
      }

      const text = (candidate.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("")
        .trim();

      const usage = data.usageMetadata;

      return {
        text,
        usage: {
          inputTokens: usage?.promptTokenCount ?? 0,
          outputTokens: usage?.candidatesTokenCount ?? 0,
          thinkingTokens: usage?.thoughtsTokenCount ?? 0,
        },
        provider: GEMINI_PROVIDER,
        // Prefer what the API says it ran over what we asked for.
        model: data.modelVersion ?? model,
        finishReason,
        truncated: finishReason === "max_tokens",
      };
    },
  };
}

async function classify(response: Response): Promise<LlmError> {
  let message = `Gemini returned ${response.status}.`;
  let status: string | undefined;

  try {
    const parsed = errorSchema.safeParse(JSON.parse(await response.text()));
    if (parsed.success) {
      message = parsed.data.error.message ?? message;
      status = parsed.data.error.status;
    }
  } catch {
    // Non-JSON error body; the status code is enough to classify.
  }

  const options = {
    provider: GEMINI_PROVIDER,
    status: response.status,
    ...(status ? { code: status } : {}),
  };

  if (response.status === 429) {
    return new LlmError(
      `Gemini rate limit reached (${message}). The free tier is limited per minute and per day.`,
      {
        ...options,
        retryable: true,
        ...(retryAfterFrom(response) !== undefined
          ? { retryAfterMs: retryAfterFrom(response) }
          : {}),
      },
    );
  }

  if (response.status === 401 || response.status === 403) {
    return new LlmError(
      `Gemini rejected the API key (${message}). Check GEMINI_API_KEY, and that the key may use this model.`,
      { ...options, retryable: false },
    );
  }

  if (response.status === 404) {
    return new LlmError(
      `Gemini has no model "${response.url.split("/").pop() ?? ""}" for this key (${message}). ` +
        "Model availability differs between the free and paid tiers.",
      { ...options, retryable: false },
    );
  }

  return new LlmError(message, { ...options, retryable: response.status >= 500 });
}
