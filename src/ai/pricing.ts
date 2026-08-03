import type { LlmUsage } from "./types.ts";

/**
 * What a call cost (P1a-T1).
 *
 * `docs/03` §6 asks for cost control, and you cannot control what you do not
 * measure. Every completion logs an estimated cost so that "the AI bill" is a
 * number per organization and per task rather than a surprise at month end.
 *
 * Rates are USD per million tokens and are **hard-coded on purpose**: they are
 * a snapshot that must be reviewed, not a live feed. Reading them from the
 * provider at runtime would make an outage silently produce free-looking calls.
 * A model that is not listed reports zero cost and is logged as unpriced —
 * visible, rather than quietly wrong.
 *
 * Snapshot taken 2 Aug 2026.
 */

export type ModelRate = {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** Free-tier models cost nothing but still consume quota. */
  free?: boolean;
};

export const MODEL_RATES: Record<string, ModelRate> = {
  // Google — development provider. Free tier is rate-limited, not unlimited;
  // the paid rates are what these become the moment billing is enabled.
  "gemini-3.5-flash-lite": { input: 0.1, output: 0.4, free: true },
  "gemini-3.6-flash": { input: 0.3, output: 2.5, free: true },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, free: true },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, free: true },

  // Anthropic — production path.
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export type CostEstimate = {
  /** USD actually charged. Zero for free-tier models and for unpriced ones. */
  usd: number;
  /**
   * USD the same call would cost at published rates, ignoring the free tier.
   *
   * Reported separately because "$0.00" is true on a free tier and useless for
   * planning: the question before enabling billing is what the workload costs,
   * and a backfill that reads as free gives no answer. Zero here means the
   * model genuinely has no rate, not that the call was free.
   */
  listUsd: number;
  /** False when the model is absent from the table — the number is not a price. */
  priced: boolean;
  free: boolean;
};

/**
 * Estimates the cost of one completion.
 *
 * Thinking tokens are billed as output wherever a provider reports them
 * separately, so they are added to the output side rather than ignored — the
 * most common way an AI cost report ends up understating reality.
 */
export function estimateCost(model: string, usage: LlmUsage): CostEstimate {
  const rate = MODEL_RATES[model];
  if (!rate) return { usd: 0, listUsd: 0, priced: false, free: false };

  const billedOutput = usage.outputTokens + usage.thinkingTokens;
  const usd = (usage.inputTokens * rate.input + billedOutput * rate.output) / 1_000_000;

  return {
    usd: rate.free ? 0 : Number(usd.toFixed(6)),
    listUsd: Number(usd.toFixed(6)),
    priced: true,
    free: rate.free === true,
  };
}
