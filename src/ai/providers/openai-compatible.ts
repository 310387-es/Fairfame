import { z } from "zod";
import {
  LlmError,
  LlmRefusalError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "../types.ts";

/**
 * Any host that speaks OpenAI's chat-completions dialect.
 *
 * **A provider, not a vendor** — which is the whole reason this file exists.
 * Cerebras, Groq, Mistral, Together, OpenRouter, vLLM and a local Ollama all
 * answer `POST /chat/completions` with the same envelope, so the seam that
 * matters is the *dialect*, not the company. Four vendor files would have been
 * four copies of this one, drifting apart at four different rates; one file
 * plus three environment variables reaches all of them, and a new host is a
 * `.env` edit rather than a pull request.
 *
 * What it is for right now: Gemini's free tier is metered per day per model,
 * and a day of development spends it (`docs/23`, 12 Aug 2026 — two eval runs
 * could not finish). Several of these hosts publish far larger free
 * allowances, so this is the escape hatch from a development-time ceiling, not
 * a change of production plan.
 *
 * Four dialect facts this encodes, each of which is a wrong number or a crash
 * if you get it wrong:
 *
 *   - **`completion_tokens` already contains the reasoning tokens.** Gemini
 *     reports thoughts *beside* the output; OpenAI reports them *inside* it.
 *     Copying Gemini's mapping here would bill every reasoning token twice —
 *     see `usageFrom`.
 *   - **The system prompt is a message with `role: "system"`,** unlike
 *     Anthropic's top-level field and Gemini's `systemInstruction`. It is
 *     prepended here, never merged into the user turn, because the user turn is
 *     where customer text lives.
 *   - **A refusal is a 200.** Structured-output refusals arrive as
 *     `message.refusal` with `content: null`, and moderation stops arrive as
 *     `finish_reason: "content_filter"`. Reading `message.content` blindly
 *     yields an empty analysis rather than an error.
 *   - **Truncation is `finish_reason: "length"`,** which the caller must be
 *     able to tell from a malformed answer: one needs a bigger budget, the
 *     other needs another attempt.
 */

export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";

const usageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    completion_tokens_details: z
      .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
      .loose()
      .optional(),
  })
  .loose();

const responseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                content: z.string().nullable().optional(),
                /** Present, and a string, when the model declined a structured answer. */
                refusal: z.string().nullable().optional(),
              })
              .loose()
              .optional(),
            finish_reason: z.string().nullable().optional(),
          })
          .loose(),
      )
      .optional(),
    usage: usageSchema.optional(),
    model: z.string().optional(),
  })
  .loose();

const errorSchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
        type: z.string().optional(),
        code: z.union([z.string(), z.number()]).optional(),
        param: z.string().nullable().optional(),
      })
      .loose(),
  })
  .loose();

export type OpenAiCompatibleFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type OpenAiCompatibleOptions = {
  apiKey: string;
  model: string;
  /**
   * The API root, including whatever version segment the host uses —
   * `https://api.cerebras.ai/v1`, `http://localhost:11434/v1`. There is no
   * default, because every host has a different one; that is what makes this
   * a dialect rather than a vendor.
   */
  baseUrl: string;
  fetchImpl?: OpenAiCompatibleFetch;
};

