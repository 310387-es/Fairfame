import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { Sentiment } from "../db/schema.ts";
import { refreshPriority } from "../reviews/workflow.ts";
import { getEnv } from "../lib/env.ts";
import { childLogger } from "../lib/logger.ts";
import { createPacer } from "../lib/pacer.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { ANALYZE_PROMPT_ID } from "../prompts/index.ts";
import { analyzeReview, type ReviewAnalysis } from "./analyze.ts";
import {
  CONTENT_HASH_LENGTH,
  contentHash,
  getEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings.ts";
import { findReusableInsights, syncTags, upsertInsight } from "./insights.ts";
import { getLlmProvider } from "./client.ts";
import { LlmRefusalError, type LlmProvider } from "./types.ts";

/**
 * Analyzing a corpus of reviews (P1a-T3).
 *
 * Single-review analysis lives in ./analyze.ts. This is the part that turns it
 * into something you can point at 10,000 rows without melting a free tier:
 * caching, pacing, bounded concurrency, and a recompute path.
 *
 * Three decisions worth stating:
 *
 *   - **The cache key is the text, not the timestamp.** `reviews.updated_at`
 *     moves on every sync whether or not the words changed, so using it would
 *     re-analyze the whole corpus daily. A content hash changes only when the
 *     review does.
 *   - **Pacing is by requests per minute, not concurrency alone.** The free
 *     tier limits requests, not tokens, so three parallel workers hammering
 *     through a backlog trip a 429 within seconds. A shared pacer spaces the
 *     calls out; concurrency only decides how many can be in flight.
 *   - **One bad review does not fail the batch.** A refusal or a malformed
 *     response is recorded and skipped. A backfill over a thousand reviews that
 *     aborts on the first oddity is a backfill that never completes.
 *   - **The cache key is the text, so identical text is one call.** The content
 *     hash was already per *review row*, which meant ten "Harika"s cost ten
 *     calls to be told ten times that "Harika" is positive. `reuseKey` below
 *     decides when two reviews are the same question; a match is copied and
 *     counted as `copied`, never as analysed.
 */

const log = childLogger({ module: "ai/analysis-run" });

export type AnalysisTarget = {
  id: string;
  text: string | null;
  rating: number | null;
  /** The location's vertical — narrows the canonical themes offered (W3.2). */
  category?: string | null;
};

export type BatchOptions = {
  organizationId: string;
  actorUserId?: string | null;
  /** Ignore the cache and re-analyze everything in scope. */
  recompute?: boolean;
  /** Limit to one location. */
  locationId?: string | undefined;
  /**
   * Limit to reviews posted in a window (W5-14).
   *
   * Added for the first briefing, which is about **one week** and therefore has
   * no reason to wait on a two-hundred-review backfill before it can be
   * composed. Analysing the window and its predecessor is what the digest
   * actually reads; the sweep fills in the rest afterwards, when nobody is
   * watching a progress bar.
   *
   * Both bounds optional and both half-open the usual way: `from` inclusive,
   * `to` exclusive, matching `weekWindow`.
   */
  postedFrom?: Date | undefined;
  postedTo?: Date | undefined;
  /** Cap the batch. */
  limit?: number;
  /** Also compute and store embeddings. */
  withEmbeddings?: boolean;
  provider?: LlmProvider | undefined;
  embeddings?: EmbeddingProvider | undefined;
  requestsPerMinute?: number | undefined;
  concurrency?: number | undefined;
  /** Progress callback, for the CLI. */
  onProgress?: ((done: number, total: number) => void) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
};

export type BatchResult = {
  /** Reviews the model was actually asked about. */
  analyzed: number;
  /**
   * Reviews written from an identical analysis instead of a model call.
   *
   * Reported rather than folded into `analyzed`, because the two numbers answer
   * different questions — what a run cost, and what it saved. A saving nobody
   * is shown is indistinguishable from a bug that skipped work.
   */
  copied: number;
  /** Reviews in scope that were already analysed — the cache hits. */
  skipped: number;
  failed: number;
  embedded: number;
  /** What the run is billed. Zero on a free tier. */
  costUsd: number;
  /** What it would be billed at published rates — the number to plan with. */
  listCostUsd: number;
  failures: { reviewId: string; reason: string }[];
};

/** Reviews in scope, ignoring the cache — the denominator for cache reporting. */
async function countInScope(tx: TenantDatabase, options: BatchOptions): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.reviews)
    .where(scopeOf(options));

  return row?.total ?? 0;
}

