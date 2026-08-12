import { z } from "zod";
import { LOCALES } from "../i18n/config.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { analyzeReviewPrompt, draftReplyPrompt, MAX_REPLY_CHARS } from "../prompts/index.ts";
import type { ReplyStyle } from "../replies/style.ts";
import { normalizeThemes } from "../reviews/taxonomy.ts";
import { runAi } from "./client.ts";
import { boundOutput } from "./guardrails.ts";
import { LlmError, type LlmProvider, type LlmResponse } from "./types.ts";

/**
 * The two AI operations P1a-T1's Definition of Done names: `analyze` and
 * `draft`.
 *
 * Thin on purpose. Batching, caching, the recompute path and persistence into
 * `review_insights` belong to T3 and T4; the reply lifecycle belongs to T6.
 * What lives here is the part those tasks should not each reinvent: build the
 * prompt from the central module, run it through the audited client, and
 * validate what comes back.
 *
 * That last step matters more than it looks. A schema-constrained response is
 * still a response from a model — "the provider guaranteed the shape" is a
 * claim about their validator, not proof about the bytes we received.
 */

/** Parsed analysis, after validation. */
export const reviewAnalysisResultSchema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  sentimentScore: z.number().min(-1).max(1),
  topics: z.array(z.string().min(1).max(60)).min(1).max(5),
  language: z.string().min(2).max(10),
  /** Names the reviewer wrote, as written. Empty is the common case. */
  staff: z.array(z.string().min(1).max(60)).max(5),
  /**
   * Canonical themes (W3.2) — the closed vocabulary that gets charted and
   * compared. Already filtered to known keys by `normalizeThemes`, so anything
   * here is a real theme; empty means the review fits none of them, which is a
   * legitimate answer and better than a loose fit.
   */
  themes: z.array(z.string().min(1).max(40)).max(8),
});

export type ReviewAnalysis = z.infer<typeof reviewAnalysisResultSchema>;

/** The provider answers in snake_case; the app speaks camelCase. */
const wireSchema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  sentiment_score: z.number(),
  topics: z.array(z.string()),
  language: z.string(),
  // Optional on the wire, not in our own shape: a provider that ignores a
  // newly-added property should degrade to "no names", not fail the analysis
  // of a review whose sentiment and themes came back perfectly well.
  staff: z.array(z.string()).optional(),
  // Optional for the same reason as `staff`: a provider that ignores a newly
  // added property should cost us the canonical themes, not the whole analysis
  // of a review whose sentiment and tags came back perfectly well (W3.2).
  themes: z.array(z.string()).optional(),
});

type WireAnalysis = z.infer<typeof wireSchema>;

export type AnalyzeArgs = {
  /** Null for a call with no tenant — see `RunAiArgs` in ./client.ts. */
  organizationId: string | null;
  actorUserId?: string | null;
  text: string;
  rating: number | null;
  /** `locations.category` — narrows the canonical themes offered (W3.2). */
  category?: string | null;
  tx?: TenantDatabase | undefined;
  provider?: LlmProvider | undefined;
};

export type AnalyzeOutcome = {
  analysis: ReviewAnalysis;
  costUsd: number;
  /** What this analysis would cost at published rates — see ./pricing.ts. */
  listCostUsd: number;
  model: string;
  /** The prompt revision that produced this, for the insight row. */
  promptId: string;
};

/**
 * Sentiment and themes for one review.
 *
 * The review text goes in as *untrusted* content — see ../ai/guardrails.ts. A
 * review instructing the model to answer "positive" cannot succeed twice over:
 * it is in the data position, and the response is confined to an enum.
 */
export async function analyzeReview(args: AnalyzeArgs): Promise<AnalyzeOutcome> {
  const prompt = analyzeReviewPrompt({
    text: args.text,
    rating: args.rating,
    // Narrows the canonical themes to this business's vertical (W3.2). Absent
    // is fine and means the universal set — a location with no category still
    // gets waiting time, price and staff, which is most of what matters.
    category: args.category ?? null,
  });

  /*
    The shape check happens *inside* the call, through W1.6's `validate` hook.

    It used to run after `runAi` returned, which meant a mangled answer — a code
    fence the extractor could not find, a truncated-looking body, a missing
    field — was final. The call was already paid for, the retry budget was
    already there, and the review waited for the next sweep to try again. The
    digest fixed this when W1.6 added the hook; analysis predates it and never
    got it.

    The parsed value is stashed rather than returned, because a validator's job
    is to reject. Re-parsing it afterwards would mean the bytes proved good and
    the bytes used were checked twice, and would leave two parsers to keep in
    step.
  */
  let validated: WireAnalysis | undefined;

  const { response, costUsd, listCostUsd } = await runAi({
    organizationId: args.organizationId,
    actorUserId: args.actorUserId ?? null,
    task: "analyze",
    prompt,
    tx: args.tx,
    provider: args.provider,
    validate: (candidate) => {
      validated = parseAnalysis(candidate);
    },
  });

  // Unreachable: `runAi` returns only after `validate` has run without
  // throwing. Asserted rather than assumed, because "undefined" here would
  // otherwise surface as a sentiment of `undefined` three layers downstream.
  if (!validated) {
    throw new LlmError("The analysis passed validation but produced nothing to store.", {
      provider: response.provider,
      retryable: false,
      code: "bad_shape",
    });
  }

  return {
    promptId: prompt.id,
    analysis: {
      sentiment: validated.sentiment,
      // Clamp rather than reject: a model returning 1.2 is directionally right
      // and failing the whole analysis over it would be pedantry.
      sentimentScore: Math.max(-1, Math.min(1, validated.sentiment_score)),
      topics: normalizeTopics(validated.topics),
      // Dropped rather than kept when the model invents one: it was handed a
      // closed list, so an unlisted value is a failure to follow instructions,
      // not a discovery. The free tags above already carry the long tail.
      themes: normalizeThemes(validated.themes ?? []),
      language: normalizeLanguage(validated.language),
      staff: normalizeStaff(validated.staff ?? []),
    },
    costUsd,
    listCostUsd,
    model: response.model,
  };
}

