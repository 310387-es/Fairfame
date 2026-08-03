/**
 * The provider-agnostic LLM contract (P1a-T1).
 *
 * Everything above this line — analysis, reply drafting, the Action Digest —
 * talks to `LlmProvider` and never to a vendor. That is what lets the project
 * develop against Gemini's free tier today and move to Anthropic at go-live by
 * changing one environment variable, and it is the same reasoning as the
 * `Connector` interface: the expensive, gated dependency sits behind a seam we
 * own.
 *
 * The shape is deliberately the *intersection* of what providers offer, not the
 * union. No streaming, no tool use, no provider-specific knobs — those can be
 * added when a task needs them, whereas a contract shaped around one vendor's
 * feature set stops being swappable the moment the second vendor arrives.
 */

/**
 * What the call is for. Drives model routing, cost attribution and metering —
 * per-review analysis is high volume and can run on a cheap model, while the
 * weekly digest is worth a better one.
 */
export const AI_TASKS = ["analyze", "draft_reply", "digest"] as const;
export type AiTask = (typeof AI_TASKS)[number];

export type LlmMessage = {
  role: "user" | "assistant";
  text: string;
};

export type LlmRequest = {
  /**
   * Instructions. Always ours, never customer content — see ./guardrails.ts
   * for why the two must not mix.
   */
  system?: string;
  messages: LlmMessage[];
  /** Hard ceiling on generated tokens. Required: an unbounded reply is a bill. */
  maxOutputTokens: number;
  /**
   * JSON Schema the response must satisfy. Providers enforce this natively;
   * the caller still validates, because "the provider promised" is not proof.
   */
  responseSchema?: Record<string, unknown>;
  /**
   * Model for this one call, overriding the provider's default.
   *
   * How per-task routing reaches the wire (see `AiTask`). A provider **must**
   * honour it and **must** report the model it actually used in the response,
   * or the audit row records a model that never ran.
   */
  model?: string;
};

export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  /**
   * Reasoning tokens, where the provider reports them separately. Billed but
   * invisible in the output, so a cost report that omits them under-counts.
   */
  thinkingTokens: number;
};

export type LlmResponse = {
  text: string;
  usage: LlmUsage;
  provider: string;
  model: string;
  /** Provider's own completion reason, normalized to lower case. */
  finishReason: string;
  /**
   * True when the provider truncated the output. The caller must not treat a
   * truncated JSON body as a parse failure — it is a budget failure.
   */
  truncated: boolean;
};

export interface LlmProvider {
  readonly name: string;
  /** The model this instance will call. Recorded on every audit row. */
  readonly model: string;
  /**
   * Requests per minute this provider tolerates, or `null` for no ceiling.
   *
   * Batch callers pace themselves against this. Leaving it `undefined` means
   * "use the configured default" — the right answer for a hosted API whose
   * limit depends on the account tier. `null` is for a provider that genuinely
   * has no limit, such as the offline stub: pacing it would add minutes of
   * dead waiting to every test run and offline dev session.
   */
  readonly requestsPerMinute?: number | null;
  complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

/**
 * A provider-side failure, classified for the retry loop.
 *
 * `retryable` is the whole point: a 429 or a socket reset deserves another
 * attempt, while a malformed request or a rejected key will fail identically
 * forever and should surface immediately instead of burning the budget.
 */
export class LlmError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** Provider-specific code, when there is one — for logs, not for control flow. */
  readonly code: string | undefined;
  /** Honour the provider's own backoff hint when it sends one. */
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: {
      provider: string;
      retryable: boolean;
      status?: number | undefined;
      code?: string | undefined;
      retryAfterMs?: number | undefined;
    },
  ) {
    super(message);
    this.name = "LlmError";
    this.provider = options.provider;
    this.retryable = options.retryable;
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * The provider refused to answer on safety grounds.
 *
 * Separated from `LlmError` because it is a *content* outcome, not a fault:
 * retrying the identical prompt produces the identical refusal, and the caller
 * usually wants to record "not analyzable" rather than fail the job.
 */
export class LlmRefusalError extends LlmError {
  readonly reason: string;

  constructor(provider: string, reason: string) {
    super(`The model declined to answer (${reason}).`, {
      provider,
      retryable: false,
      code: "refusal",
    });
    this.name = "LlmRefusalError";
    this.reason = reason;
  }
}