/** Seconds in `retry-after`, or milliseconds in the header OpenAI also sends. */
function retryAfterFrom(response: Response): number | undefined {
  const ms = Number(response.headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;

  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
}

/**
 * Tokens, with reasoning separated back out of the completion.
 *
 * `completion_tokens` is the whole billed completion — visible output *plus*
 * whatever the model thought first. `LlmUsage` splits the two, and
 * `estimateCost` charges `outputTokens + thinkingTokens`, so passing the total
 * through as `outputTokens` while also reporting `thinkingTokens` would bill
 * the reasoning twice. Subtracting is the faithful mapping; the floor at zero
 * is for a host that reports reasoning it did not include in the total.
 */
function usageFrom(usage: z.infer<typeof usageSchema> | undefined): LlmResponse["usage"] {
  const completion = usage?.completion_tokens ?? 0;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;

  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: Math.max(0, completion - reasoning),
    thinkingTokens: reasoning,
  };
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): LlmProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  return {
    name: OPENAI_COMPATIBLE_PROVIDER,
    model: options.model,

    /*
      Deliberately absent, so the configured `AI_REQUESTS_PER_MINUTE` applies.

      Every host behind this file has a different free-tier ceiling — and the
      same host has a different one per model and per account tier. A number
      hard-coded here would be wrong for all but one deployment, and wrong in
      the expensive direction: too high and every batch walks into 429s.
    */

    async complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      // A per-request model overrides the provider's default — how per-task
      // routing (src/ai/client.ts) reaches the wire.
      const model = request.model ?? options.model;

      const body = {
        model,
        // The system prompt is a message here, and it goes first. Merging it
        // into the user turn would put our instructions in the position
        // customer text occupies, which is the thing guardrails.ts exists to
        // prevent.
        messages: [
          ...(request.system ? [{ role: "system", content: request.system }] : []),
          ...request.messages.map((message) => ({
            role: message.role,
            content: message.text,
          })),
        ],
        max_tokens: request.maxOutputTokens,
        ...(request.responseSchema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
                  // Required by the dialect even though nothing reads it back.
                  name: "response",
                  schema: request.responseSchema,
                  // The difference between "please" and "must". A host that
                  // does not support strict mode ignores the flag; one that
                  // does stops us having to hope.
                  strict: true,
                },
              },
            }
          : {}),
        // Only when the prompt asked for it. An unsupported field is a 400 on
        // some hosts, so the default must be to send nothing at all — see
        // `LlmRequest.reasoning`, where this is a hint a provider may ignore.
        ...(request.reasoning === "none" ? { reasoning_effort: "none" } : {}),
      };

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
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
          `Could not reach ${baseUrl}: ${error instanceof Error ? error.message : "unknown error"}`,
          { provider: OPENAI_COMPATIBLE_PROVIDER, retryable: true },
        );
      }

      if (!response.ok) throw await classify(response, baseUrl);

      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new LlmError(
          `Unexpected response shape from ${baseUrl}: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
          { provider: OPENAI_COMPATIBLE_PROVIDER, retryable: false },
        );
      }

      const data = parsed.data;
      const choice = data.choices?.[0];

      if (!choice) {
        throw new LlmError("The provider returned no choices.", {
          provider: OPENAI_COMPATIBLE_PROVIDER,
          // Empty choices with a 200 is transient in practice, as it is on Gemini.
          retryable: true,
        });
      }

      const finishReason = (choice.finish_reason ?? "stop").toLowerCase();

      // Checked before the content is read: both of these arrive with
      // `content: null`, and treating that as an empty answer would record a
      // refusal as a successful analysis of nothing.
      if (choice.message?.refusal) {
        throw new LlmRefusalError(OPENAI_COMPATIBLE_PROVIDER, choice.message.refusal.slice(0, 120));
      }
      if (finishReason === "content_filter") {
        throw new LlmRefusalError(OPENAI_COMPATIBLE_PROVIDER, finishReason);
      }

      return {
        text: (choice.message?.content ?? "").trim(),
        usage: usageFrom(data.usage),
        provider: OPENAI_COMPATIBLE_PROVIDER,
        // What the host says it ran, not what we asked for — an alias or a
        // routed model (OpenRouter does both) would otherwise be audited under
        // a name that never served the request.
        model: data.model ?? model,
        finishReason,
        // The dialect's word for "I ran out of budget".
        truncated: finishReason === "length",
      };
    },
  };
}

/** A code the hosts spell as either a string or a number, or not at all. */
function nonEmpty(code: string | number | undefined): string | undefined {
  const value = String(code ?? "").trim();
  return value.length > 0 ? value : undefined;
}

async function classify(response: Response, baseUrl: string): Promise<LlmError> {
  let message = `${baseUrl} returned ${response.status}.`;
  let code: string | undefined;

  try {
    const parsed = errorSchema.safeParse(JSON.parse(await response.text()));
    if (parsed.success) {
      message = parsed.data.error.message ?? message;
      // `type` where the host sends one ("rate_limit_exceeded"), else the code.
      code = parsed.data.error.type ?? nonEmpty(parsed.data.error.code);
    }
  } catch {
    // Not every host returns JSON on an error; the status is enough to classify.
  }

  const options = {
    provider: OPENAI_COMPATIBLE_PROVIDER,
    status: response.status,
    ...(code ? { code } : {}),
  };

  if (response.status === 429) {
    const retryAfterMs = retryAfterFrom(response);

    return new LlmError(
      `Rate limited by ${baseUrl} (${message}). Free tiers here are metered per minute and per day; ` +
        "AI_REQUESTS_PER_MINUTE is the knob.",
      {
        ...options,
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    );
  }

  if (response.status === 401 || response.status === 403) {
    return new LlmError(
      `${baseUrl} rejected the API key (${message}). Check OPENAI_COMPAT_API_KEY, and that the key belongs to this host.`,
      { ...options, retryable: false },
    );
  }

  if (response.status === 404) {
    return new LlmError(
      `${baseUrl} has no such model or endpoint (${message}). Check OPENAI_COMPAT_MODEL, and that ` +
        "OPENAI_COMPAT_BASE_URL includes the version segment — most hosts serve /v1/chat/completions.",
      { ...options, retryable: false },
    );
  }

  if (response.status === 400 && /reasoning_effort/i.test(message)) {
    // The one field we send that hosts genuinely disagree about. Said plainly,
    // because it fails every call rather than one, and the generic "invalid
    // request" would send the reader to their prompt.
    return new LlmError(
      `${baseUrl} does not accept the no-reasoning hint (${message}). It is sent only for prompts ` +
        'that declare `reasoning: "none"` — see src/ai/types.ts, where it is a hint a provider may ignore.',
      { ...options, retryable: false },
    );
  }

  return new LlmError(message, { ...options, retryable: response.status >= 500 });
}