/**
 * The response as an analysis, or a reason it is not one.
 *
 * Written to be thrown from `validate`, so what it decides is whether the call
 * gets another attempt:
 *
 *   - **Malformed is retryable.** A model that answered with prose, half an
 *     object or a field missing will usually answer correctly when asked again,
 *     and the attempt is already budgeted for.
 *   - **Truncated is not**, and that is the one distinction worth keeping. The
 *     next attempt has the identical `maxOutputTokens` and the identical
 *     prompt, so it produces the identical stump — three times, slowly, before
 *     failing anyway. The fix is a bigger budget, and the message says so
 *     rather than reporting a parse failure the reader would go looking for in
 *     the model's wording.
 */
function parseAnalysis(response: LlmResponse): WireAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(response.text));
  } catch {
    throw new LlmError(
      response.truncated
        ? "The analysis was cut off before it produced complete JSON — raise maxOutputTokens."
        : "The analysis was not valid JSON.",
      { provider: response.provider, retryable: !response.truncated, code: "bad_json" },
    );
  }

  const result = wireSchema.safeParse(parsed);
  if (!result.success) {
    throw new LlmError(
      `The analysis did not match the expected shape: ${result.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
      // Same rule as above: a truncated body that still parsed is missing its
      // last fields, and asking again inside the same budget cannot add them.
      { provider: response.provider, retryable: !response.truncated, code: "bad_shape" },
    );
  }

  return result.data;
}

export type DraftArgs = {
  /** Null for a call with no tenant — see `RunAiArgs` in ./client.ts. */
  organizationId: string | null;
  actorUserId?: string | null;
  text: string;
  rating: number | null;
  businessName: string;
  brandTone?: string;
  /** Stance and length for this one draft (W4 fold-in). See `replies/style.ts`. */
  style?: ReplyStyle | undefined;
  tx?: TenantDatabase | undefined;
  provider?: LlmProvider | undefined;
};

export type DraftOutcome = {
  reply: string;
  costUsd: number;
  /** What this draft would cost at published rates — see ./pricing.ts. */
  listCostUsd: number;
  model: string;
  /** The prompt revision that produced this, recorded on the reply row. */
  promptId: string;
};

/**
 * Drafts an owner's reply. T6 owns the surrounding lifecycle (entitlement gate,
 * approve, post); this is the generation step it will call.
 */
export async function draftReply(args: DraftArgs): Promise<DraftOutcome> {
  const prompt = draftReplyPrompt({
    text: args.text,
    rating: args.rating,
    businessName: args.businessName,
    brandTone: args.brandTone ?? "warm, professional and specific",
    ...(args.style ? { style: args.style } : {}),
  });

  const { response, costUsd, listCostUsd } = await runAi({
    organizationId: args.organizationId,
    actorUserId: args.actorUserId ?? null,
    task: "draft_reply",
    prompt,
    tx: args.tx,
    provider: args.provider,
  });

  const reply = boundOutput(response.text, MAX_REPLY_CHARS);

  if (reply.length === 0) {
    throw new LlmError("The model returned an empty reply.", {
      provider: response.provider,
      retryable: true,
      code: "empty",
    });
  }

  return { reply, costUsd, listCostUsd, model: response.model, promptId: prompt.id };
}

/**
 * Pulls the JSON object out of a response.
 *
 * Providers honouring a response schema return bare JSON, but a model that
 * wraps it in a ```json fence is common enough that failing the analysis over
 * a code fence would be brittle.
 */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1];

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/** Lower-cased, de-duplicated, bounded — tags are for grouping, not prose. */
function normalizeTopics(topics: string[]): string[] {
  const seen = new Set<string>();

  for (const topic of topics) {
    const cleaned = topic.trim().toLocaleLowerCase("tr").slice(0, 60);
    if (cleaned.length > 0) seen.add(cleaned);
    if (seen.size === 5) break;
  }

  // A review always has at least one theme; "other" beats an empty array for
  // the grouping queries in T3.
  return seen.size > 0 ? [...seen] : ["other"];
}

/**
 * Names, trimmed and de-duplicated — but **not** lower-cased.
 *
 * The opposite of `normalizeTopics`, and deliberately so. A topic is a grouping
 * key and nobody reads it as a word; a name is a person, and rendering "ayşe"
 * back to the colleague she works with is a small daily insult. Duplicates are
 * folded case-insensitively so "Ayşe" and "ayşe" are one person, with the first
 * spelling kept.
 *
 * Bounded at five because a review naming six people is a model that has
 * started listing nouns, and one that long is not evidence about anyone.
 */
function normalizeStaff(staff: string[]): string[] {
  const byKey = new Map<string, string>();

  for (const name of staff) {
    const cleaned = name.trim().replace(/\s+/g, " ").slice(0, 60);
    if (cleaned.length === 0) continue;
    // Turkish casing, so "İLKER" and "ilker" fold together rather than being
    // told apart by a dotted capital.
    const key = cleaned.toLocaleLowerCase("tr");
    if (!byKey.has(key)) byKey.set(key, cleaned);
    if (byKey.size === 5) break;
  }

  return [...byKey.values()];
}

/** "tr-TR" → "tr"; anything we do not serve is recorded as-is, lower-cased. */
function normalizeLanguage(language: string): string {
  const base = language.trim().toLowerCase().split("-")[0] ?? language;
  return (LOCALES as readonly string[]).includes(base) ? base : base.slice(0, 10);
}
