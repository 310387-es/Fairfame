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
        // Google puts the *useful* half of a 400 in here: `message` is the
        // useless "Request contains an invalid argument", and the field that
        // was actually rejected is in these violations.
        details: z
          .array(
            z
              .object({
                fieldViolations: z
                  .array(z.object({ field: z.string().optional() }).loose())
                  .optional(),
              })
              .loose(),
          )
          .optional(),
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

/**
 * The same reserve for a call that asked for no reasoning at all.
 *
 * Smaller, not absent, and that is the whole point. Every thinking control here
 * is a *request*, not a guarantee — the comment above records 381 thoughts
 * against a requested 128 — so a model that thinks a little anyway would eat
 * the caller's own budget and truncate. 256 tokens absorbs that overshoot; it
 * is nowhere near enough to pay for a reasoning pass, which is the spend the
 * caller is opting out of. Unused headroom costs nothing: `maxOutputTokens` is
 * a ceiling, not an allocation.
 */
const NO_REASONING_HEADROOM_TOKENS = 256;

/**
 * How "I want no reasoning" is said to Gemini.
 *
 * `thinkingLevel: "minimal"`, and **not** `thinkingBudget: 0`, which is the
 * obvious answer and is wrong here. Measured against the live API on 12 Aug
 * 2026, with the three models this project routes tasks to:
 *
 *   | model                 | budget: 0 | level: minimal | default   |
 *   | gemini-3.5-flash-lite | **400**   | 0 thoughts     | 0 thoughts|
 *   | gemini-3.5-flash      | 0         | 0 thoughts     | 66        |
 *   | gemini-3.6-flash      | **400**   | 0 thoughts     | 57        |
 *
 * A 400 is not a degraded answer, it is *no* analysis — so the budget field
 * would have taken the whole analyze path down on the model analysis actually
 * runs on. `minimal` is accepted by every model reachable with this key and
 * measured 0 thinking tokens on all of them. `thinkingLevel: "off"`/`"none"`
 * are not enum members and 400 everywhere.
 */
const NO_REASONING_CONFIG = { thinkingLevel: "minimal" } as const;

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

      // A prompt that declares it wants no reasoning (`LlmRequest.reasoning`).
      // Gemini has a control for it; a provider without one would ignore the
      // field, which is why it is a hint rather than a knob.
      const noReasoning = request.reasoning === "none";

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
          //
          // Which is the argument for headroom, not for *paying* to think. A
          // prompt that says it wants no reasoning asks for that too, and keeps
          // a reduced reserve for the overshoot the paragraph above measured —
          // belt and braces, because the braces are advisory.
          maxOutputTokens:
            request.maxOutputTokens +
            (noReasoning ? NO_REASONING_HEADROOM_TOKENS : THINKING_HEADROOM_TOKENS),
          ...(noReasoning ? { thinkingConfig: NO_REASONING_CONFIG } : {}),
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
  let fields: string[] = [];

  try {
    const parsed = errorSchema.safeParse(JSON.parse(await response.text()));
    if (parsed.success) {
      message = parsed.data.error.message ?? message;
      status = parsed.data.error.status;
      fields = (parsed.data.error.details ?? []).flatMap((detail) =>
        (detail.fieldViolations ?? []).map((violation) => violation.field ?? ""),
      );
    }
  } catch {
    // Non-JSON error body; the status code is enough to classify.
  }

  const options = {
    provider: GEMINI_PROVIDER,
    status: response.status,
    ...(status ? { code: status } : {}),
  };

  // The one 400 this provider can cause by itself. Gemini's message for it is
  // "Request contains an invalid argument", which sends the reader looking at
  // their prompt; the model rejecting the no-reasoning hint is a different
  // problem with a different fix, and it fails *every* call on that model
  // rather than one, so it says so.
  if (response.status === 400 && fields.some((field) => field.includes("thinking_config"))) {
    return new LlmError(
      `This Gemini model does not accept the no-reasoning hint (${message}). ` +
        "The thinking control's shape differs by model generation — see NO_REASONING_CONFIG " +
        "in src/ai/providers/gemini.ts, and re-measure it against this model before changing it.",
      { ...options, retryable: false },
    );
  }

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
