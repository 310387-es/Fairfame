import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { analyzeBatch } from "../ai/analysis-run.ts";
import { CONTENT_HASH_LENGTH } from "../ai/embeddings.ts";
import { schema } from "../db/client.ts";
import { generateDigest, MIN_ANALYSED_REVIEWS } from "../digest/pipeline.ts";
import { priorWindow, weekWindow } from "../digest/metrics.ts";
import { recordUsage, withinLimit } from "../lib/entitlements.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";

/**
 * The first briefing (W5-14, and positioning win 2 in `docs/remediation-plan.md`).
 *
 * > **Digest-first onboarding** — connect Google → run analysis → compose a
 * > digest immediately over the backfill → land the user on it. Not "wait a
 * > week."
 *
 * The Action Digest is the hero feature and it was, until now, unreachable for
 * the first seven days of every account. `digest_sweep` composes the *last
 * completed week*, which for somebody who signed up on Tuesday is a week that
 * predates their account. The product's best screen was empty exactly when a
 * new customer was deciding whether to keep it.
 *
 * This module is what runs instead, and it is deliberately the **same pipeline**
 * rather than a special onboarding one: `analyzeBatch` and `generateDigest`
 * unchanged. A briefing produced by a shortcut would be a briefing that could
 * disagree with every one after it.
 *
 * Two things are onboarding-specific and both are about *which week*:
 *
 *   - A backfill is history, so its most recent completed week may be three
 *     weeks ago. `firstBriefingWindow` walks back to find one with something in
 *     it rather than composing an empty digest and calling that a welcome.
 *   - It never uses a *partial* week. A digest means "a completed week" —
 *     `weekWindow` says so, the archive labels it that way, and the
 *     week-on-week comparison is the whole point. Opening on a half week to
 *     have something to show would make the first briefing the one that does
 *     not mean what the others do.
 */

const log = childLogger({ module: "onboarding/first-briefing" });

/**
 * How far back to look for a week worth briefing on.
 *
 * Eight weeks, because past that the "what changed since last week" framing is
 * about two months ago and reads as archaeology rather than news.
 */
export const MAX_LOOKBACK_WEEKS = 8;

/**
 * Reviews a week needs before it is worth a briefing.
 *
 * **`MIN_ANALYSED_REVIEWS`, imported rather than chosen.** The pipeline already
 * refuses to compose actions below it — W1.6's rule that a theme drawn from two
 * reviews is a guess with a number on it — so picking any smaller figure here
 * would walk back through the calendar, settle on a week, and hand it to a
 * pipeline that then declines to say anything. That is exactly what happened on
 * the first run of this feature: a sample workspace with sixty reviews opened
 * on "Not enough to draw a plan from", which is the failure this whole feature
 * exists to prevent.
 *
 * Counted over reviews *with text*, because a rating with no words is nothing
 * analysis can turn into a theme.
 */
export const MIN_REVIEWS_FOR_FIRST_BRIEFING = MIN_ANALYSED_REVIEWS;

/**
 * Reviews analysed per step.
 *
 * Ten, not the worker's fifty, because **the welcome screen drives this loop**
 * rather than a job queue. Each step is one server action the browser is
 * waiting on, so the batch has to fit inside a request: ten at the configured
 * concurrency is a few seconds, and the progress number moves often enough to
 * read as progress rather than as a hang.
 *
 * The queue is not used here deliberately. Driving it from the poll means the
 * first briefing works with **no worker process at all** — a fresh clone, a
 * single-container deployment, a worker that is restarting — and if somebody
 * closes the tab half way, `analyze_sweep` and `digest_sweep` finish the job on
 * their own schedule. Degrading to the behaviour that existed before is the
 * right failure.
 */
export const ANALYSIS_BATCH = 10;

/**
 * The most recent completed week with enough reviews to brief on.
 *
 * Null when there is nothing in the lookback — a brand-new location with no
 * connection yet, which is not a failure and must not produce an empty digest
 * presented as a first impression.
 */
export async function firstBriefingWindow(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  now = new Date(),
): Promise<{ start: Date; end: Date } | null> {
  let window = weekWindow(now);

  for (let attempt = 0; attempt < MAX_LOOKBACK_WEEKS; attempt += 1) {
    const [row] = await tx
      .select({ total: sql<number>`count(*)::int`.mapWith(Number) })
      .from(schema.reviews)
      .where(
        and(
          eq(schema.reviews.organizationId, organizationId),
          eq(schema.reviews.locationId, locationId),
          gte(schema.reviews.postedAt, window.start),
          lt(schema.reviews.postedAt, window.end),
          // With text: see MIN_REVIEWS_FOR_FIRST_BRIEFING. A week of five bare
          // five-star ratings gives the pipeline nothing to name.
          sql`${schema.reviews.text} is not null and length(trim(${schema.reviews.text})) > 0`,
        ),
      );

    if ((row?.total ?? 0) >= MIN_REVIEWS_FOR_FIRST_BRIEFING) return window;

    const start = new Date(window.start);
    start.setUTCDate(start.getUTCDate() - 7);
    window = { start, end: window.start };
  }

  return null;
}

