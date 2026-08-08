import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { analyzeBatch } from "../../ai/analysis-run.ts";
import { CONTENT_HASH_LENGTH } from "../../ai/embeddings.ts";
import { getAdminDb, schema } from "../../db/client.ts";
import { recordUsage, withinLimit } from "../../lib/entitlements.ts";
import { scanForDuplicates } from "../../reviews/duplicates.ts";
import { childLogger } from "../../lib/logger.ts";
import { enqueueAnalyze, enqueueNotify, type ReviewJob } from "../queue.ts";

/**
 * The analysis worker (P1a-T4).
 *
 * `analyze_sweep` finds organizations with reviews that lack fresh insights and
 * enqueues one `analyze` job each. `analyze` runs the batch for a single
 * organization inside its own tenant context.
 *
 * Like the connection scan, the sweep is the one legitimate cross-tenant read:
 * a scheduler has no session and therefore no organization. It reads only
 * organization ids and a pending count — enough to dispatch, and nothing that
 * could put one tenant's review text anywhere near another's job.
 *
 * Two decisions carry most of the weight here:
 *
 *   - **A run drains, then re-enqueues itself.** One job analyzes at most
 *     `BATCH_SIZE` reviews so a large backlog cannot hold a worker slot for an
 *     hour, and asks for another job if work remains. That also closes the race
 *     where reviews arrive while a run is active.
 *   - **The monthly plan limit is enforced here, not inside the batch.** This
 *     is the only place analysis happens without a human asking for it, so it
 *     is the only place that can silently spend a tenant's entire allowance.
 */

const log = childLogger({ module: "jobs/analyze-reviews" });

/** Reviews per job. Small enough to yield the worker, large enough to progress. */
const BATCH_SIZE = 50;

/** Organizations dispatched per sweep. */
const SWEEP_LIMIT = 100;

export type AnalyzeSweepResult = { organizations: number };

/**
 * Finds organizations with unanalyzed reviews and enqueues a job for each.
 *
 * The staleness predicate mirrors `selectTargets` in ../../ai/analysis-run.ts:
 * no insight, no content hash, or a hash that no longer matches the text.
 * Duplicating it is deliberate — this query must run across tenants, which
 * `selectTargets` cannot do — but the two must be changed together.
 */
export async function runAnalyzeSweep(queue: Queue<ReviewJob>): Promise<AnalyzeSweepResult> {
  const rows = await getAdminDb()
    .select({
      organizationId: schema.reviews.organizationId,
      pending: sql<number>`count(*)::int`.mapWith(Number),
    })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .where(
      and(
        sql`${schema.reviews.text} is not null and length(trim(${schema.reviews.text})) > 0`,
        or(
          isNull(schema.reviewInsights.id),
          isNull(schema.reviewInsights.contentHash),
          sql`${schema.reviewInsights.contentHash} <> left(encode(sha256(convert_to(${schema.reviews.text}, 'UTF8')), 'hex'), ${CONTENT_HASH_LENGTH})`,
        ),
      ),
    )
    .groupBy(schema.reviews.organizationId)
    .limit(SWEEP_LIMIT);

  for (const row of rows) {
    await enqueueAnalyze(queue, { organizationId: row.organizationId });
  }

  if (rows.length > 0) {
    log.info(
      {
        organizations: rows.length,
        pending: rows.reduce((sum, row) => sum + row.pending, 0),
      },
      "Analysis sweep dispatched",
    );
  }

  return { organizations: rows.length };
}

export type AnalyzeJobResult = {
  organizationId: string;
  analyzed: number;
  failed: number;
  embedded: number;
  /** Set when nothing ran. `limit_reached` is a plan ceiling, not an error. */
  skipped?: "limit_reached";
  /** True when another job was queued because work remains. */
  continued: boolean;
};

export async function runAnalyze(
  job: Job<ReviewJob>,
  queue: Queue<ReviewJob>,
): Promise<AnalyzeJobResult> {
  if (job.data.kind !== "analyze") {
    throw new UnrecoverableError("runAnalyze received a non-analyze job.");
  }

  const { organizationId, recompute } = job.data;

  // `additional: 0` asks what is left rather than reserving anything — the
  // batch may analyze fewer reviews than it is allowed to, and charging for
  // work that did not happen is worse than not charging at all.
  const budget = await withinLimit(organizationId, "ai_analyses_per_month", { additional: 0 });

  if (budget.remaining !== null && budget.remaining <= 0) {
    // Not a failure and not retryable: the ceiling lifts when the billing
    // period rolls over or the plan changes, neither of which a retry affects.
    log.info(
      { organizationId, limit: budget.limit, current: budget.current },
      "Analysis skipped: monthly plan limit reached",
    );

    return {
      organizationId,
      analyzed: 0,
      failed: 0,
      embedded: 0,
      skipped: "limit_reached",
      continued: false,
    };
  }

  const allowance = budget.remaining === null ? BATCH_SIZE : Math.min(BATCH_SIZE, budget.remaining);

  const result = await analyzeBatch({
    organizationId,
    limit: allowance,
    withEmbeddings: true,
    ...(recompute ? { recompute: true } : {}),
  });

  // Metered after the fact, by what was actually analyzed. A failed call cost
  // tokens (already metered separately as `ai_tokens`) but produced no
  // analysis, so it must not consume the tenant's analysis allowance.
  if (result.analyzed > 0) {
    await recordUsage(organizationId, "ai_analyses_per_month", result.analyzed);
  }

  /*
    Duplicate detection runs here because this is where an embedding appears
    (W5-7). A review with no vector cannot be compared to anything, so scanning
    anywhere earlier would be a scan that always finds nothing — and a sweep of
    its own would be a second schedule doing the same walk five minutes later.

    Never fatal to the batch: analysis is what a plan is metered for, and a
    failure to link two rows must not lose the insights that were just written.
  */
  if (result.analyzed > 0) {
    try {
      await scanForDuplicates(organizationId);
    } catch (error) {
      log.warn({ organizationId, err: error }, "Duplicate scan failed; analysis kept");
    }
  }

  // A full batch means there is probably more. Re-enqueue rather than looping
  // here, so the work stays interruptible and visible in the queue.
  const continued = result.analyzed >= allowance && allowance > 0;
  if (continued) await enqueueAnalyze(queue, { organizationId });

  // Hand off to notification: sentiment is now known, so an alert that has not
  // gone out yet can leave with the right urgency. The notify job is
  // idempotent, so enqueuing it after every batch costs nothing.
  if (result.analyzed > 0) await enqueueNotify(queue, { organizationId });

  log.info(
    {
      organizationId,
      analyzed: result.analyzed,
      skipped: result.skipped,
      failed: result.failed,
      embedded: result.embedded,
      listCostUsd: Number(result.listCostUsd.toFixed(6)),
      continued,
    },
    "Analysis job completed",
  );

  return {
    organizationId,
    analyzed: result.analyzed,
    failed: result.failed,
    embedded: result.embedded,
    continued,
  };
}
