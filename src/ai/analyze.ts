import { z } from "zod";
import { LOCALES } from "../i18n/config.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { analyzeReviewPrompt, draftReplyPrompt, MAX_REPLY_CHARS } from "../prompts/index.ts";
import { runAi } from "./client.ts";
import { boundOutput } from "./guardrails.ts";
import { LlmError, type LlmProvider } from "./types.ts";

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
});

export type ReviewAnalysis = z.infer<typeof reviewAnalysisResultSchema>;

/** The provider answers in snake_case; the app speaks camelCase. */
const wireSchema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  sentiment_score: z.number(),
  topics: z.array(z.string()),
  language: z.string(),
});

export type AnalyzeArgs = {
  /** Null for a call with no tenant — see `RunAiArgs` in ./client.ts. */
  organizationId: string | null;
  actorUserId?: string | null;
  text: string;
  rating: number | null;
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
  const prompt = analyzeReviewPrompt({ text: args.text, rating: args.rating });

  const { response, costUsd, listCostUsd } = await runAi({
    organizationId: args.organizationId,
    actorUserId: args.actorUserId ?? null,
    task: "analyze",
    prompt,
    tx: args.tx,
    provider: args.provider,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(response.text));
  } catch {
    throw new LlmError(
      response.truncated
        ? "The analysis was cut off before it produced complete JSON — raise maxOutputTokens."
        : "The analysis was not valid JSON.",
      { provider: response.provider, retryable: false, code: "bad_json" },
    );
  }

  const result = wireSchema.safeParse(parsed);
  if (!result.success) {
    throw new LlmError(
      `The analysis did not match the expected shape: ${result.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
      { provider: response.provider, retryable: false, code: "bad_shape" },
    );
  }

  return {
    promptId: prompt.id,
    analysis: {
      sentiment: result.data.sentiment,
      // Clamp rather than reject: a model returning 1.2 is directionally right
      // and failing the whole analysis over it would be pedantry.
      sentimentScore: Math.max(-1, Math.min(1, result.data.sentiment_score)),
      topics: normalizeTopics(result.data.topics),
      language: normalizeLanguage(result.data.language),
    },
    costUsd,
    listCostUsd,
    model: response.model,
  };
}

export type DraftArgs = {
  /** Null for a call with no tenant — see `RunAiArgs` in ./client.ts. */
  organizationId: string | null;
  actorUserId?: string | null;
  text: string;
  rating: number | null;
  businessName: string;
  brandTone?: string;
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

/** "tr-TR" → "tr"; anything we do not serve is recorded as-is, lower-cased. */
function normalizeLanguage(language: string): string {
  const base = language.trim().toLowerCase().split("-")[0] ?? language;
  return (LOCALES as readonly string[]).includes(base) ? base : base.slice(0, 10);
}