function scopeOf(options: BatchOptions) {
  return and(
    eq(schema.reviews.organizationId, options.organizationId),
    options.locationId ? eq(schema.reviews.locationId, options.locationId) : undefined,
    options.postedFrom ? gte(schema.reviews.postedAt, options.postedFrom) : undefined,
    options.postedTo ? lt(schema.reviews.postedAt, options.postedTo) : undefined,
    // A rating-only review has nothing to analyze.
    sql`${schema.reviews.text} is not null and length(trim(${schema.reviews.text})) > 0`,
  );
}

/** Reviews in scope, honouring the cache unless recomputing. */
export async function selectTargets(
  tx: TenantDatabase,
  options: BatchOptions,
): Promise<AnalysisTarget[]> {
  const { recompute = false, limit = 500 } = options;

  const scope = scopeOf(options);

  if (recompute) {
    return tx
      .select({
        id: schema.reviews.id,
        text: schema.reviews.text,
        rating: schema.reviews.rating,
        // The business's vertical, which narrows the canonical themes offered
        // to the model (W3.2). Joined rather than looked up per review: a batch
        // of five hundred would otherwise be five hundred extra queries.
        category: schema.locations.category,
      })
      .from(schema.reviews)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.reviews.locationId))
      .where(scope)
      .limit(limit);
  }

  // Stale means: never analyzed, or analyzed against different text. The hash
  // comparison is what makes a re-run after an edited review do the right
  // thing without re-analyzing everything else.
  return tx
    .select({
      id: schema.reviews.id,
      text: schema.reviews.text,
      rating: schema.reviews.rating,
      category: schema.locations.category,
    })
    .from(schema.reviews)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.reviews.locationId))
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .where(
      and(
        scope,
        or(
          isNull(schema.reviewInsights.id),
          isNull(schema.reviewInsights.contentHash),
          // `left(..., 32)` mirrors contentHash() in ./embeddings.ts. If the two
          // ever disagree on length, every review reads as stale and the batch
          // silently re-analyzes the whole corpus on every run.
          sql`${schema.reviewInsights.contentHash} <> left(encode(sha256(convert_to(${schema.reviews.text}, 'UTF8')), 'hex'), ${CONTENT_HASH_LENGTH})`,
        ),
      ),
    )
    .limit(limit);
}

/**
 * When two reviews are the same question, and may therefore share one answer.
 *
 * The one definition of it: the in-memory grouping of a batch and the lookup of
 * an already-stored analysis both key on this, so a donor the database offered
 * and a duplicate found inside the batch can never be judged by different rules.
 *
 * The text, because that is what the model reads — and the vertical, because
 * `analyzeReviewPrompt` narrows the canonical themes to `locations.category`
 * (W3.2). "Harika" at a hotel was offered `room_comfort`; at a barber it was
 * not. Same words, different closed list, different answer. A null category is
 * itself a value here — the universal theme set is a real vertical, and every
 * location that has never set one shares it.
 *
 * Organization is deliberately *not* part of the key: it is not a narrower
 * match, it is a wall. Nothing may reach across it, so it is a filter on the
 * query rather than a component of a string that could be got wrong.
 */
function reuseKey(hash: string, category: string | null | undefined): string {
  return `${hash} ${category ?? ""}`;
}

/** A target with its cache key resolved once, rather than per comparison. */
type KeyedTarget = AnalysisTarget & { text: string; hash: string; key: string };

function keyedTarget(target: AnalysisTarget, text: string): KeyedTarget {
  const hash = contentHash(text);
  return { ...target, text, hash, key: reuseKey(hash, target.category) };
}

