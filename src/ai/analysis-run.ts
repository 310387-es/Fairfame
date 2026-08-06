import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { refreshPriority } from "../reviews/workflow.ts";
import { getEnv } from "../lib/env.ts";
import { childLogger } from "../lib/logger.ts";
import { createPacer } from "../lib/pacer.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { analyzeReview, type ReviewAnalysis } from "./analyze.ts";
import {
  CONTENT_HASH_LENGTH,
  contentHash,
  getEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings.ts";
import { syncTags, upsertInsight } from "./insights.ts";
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
  analyzed: number;
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

  const pace =
    perMinute > 0
      ? createPacer(perMinute, options.sleep ? { sleep: options.sleep } : {})
      : async (): Promise<void> => {};
  const analyses = new Map<
    string,
    { analysis: ReviewAnalysis; text: string; model: string; promptId: string }
  >();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const target = targets[cursor++];
      if (!target?.text) continue;

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

        result.failed += 1;
        result.failures.push({ reviewId: target.id, reason });
        log.warn(
          { organizationId: options.organizationId, reviewId: target.id, reason },
          "Review analysis failed; continuing",
        );
      }

      options.onProgress?.(result.analyzed + result.failed, targets.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

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

  await withTenant({ organizationId: options.organizationId }, async (tx) => {
    for (const [reviewId, { analysis, text, model, promptId }] of analyses) {
      await upsertInsight(tx, options.organizationId, {
        reviewId,
        sentiment: analysis.sentiment,
        sentimentScore: analysis.sentimentScore,
        topics: analysis.topics,
        themes: analysis.themes,
        staff: analysis.staff,
        language: analysis.language,
        embedding: embeddingsByReview.get(reviewId) ?? null,
        contentHash: contentHash(text),
        // What actually ran, not what we intended to run — the difference
        // matters the moment a fallback or an override is in play.
        promptId,
        model,
      });

      await syncTags(tx, options.organizationId, analysis.topics);
    }

    // Sentiment is the strongest input to triage priority, and until now these
    // rows were scored on their star rating alone — which says nothing at all
    // about a comment or a DM. Re-score them here rather than inside
    // `upsertInsight`, so one analysis batch costs one extra statement instead
    // of one per review.
    await refreshPriority(tx, options.organizationId, [...analyses.keys()]);
  });

  log.info(
    {
      organizationId: options.organizationId,
      analyzed: result.analyzed,
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
