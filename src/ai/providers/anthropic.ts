import { z } from "zod";
import {
  LlmError,
  LlmRefusalError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "../types.ts";

/**
 * Anthropic Claude, over the Messages API (P1a-T1).
 *
 * The production path. Written now so the abstraction is demonstrably
 * swappable rather than theoretically swappable — and so going live is an
 * environment change, not a development task. **Fixture-tested only:** it has
 * never made a real call, because the account has no API credits yet.
 *
 * Three current-API facts this encodes, each of which is a 400 if you get it
 * wrong on today's models:
 *
 *   - **No sampling parameters.** `temperature`, `top_p` and `top_k` are
 *     rejected on Opus 5 and its generation. Behaviour is steered by prompting.
 *   - **No `budget_tokens`.** Fixed thinking budgets are gone; thinking is
 *     adaptive and on by default on Opus 5, and depth is controlled by effort.
 *   - **A refusal is a 200.** `stop_reason: "refusal"` arrives with an empty or
 *     partial `content`, so reading `content[0].text` unconditionally throws on
 *     a normal outcome.
 *
 * Structured output uses `output_config.format`, not a prefilled assistant turn
 * — prefills are rejected on this model generation.
 */

export const ANTHROPIC_PROVIDER = "anthropic";

/** The wire version this client is written against. */
const API_VERSION = "2023-06-01";

const responseSchema = z
  .object({
    content: z
      .array(z.object({ type: z.string(), text: z.string().optional() }).loose())
      .optional(),
    stop_reason: z.string().nullable().optional(),
    stop_details: z
      .object({ type: z.string().optional(), category: z.string().nullable().optional() })
      .loose()
      .nullable()
      .optional(),
    model: z.string().optional(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const errorSchema = z
  .object({
    error: z.object({ type: z.string().optional(), message: z.string().optional() }).loose(),
  })
  .loose();

export type AnthropicFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type AnthropicOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: AnthropicFetch;
};

export function createAnthropicProvider(options: AnthropicOptions): LlmProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");

  return {
    name: ANTHROPIC_PROVIDER,
    model: options.model,

    async complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      const body = {
        // A per-request model overrides the provider's default — how per-task
        // routing (src/ai/client.ts) reaches the wire.
        model: request.model ?? options.model,
        max_tokens: request.maxOutputTokens,
        ...(request.system ? { system: request.system } : {}),
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.text,
        })),
        ...(request.responseSchema
          ? {
              output_config: {
                format: { type: "json_schema", schema: request.responseSchema },
              },
            }
          : {}),
      };

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": options.apiKey,
            "anthropic-version": API_VERSION,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;

        throw new LlmError(
          `Could not reach Anthropic: ${error instanceof Error ? error.message : "unknown error"}`,
          { provider: ANTHROPIC_PROVIDER, retryable: true },
        );
      }

      if (!response.ok) throw await classify(response);

      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new LlmError(
          `Unexpected Anthropic response shape: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
          { provider: ANTHROPIC_PROVIDER, retryable: false },
        );
      }

      const data = parsed.data;
      const finishReason = (data.stop_reason ?? "end_turn").toLowerCase();

      // Checked before touching content: a refusal can carry none at all.
      if (finishReason === "refusal") {
        throw new LlmRefusalError(ANTHROPIC_PROVIDER, data.stop_details?.category ?? "policy");
      }

      const text = (data.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
        .trim();

      return {
        text,
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
          // Thinking is billed inside output_tokens and is not reported apart.
          thinkingTokens: 0,
        },
        provider: ANTHROPIC_PROVIDER,
        model: data.model ?? request.model ?? options.model,
        finishReason,
        truncated: finishReason === "max_tokens",
      };
    },
  };
}

async function classify(response: Response): Promise<LlmError> {
  let message = `Anthropic returned ${response.status}.`;
  let type: string | undefined;

  try {
    const parsed = errorSchema.safeParse(JSON.parse(await response.text()));
    if (parsed.success) {
      message = parsed.data.error.message ?? message;
      type = parsed.data.error.type;
    }
  } catch {
    // Non-JSON error body; classify on status alone.
  }

  const options = {
    provider: ANTHROPIC_PROVIDER,
    status: response.status,
    ...(type ? { code: type } : {}),
  };

  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const seconds = header === null ? Number.NaN : Number(header);

    return new LlmError(`Anthropic rate limit reached (${message}).`, {
      ...options,
      retryable: true,
      ...(Number.isFinite(seconds) ? { retryAfterMs: seconds * 1_000 } : {}),
    });
  }

  if (response.status === 401 || response.status === 403) {
    return new LlmError(
      `Anthropic rejected the API key (${message}). Note that a Claude subscription does not include API credits.`,
      { ...options, retryable: false },
    );
  }

  if (response.status === 400 && /credit|billing/i.test(message)) {
    return new LlmError(
      `Anthropic refused the request for billing reasons (${message}). Add credits at console.anthropic.com.`,
      { ...options, retryable: false },
    );
  }

  // 529 is Anthropic's "overloaded" — transient, like a 5xx.
  return new LlmError(message, {
    ...options,
    retryable: response.status >= 500,
  });
}