/** What gets written to `review_insights`, whether the model or a copy produced it. */
type InsightWrite = {
  sentiment: Sentiment;
  sentimentScore: number;
  topics: string[];
  /** Null stays null: it means "analysed before the taxonomy", not "no theme fits". */
  themes: string[] | null;
  staff: string[];
  language: string | null;
  text: string;
  model: string;
  promptId: string;
  embedding: number[] | null;
  copied: boolean;
};

/**
 * Analyzes every review in scope and persists the insights.
 *
 * Returns counts rather than throwing on individual failures — see the module
 * comment on why a batch must survive a bad row.
 */
export async function analyzeBatch(options: BatchOptions): Promise<BatchResult> {
  const env = getEnv();
  // Resolved once for the batch, on the analyze task's model.
  const provider = options.provider ?? getLlmProvider("analyze");
  const concurrency = options.concurrency ?? env.AI_BATCH_CONCURRENCY;

  // A provider that declares no ceiling is not paced at all. Applying the
  // configured rate to the offline stub would spend five seconds per review
  // waiting for a hash function.
  const perMinute =
    options.requestsPerMinute ??
    (provider.requestsPerMinute === null
      ? 0
      : (provider.requestsPerMinute ?? env.AI_REQUESTS_PER_MINUTE));

  const { targets, inScope } = await withTenant(
    { organizationId: options.organizationId },
    async (tx) => ({
      targets: await selectTargets(tx, options),
      inScope: await countInScope(tx, options),
    }),
  );

  const result: BatchResult = {
    analyzed: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
    embedded: 0,
    costUsd: 0,
    listCostUsd: 0,
    failures: [],
  };

  // Everything in scope that we are not about to analyze was a cache hit.
  result.skipped = Math.max(0, inScope - targets.length);

  if (targets.length === 0) return result;

  const keyed: KeyedTarget[] = targets.flatMap((target) =>
    target.text ? [keyedTarget(target, target.text)] : [],
  );

  // Reviews saying the same thing, gathered before anything is sent. Insertion
  // order decides which one the model is asked about; the rest copy its answer.
  const groups = new Map<string, KeyedTarget[]>();
  for (const target of keyed) {
    const group = groups.get(target.key);
    if (group) group.push(target);
    else groups.set(target.key, [target]);
  }

  /*
    An analysis already stored in *this* organization that answers the same
    question. Looked up once for the whole batch rather than per review, and
    excluding the batch's own rows — see `findReusableInsights` for why each
    condition is there, and why organization is a filter rather than a key.
  */
  const donors = await withTenant({ organizationId: options.organizationId }, (tx) =>
    findReusableInsights(tx, options.organizationId, {
      contentHashes: [...new Set(keyed.map((target) => target.hash))],
      promptId: ANALYZE_PROMPT_ID,
      excludeReviewIds: keyed.map((target) => target.id),
    }),
  );

  const donorByKey = new Map(
    donors.map((donor) => [reuseKey(donor.contentHash, donor.category), donor]),
  );

  // One representative per group with no donor. This array — not `targets` — is
  // what the model is asked about, and it is the whole saving.
  const toAnalyze = [...groups.values()].flatMap((group) =>
    group[0] && !donorByKey.has(group[0].key) ? [group[0]] : [],
  );

  const pace =
    perMinute > 0
      ? createPacer(perMinute, options.sleep ? { sleep: options.sleep } : {})
      : async (): Promise<void> => {};
  const analyses = new Map<
    string,
    { analysis: ReviewAnalysis; text: string; model: string; promptId: string }
  >();
  /** Why a group produced nothing, so its duplicates can say so too. */
  const groupFailures = new Map<string, string>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < toAnalyze.length) {
      const target = toAnalyze[cursor++];
      if (!target) continue;

      await pace();

      try {
        const { analysis, costUsd, listCostUsd, model, promptId } = await analyzeReview({
          organizationId: options.organizationId,
          actorUserId: options.actorUserId ?? null,
          text: target.text,
          rating: target.rating,
          category: target.category,
          provider,
        });

        analyses.set(target.id, { analysis, text: target.text, model, promptId });
        result.costUsd += costUsd;
        result.listCostUsd += listCostUsd;
        result.analyzed += 1;
      } catch (error) {
        // A refusal is a content outcome, not an outage: the review stays
        // unanalyzed and the run continues.
        const reason =
          error instanceof LlmRefusalError
            ? `refused (${error.reason})`
            : error instanceof Error
              ? error.message
              : "unknown error";

        groupFailures.set(target.key, reason);
        result.failed += 1;
        result.failures.push({ reviewId: target.id, reason });
        log.warn(
          { organizationId: options.organizationId, reviewId: target.id, reason },
          "Review analysis failed; continuing",
        );
      }

      options.onProgress?.(result.analyzed + result.failed, toAnalyze.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, toAnalyze.length) }, worker));

  // Embeddings are batched separately: one request covers many reviews, so
  // interleaving them with per-review analysis would waste the batch endpoint.
  const embeddingsByReview = new Map<string, number[]>();
  if (options.withEmbeddings && analyses.size > 0) {
    const provider = options.embeddings ?? getEmbeddingProvider();
    const entries = [...analyses.entries()];

    try {
      await pace();
      const vectors = await provider.embed(entries.map(([, value]) => value.text));
      entries.forEach(([reviewId], index) => {
        const vector = vectors[index];
        if (vector) embeddingsByReview.set(reviewId, vector);
      });
      result.embedded = embeddingsByReview.size;
    } catch (error) {
      // Embeddings are an enhancement; losing them must not cost the analysis.
      log.warn(
        { organizationId: options.organizationId, err: error },
        "Embedding pass failed; insights will be stored without vectors",
      );
    }
  }

  /*
    Every row to be written, model-produced and copied alike, resolved before a
    single statement runs.

    A copy carries the *source* row's `promptId` and `model`, because those name
    what produced the words. Writing this run's configured model onto a copied
    row would put a model in the audit trail that was never asked about this
    review — and `audit_logs`, which records calls, would disagree with it.
  */
  const writes = new Map<string, InsightWrite>();

  for (const [key, group] of groups) {
    const representative = group[0];
    if (!representative) continue;

    const donor = donorByKey.get(key);
    const analysed = analyses.get(representative.id);

    for (const target of group) {
      if (donor) {
        writes.set(target.id, {
          sentiment: donor.sentiment,
          sentimentScore: donor.sentimentScore,
          topics: donor.topics,
          themes: donor.themes,
          staff: donor.staff,
          language: donor.language,
          text: target.text,
          model: donor.model,
          promptId: donor.promptId,
          // Identical text embeds identically, so the vector comes free — and
          // it is copied whether or not this run asked for embeddings, because
          // copying costs nothing and withholding it would leave a duplicate
          // out of the similarity search its twin is in.
          embedding: donor.embedding,
          copied: true,
        });
        continue;
      }

      if (analysed) {
        writes.set(target.id, {
          sentiment: analysed.analysis.sentiment,
          sentimentScore: analysed.analysis.sentimentScore,
          topics: analysed.analysis.topics,
          themes: analysed.analysis.themes,
          staff: analysed.analysis.staff,
          language: analysed.analysis.language,
          text: target.text,
          model: analysed.model,
          promptId: analysed.promptId,
          // The representative's vector, where the embedding pass produced one.
          embedding: embeddingsByReview.get(representative.id) ?? null,
          copied: target.id !== representative.id,
        });
        continue;
      }

      // The one call this group had failed. Its duplicates are reported rather
      // than dropped: they are still unanalysed, they are still stale, and the
      // next run will try them again.
      if (target.id !== representative.id) {
        result.failed += 1;
        result.failures.push({
          reviewId: target.id,
          reason: `identical to ${representative.id}: ${groupFailures.get(key) ?? "unknown error"}`,
        });
      }
    }
  }

  result.copied = [...writes.values()].filter((write) => write.copied).length;

  await withTenant({ organizationId: options.organizationId }, async (tx) => {
    for (const [reviewId, write] of writes) {
      await upsertInsight(tx, options.organizationId, {
        reviewId,
        sentiment: write.sentiment,
        sentimentScore: write.sentimentScore,
        topics: write.topics,
        // Undefined rather than null, which is what `upsertInsight` reads as
        // "the caller has none to offer" — a donor analysed before the taxonomy
        // must not overwrite a row that already has themes.
        ...(write.themes ? { themes: write.themes } : {}),
        staff: write.staff,
        language: write.language,
        embedding: write.embedding,
        contentHash: contentHash(write.text),
        // What actually ran, not what we intended to run — the difference
        // matters the moment a fallback or an override is in play.
        promptId: write.promptId,
        model: write.model,
      });

      await syncTags(tx, options.organizationId, write.topics);
    }

    // Sentiment is the strongest input to triage priority, and until now these
    // rows were scored on their star rating alone — which says nothing at all
    // about a comment or a DM. Re-score them here rather than inside
    // `upsertInsight`, so one analysis batch costs one extra statement instead
    // of one per review. Copied rows are in this list for the same reason the
    // analysed ones are: they now carry a sentiment they did not have.
    await refreshPriority(tx, options.organizationId, [...writes.keys()]);
  });

  log.info(
    {
      organizationId: options.organizationId,
      analyzed: result.analyzed,
      // The calls this batch did not have to make. Logged beside the ones it
      // did, because a saving nobody can see reads exactly like work skipped by
      // mistake — and this one is invisible in the bill by design.
      copied: result.copied,
      skipped: result.skipped,
      failed: result.failed,
      embedded: result.embedded,
      costUsd: Number(result.costUsd.toFixed(6)),
      listCostUsd: Number(result.listCostUsd.toFixed(6)),
    },
    "Batch analysis complete",
  );

  return result;
}