/**
 * How far along the first briefing is.
 *
 * **Derived, never stored.** There is no `onboarding_runs` table because every
 * field of one would be a second copy of something already true in the
 * database: how many reviews arrived, how many carry insights, whether a digest
 * exists. A stored progress row can disagree with reality; this cannot.
 *
 * The staleness predicate mirrors `selectTargets` in `ai/analysis-run.ts` and
 * `runAnalyzeSweep` — the third copy, and like the second it is deliberate:
 * this one is scoped to a location, which neither of those can do.
 */
export type OnboardingStatus = {
  locationId: string | null;
  /** Every review in the branch — what the dashboard already has to show. */
  reviews: number;
  /**
   * Reviews the *briefing* is made of, with text.
   *
   * Deliberately not every review with text in the branch. The progress bar has
   * to count the thing being waited for, and what is being waited for is one
   * week plus the week it is compared against — see `pendingAnalysis`. A
   * denominator of "the whole backfill" would show 15/200 and then jump to
   * finished, which reads as a bug in exactly the place a new customer is
   * deciding whether to trust the numbers.
   */
  analysable: number;
  analysed: number;
  /** The first briefing, once it exists. */
  digestId: string | null;
  /** True when there is nothing left to wait for. */
  done: boolean;
  /**
   * A source is connected and its first sync has not finished (A22-B1).
   *
   * The distinction the welcome screen could not make: "there is nothing to
   * brief on" and "the reviews have not arrived yet" both read as `analysable =
   * 0`, so a brand-new account watched a **0/0** bar and was told its branch was
   * empty while the backfill was still running. One is a dead end and the other
   * is a wait, and only the second is worth showing a spinner for.
   *
   * `first_synced_at` is the right column rather than `last_synced_at`: it is
   * null exactly once, before the first sync of a connection ever completes,
   * which is precisely the window this describes. It is also what W1.3 reads to
   * decide a backfill is history rather than news.
   */
  awaitingSync: boolean;
};

export async function onboardingStatus(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  now = new Date(),
): Promise<OnboardingStatus> {
  const [total] = await tx
    .select({ reviews: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.locationId, locationId),
      ),
    );

  const window = await firstBriefingWindow(tx, organizationId, locationId, now);
  const span = window
    ? { from: priorWindow(window).start, to: window.end }
    : // No week worth briefing on: the bar has nothing to count, and the screen
      // says so rather than drawing an empty track.
      null;

  const [counts] = span
    ? await tx
        .select({
          analysable: sql<number>`count(*)::int`.mapWith(Number),
          analysed: sql<number>`count(${schema.reviewInsights.id})::int`.mapWith(Number),
        })
        .from(schema.reviews)
        .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
        .where(
          and(
            eq(schema.reviews.organizationId, organizationId),
            eq(schema.reviews.locationId, locationId),
            gte(schema.reviews.postedAt, span.from),
            lt(schema.reviews.postedAt, span.to),
            sql`${schema.reviews.text} is not null and length(trim(${schema.reviews.text})) > 0`,
          ),
        )
    : [{ analysable: 0, analysed: 0 }];

  const [digest] = await tx
    .select({ id: schema.digests.id })
    .from(schema.digests)
    .where(
      and(
        eq(schema.digests.organizationId, organizationId),
        eq(schema.digests.locationId, locationId),
        eq(schema.digests.status, "ready"),
      ),
    )
    .orderBy(sql`${schema.digests.periodStart} desc`)
    .limit(1);

  // Any connection on this branch whose first sync has not landed. `count`
  // rather than a boolean so a chain connecting two sources reads as one wait.
  const [syncing] = await tx
    .select({ pending: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.organizationId, organizationId),
        eq(schema.connections.locationId, locationId),
        eq(schema.connections.status, "active"),
        isNull(schema.connections.firstSyncedAt),
      ),
    );

  return {
    locationId,
    reviews: total?.reviews ?? 0,
    analysable: counts?.analysable ?? 0,
    analysed: counts?.analysed ?? 0,
    digestId: digest?.id ?? null,
    done: digest !== undefined,
    awaitingSync: (syncing?.pending ?? 0) > 0,
  };
}

/**
 * Reviews still waiting for analysis, optionally inside a window.
 *
 * The window is the whole trick (W5-14). A briefing is about one week, so
 * waiting for a two-hundred-review Google backfill before composing it means
 * fifteen minutes of progress bar for information the digest never reads. This
 * counts — and `stepFirstBriefing` analyses — only what the briefing is made
 * of: its own week, and the one before it that the comparison needs.
 */
