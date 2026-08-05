import { createHash } from "node:crypto";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from "../types.ts";

/**
 * A deterministic offline provider (P1a-T1).
 *
 * The default `AI_PROVIDER`, which means an unconfigured environment — a CI
 * run, a fresh clone, a forgotten `.env` — cannot spend money or reach a
 * third party. It also makes every downstream test (analysis, digest) able to
 * assert on exact output without a network or a key.
 *
 * Responses are a pure function of the prompt, so the same input always yields
 * the same answer. That is what lets P1a-T7 claim the digest is reproducible.
 */

export const STUB_PROVIDER = "stub";

/** Deterministic pseudo-random in [0,1) derived from the prompt. */
function hashUnit(value: string, salt: string): number {
  const digest = createHash("sha256").update(`${salt}:${value}`).digest();
  return digest.readUInt32BE(0) / 0x1_00_00_00_00;
}

/** Rough token estimate — good enough to exercise usage accounting offline. */
function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export type StubOptions = {
  model?: string;
  /**
   * Forces failures, for testing the retry loop. `failures` responses fail
   * before the first success.
   */
  simulate?: { failures?: number; retryable?: boolean };
};

export function createStubProvider(options: StubOptions = {}): LlmProvider {
  const model = options.model ?? "stub-1";
  let remainingFailures = options.simulate?.failures ?? 0;

  return {
    name: STUB_PROVIDER,
    model,
    // Nothing to rate-limit: the "provider" is a hash function.
    requestsPerMinute: null,

    async complete(request: LlmRequest): Promise<LlmResponse> {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new LlmError("Simulated provider failure.", {
          provider: STUB_PROVIDER,
          retryable: options.simulate?.retryable ?? true,
          status: 503,
        });
      }

      const prompt = request.messages.map((message) => message.text).join("\n");

      // With a schema, answer in that shape so callers can parse offline. The
      // values are derived from the prompt, not random, so tests can pin them.
      const text = request.responseSchema
        ? JSON.stringify(syntheticFor(request.responseSchema, prompt))
        : `Stub reply for prompt digest ${createHash("sha256").update(prompt).digest("hex").slice(0, 12)}.`;

      return {
        text,
        usage: {
          inputTokens: estimateTokens(`${request.system ?? ""}${prompt}`),
          outputTokens: estimateTokens(text),
          thinkingTokens: 0,
        },
        provider: STUB_PROVIDER,
        // Report what actually ran, so a per-task override is visible in the
        // audit row rather than hidden behind the configured default.
        model: request.model ?? model,
        finishReason: "stop",
        truncated: false,
      };
    },
  };
}

/**
 * Picks a synthetic response matching the schema the caller asked for.
 *
 * Keyed on a required property rather than on a prompt id, so a new prompt
 * reusing an existing shape works without touching this file — and a genuinely
 * new shape fails loudly at the caller's validator rather than quietly
 * returning an analysis where a digest was expected.
 */
function syntheticFor(responseSchema: Record<string, unknown>, prompt: string): unknown {
  const properties = (responseSchema.properties ?? {}) as Record<string, unknown>;

  if ("actions" in properties) return syntheticDigest(prompt);
  return syntheticAnalysis(prompt);
}

/**
 * A plausible briefing. The theme labels *and the quote numbers* are lifted out
 * of the prompt's own text, so the actions really do cite themes and reviews
 * that exist — which is what the pipeline's evidence-linking asserts against.
 *
 * The quote citations are not decoration here either (W1.6): the pipeline now
 * rejects and retries any action citing nothing, so a stub that ignored the
 * requirement would exhaust the retries and fail every digest test. A stub that
 * can break the same rules as a real model is the only kind worth having.
 */
function syntheticDigest(prompt: string): Record<string, unknown> {
  const labels = [...prompt.matchAll(/^- ([^:\n]+): \d+ total/gm)]
    .map((match) => match[1]?.trim())
    .filter((label): label is string => Boolean(label));

  // The prompt prints quotes as `[1] (theme) text`. Reading the numbers back
  // rather than assuming 1..n means the stub stays correct if the quote budget
  // per theme changes.
  const quoteNumbers = [...prompt.matchAll(/^\[(\d+)\] \(/gm)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));

  const pick = (index: number) => labels[index % Math.max(1, labels.length)] ?? "other";
  const cite = (index: number) =>
    quoteNumbers.length === 0 ? [1] : [quoteNumbers[index % quoteNumbers.length] ?? 1];

  const levers = ["staffing", "hours", "menu_item", "reply_backlog", "signage", "process"];

  /**
   * Answer in the language that was asked for (W1.6).
   *
   * The pipeline rejects and retries a Turkish briefing that comes back with no
   * Turkish letters in it, which is a real failure of small models and was on
   * the audit's hero screen. A stub that always answered in English would fail
   * that check on every Turkish digest — correctly, which is the point: the
   * stub has to be able to satisfy the same contract a real model does, or the
   * tests are testing the stub's shortcomings.
   */
  const turkish = /^Write in: Turkish\.$/m.test(prompt);

  if (turkish) {
    return {
      headline: "Bu haftanın özeti.",
      summary: "Çevrimdışı üretilmiş, deterministik bir haftalık değerlendirme.",
      callouts: labels.slice(0, 2).map((label) => `Müşteriler ${label} konusundan bahsetti.`),
      actions: [0, 1, 2].map((index) => ({
        text: `${index + 1}. iş: bu hafta ${pick(index)} konusuyla ilgilenin.`,
        theme: pick(index),
        quoteRefs: cite(index),
        lever: levers[index % levers.length],
      })),
    };
  }

  return {
    headline: "Stub briefing for the period.",
    summary: "A deterministic summary produced offline by the stub provider.",
    callouts: labels.slice(0, 2).map((label) => `Customers mentioned ${label}.`),
    actions: [0, 1, 2].map((index) => ({
      text: `Stub action ${index + 1}: address ${pick(index)} this week.`,
      theme: pick(index),
      quoteRefs: cite(index),
      lever: levers[index % levers.length],
    })),
  };
}

/**
 * A plausible analysis derived from the prompt.
 *
 * Sentiment follows the star rating when the prompt mentions one, because
 * downstream tests reasonably expect a 1-star review to read as negative.
 */
function syntheticAnalysis(prompt: string): Record<string, unknown> {
  const ratingMatch = /gave (\d) out of 5 stars/.exec(prompt);
  const rating = ratingMatch ? Number(ratingMatch[1]) : null;

  const sentiment =
    rating === null
      ? hashUnit(prompt, "sentiment") > 0.5
        ? "positive"
        : "neutral"
      : rating >= 4
        ? "positive"
        : rating === 3
          ? "neutral"
          : "negative";

  const score = rating === null ? 0 : Number((((rating - 3) / 2) * 0.9).toFixed(2));

  // Turkish-looking text gets Turkish tags, mirroring the real instruction.
  const turkish = /[çğıöşü]/i.test(prompt);
  const pool = turkish
    ? ["servis", "fiyat", "temizlik", "personel", "bekleme süresi"]
    : ["service", "price", "cleanliness", "staff", "waiting time"];

  const first = Math.floor(hashUnit(prompt, "topic") * pool.length);

  return {
    sentiment,
    sentiment_score: score,
    topics: [pool[first], pool[(first + 2) % pool.length]],
    language: turkish ? "tr" : "en",
  };
}