/** Backfills embeddings for insights that have analysis but no vector. */
export async function embedMissing(options: {
  organizationId: string;
  limit?: number;
  embeddings?: EmbeddingProvider | undefined;
}): Promise<number> {
  const provider = options.embeddings ?? getEmbeddingProvider();

  const pending = await withTenant({ organizationId: options.organizationId }, (tx) =>
    tx
      .select({ reviewId: schema.reviewInsights.reviewId, text: schema.reviews.text })
      .from(schema.reviewInsights)
      .innerJoin(schema.reviews, eq(schema.reviews.id, schema.reviewInsights.reviewId))
      .where(
        and(
          eq(schema.reviewInsights.organizationId, options.organizationId),
          isNull(schema.reviewInsights.embedding),
          sql`${schema.reviews.text} is not null`,
        ),
      )
      .limit(options.limit ?? 200),
  );

  if (pending.length === 0) return 0;

  const vectors = await provider.embed(pending.map((row) => row.text ?? ""));

  await withTenant({ organizationId: options.organizationId }, async (tx) => {
    for (const [index, row] of pending.entries()) {
      const vector = vectors[index];
      if (!vector) continue;

      await tx
        .update(schema.reviewInsights)
        .set({ embedding: vector, updatedAt: new Date() })
        .where(
          and(
            eq(schema.reviewInsights.organizationId, options.organizationId),
            eq(schema.reviewInsights.reviewId, row.reviewId),
          ),
        );
    }
  });

  return pending.length;
}

/** Drops analyses so the next run recomputes them. Used by the recompute path. */
export async function clearInsights(organizationId: string, reviewIds?: string[]): Promise<number> {
  return withTenant({ organizationId }, async (tx) => {
    const rows = await tx
      .delete(schema.reviewInsights)
      .where(
        and(
          eq(schema.reviewInsights.organizationId, organizationId),
          reviewIds?.length ? inArray(schema.reviewInsights.reviewId, reviewIds) : undefined,
        ),
      )
      .returning({ id: schema.reviewInsights.id });

    return rows.length;
  });
}