export async function pendingAnalysis(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  span?: { from: Date; to: Date },
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.locationId, locationId),
        span ? gte(schema.reviews.postedAt, span.from) : undefined,
        span ? lt(schema.reviews.postedAt, span.to) : undefined,
        sql`${schema.reviews.text} is not null and length(trim(${schema.reviews.text})) > 0`,
        or(
          isNull(schema.reviewInsights.id),
          isNull(schema.reviewInsights.contentHash),
          sql`${schema.reviewInsights.contentHash} <> left(encode(sha256(convert_to(${schema.reviews.text}, 'UTF8')), 'hex'), ${CONTENT_HASH_LENGTH})`,
        ),
      ),
    );

  return row?.total ?? 0;
}

export type FirstBriefingResult =
  /** Analysis is still draining; the caller should run again. */
  | { status: "analysing"; analysed: number; remaining: number }
  | { status: "ready"; digestId: string }
  /** Nothing to brief on in the lookback — no connection, or a silent quarter. */
  | { status: "no_reviews" };

/**
 * One step of the first briefing: analyse a batch, or compose once analysis is
 * done.
 *
 * Bounded and resumable rather than one long run, so it can be a job that
 * yields — the shape `runAnalyze` already uses. A backfill of four hundred
 * reviews must not hold a worker slot, and the welcome screen wants a number
 * that moves.
 */
export async function stepFirstBriefing(args: {
  organizationId: string;
  locationId: string;
  now?: Date;
}): Promise<FirstBriefingResult> {
  const { organizationId, locationId } = args;
  const now = args.now ?? new Date();

  /**
   * The window is chosen **before** any analysis, not after.
   *
   * It is decided by counting reviews per week, which needs no insights at all
   * — and knowing it first is what lets the next step analyse fifteen reviews
   * instead of two hundred.
   */
  const window = await withTenant({ organizationId }, (tx) =>
    firstBriefingWindow(tx, organizationId, locationId, now),
  );

  if (!window) return { status: "no_reviews" };

  // The briefing's own week plus the one before it: `generateDigest` gathers
  // both, because "what changed since last week" is half of what it says.
  const span = { from: priorWindow(window).start, to: window.end };

  const pending = await withTenant({ organizationId }, (tx) =>
    pendingAnalysis(tx, organizationId, locationId, span),
  );

  if (pending > 0) {
    // The same accounting the analyze worker does, for the same reason: this is
    // the second place analysis runs without a person asking review by review,
    // so it is the second place that could quietly spend a tenant's allowance.
    // `additional: 0` asks what is left rather than reserving it.
    const budget = await withinLimit(organizationId, "ai_analyses_per_month", { additional: 0 });

    if (budget.remaining !== null && budget.remaining <= 0) {
      // Out of allowance is not a failure to retry — it lifts when the period
      // rolls over. Fall through and brief on whatever has been analysed.
      log.info({ organizationId, limit: budget.limit }, "First briefing: analysis allowance spent");
    } else {
      const allowance =
        budget.remaining === null ? ANALYSIS_BATCH : Math.min(ANALYSIS_BATCH, budget.remaining);

      const result = await analyzeBatch({
        organizationId,
        locationId,
        limit: allowance,
        postedFrom: span.from,
        postedTo: span.to,
        // No embeddings. W3.2 settled that a canonical theme finishes in the
        // exact-slug pass, so the digest — which is what this loop exists to
        // produce — needs none of them. The sweep computes them afterwards, out
        // of the way of somebody watching a progress bar.
      });

      // Metered by the model calls actually made, never by what was attempted —
      // and never by a copy, which produced an analysis and spent nothing.
      if (result.analyzed > 0) {
        await recordUsage(organizationId, "ai_analyses_per_month", result.analyzed);
      }

      // Progress is insights written, not calls made: a location whose reviews
      // are mostly "Harika" would otherwise look stalled, and the loop below
      // would give up on a batch that had in fact analysed everything in it.
      const analysed = result.analyzed + result.copied;

      const remaining = Math.max(0, pending - analysed - result.failed);
      log.info(
        { organizationId, locationId, analyzed: result.analyzed, copied: result.copied, remaining },
        "First-briefing analysis batch",
      );

      // Still work to do — unless nothing moved, in which case looping would
      // spin: every remaining review is one analysis refuses, and waiting for
      // them would mean never composing a briefing at all.
      if (remaining > 0 && analysed > 0) {
        return { status: "analysing", analysed, remaining };
      }
    }
  }

  const digest = await generateDigest({
    organizationId,
    locationId,
    window,
    now,
    // The sweep may already have written an empty digest for the current week
    // before anything was ingested. Composing over it is the point.
    force: true,
  });

  return { status: "ready", digestId: digest.digestId };
}
