import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { liveReplyJoin } from "../reviews/answered.ts";
import type { Sentiment } from "../db/schema.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import type { RangeWindow } from "./range.ts";

/**
 * One read, many widgets (Home live dashboard §4).
 *
 * Ten widgets describing the same reviews could be ten queries, and would then
 * be ten chances to disagree: the KPI counting 128 reviews while the chart
 * plots 126 is the kind of defect nobody reports and everybody notices. So the
 * page loads one set of facts — the minimum columns needed to compute every
 * number on it — and each widget is a pure function over that.
 *
 * The window covers the *previous* period too, because every KPI shows a delta
 * and fetching the comparison separately would double the round trips to
 * describe rows we already have in hand.
 *
 * Scale: one location over at most 90 days plus its comparison. Aggregating in
 * SQL would return less data, but it would also return it per widget, and the
 * shapes differ enough (day buckets, rating histogram, per-source, per-theme,
 * medians) that it would be five or six queries rather than one. If a location
 * ever carries enough reviews for this to hurt, the fix is a materialised
 * daily rollup, not five queries over the same rows.
 */

export type ReviewFact = {
  reviewId: string;
  /**
   * Which branch it belongs to (W4.3).
   *
   * Carried on the fact rather than fetched again per branch, because the
   * comparison strip and the page's headline figures have to be the same
   * arithmetic over the same rows. A separate per-branch query would be a
   * second definition of "this month's rating", and the two would disagree the
   * first time somebody changed one of them.
   */
  locationId: string;
  /**
   * When it counts as having happened: the platform's own timestamp where we
   * have one, otherwise when we ingested it. Bucketing on `created_at` alone
   * would pile a backfill onto the day it was imported and invent a spike.
   */
  at: Date;
  source: string;
  itemType: "review" | "comment" | "mention" | "dm";
  rating: number | null;
  sentiment: Sentiment | null;
  sentimentScore: number | null;
  /**
   * The free-text long tail, in whatever language the customer wrote. Useful
   * for counting; never show one to a reader — see `themes`.
   */
  topics: string[];
  /**
   * Canonical themes (W3.2), which is what a *sentence* has to be built from.
   * Null on a review analysed before the taxonomy existed, so an empty array
   * here means "nothing canonical", not "no themes".
   */
  themes: string[];
  /**
   * When this review was answered, if it was — by a reply we published or by
   * one the owner left on the platform (W1.2). The earlier of the two.
   */
  repliedAt: Date | null;
};

export type DashboardFacts = {
  /** Facts inside the selected window. */
  current: ReviewFact[];
  /** The equal-length window before it — the comparison for every delta. */
  previous: ReviewFact[];
  /**
   * The last ninety days, whatever the selected range (W3.3).
   *
   * The baseline the reputation score is smoothed toward. A separate field
   * rather than "current plus previous", because those two are the *selected*
   * range doubled — on a 7-day view that is a fortnight, which is not a
   * baseline, it is a slightly longer sample with the same volatility.
   */
  baseline: ReviewFact[];
};

/**
 * How far back the smoothing baseline reaches (W3.3).
 *
 * Ninety days is long enough that a quiet fortnight cannot move it much and
 * short enough that a business which genuinely improved is not held to last
 * spring's reputation forever.
 */
export const BASELINE_DAYS = 90;

/** `posted_at` where the platform gave us one, else the row's own creation. */
const effectiveAt = sql<Date>`coalesce(${schema.reviews.postedAt}, ${schema.reviews.createdAt})`;

export async function loadFacts(
  tx: TenantDatabase,
  organizationId: string,
  /**
   * The branches in view — one when a branch is selected, every branch the
   * member may see when Home is showing the whole business (W4.3).
   *
   * A list rather than an optional "all" flag, for the reason
   * `src/analytics/facts.ts` is built the same way: the caller has already
   * resolved the member's scope, and an empty list means they may see nothing,
   * which must return nothing rather than everything.
   */
  locationIds: string[],
  window: RangeWindow,
): Promise<DashboardFacts> {
  if (locationIds.length === 0) return { current: [], previous: [], baseline: [] };

  // The baseline reaches back ninety days from the end of the selected range,
  // which on a long range is *inside* it — hence the `min` in the WHERE below,
  // so a 12-month view still fetches everything it needs.
  const baselineStart = new Date(window.end.getTime() - BASELINE_DAYS * 24 * 60 * 60 * 1000);

  const rows = await tx
    .select({
      reviewId: schema.reviews.id,
      at: effectiveAt,
      locationId: schema.reviews.locationId,
      source: schema.reviews.source,
      itemType: schema.reviews.itemType,
      rating: schema.reviews.rating,
      sentiment: schema.reviewInsights.sentiment,
      sentimentScore: schema.reviewInsights.sentimentScore,
      topics: schema.reviewInsights.topics,
      themes: schema.reviewInsights.themes,
      // The earliest *published* reply. `min` rather than a plain join so a
      // review with two replies yields one fact rather than two, which would
      // otherwise double-count it in every volume figure on the page.
      //
      // `least` folds in the reply the owner left on the platform (W1.2), which
      // feeds the response rate, the response-time average and the "still
      // waiting" count — all three of which used to report a business that
      // answers every review in Google as answering none of them. Postgres's
      // `least` ignores nulls, so this is "the earlier of whichever exist".
      repliedAt: sql<Date | null>`least(min(${schema.replies.postedAt}), ${schema.reviews.ownerRepliedAt})`,
    })
    .from(schema.reviews)
    .leftJoin(
      schema.reviewInsights,
      and(
        eq(schema.reviewInsights.reviewId, schema.reviews.id),
        eq(schema.reviewInsights.organizationId, schema.reviews.organizationId),
      ),
    )
    // A failed attempt leaves the review answerable again, so it must not read
    // as answered — one join condition, shared with the Inbox (W1.2).
    .leftJoin(schema.replies, liveReplyJoin)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        inArray(schema.reviews.locationId, locationIds),
        gte(
          effectiveAt,
          baselineStart < window.previous.start ? baselineStart : window.previous.start,
        ),
        lt(effectiveAt, window.end),
      ),
    )
    .groupBy(
      schema.reviews.id,
      schema.reviews.locationId,
      schema.reviews.ownerRepliedAt,
      schema.reviews.postedAt,
      schema.reviews.createdAt,
      schema.reviews.source,
      schema.reviews.itemType,
      schema.reviews.rating,
      schema.reviewInsights.sentiment,
      schema.reviewInsights.sentimentScore,
      schema.reviewInsights.topics,
      // Every selected column that is not aggregated has to be grouped, and
      // adding one to the projection without adding it here fails at *runtime*
      // only — the pure-function tests over fixtures never touch SQL.
      schema.reviewInsights.themes,
    );

  const facts: ReviewFact[] = rows.map((row) => ({
    reviewId: row.reviewId,
    at: new Date(row.at),
    locationId: row.locationId,
    source: row.source,
    itemType: row.itemType,
    rating: row.rating,
    sentiment: row.sentiment,
    sentimentScore: row.sentimentScore,
    topics: row.topics ?? [],
    themes: row.themes ?? [],
    repliedAt: row.repliedAt ? new Date(row.repliedAt) : null,
  }));

  // Split once here rather than filtering by date in every widget: the boundary
  // is a single rule, and this is the only place it can be got wrong.
  const current: ReviewFact[] = [];
  const previous: ReviewFact[] = [];
  // Everything in the ninety-day baseline, including the selected window: it is
  // the long run this business is judged against, not a period *before* now.
  const baseline: ReviewFact[] = [];

  for (const fact of facts) {
    if (fact.at >= baselineStart) baseline.push(fact);
    if (fact.at >= window.start) current.push(fact);
    else if (fact.at >= window.previous.start) previous.push(fact);
  }

  return { current, previous, baseline };
}

/**
 * Has this location ever received anything at all?
 *
 * Asked only when the selected range came back empty, to tell two very
 * different situations apart: a location nobody has connected a source to yet,
 * which needs onboarding, and a real location having a quiet fortnight, which
 * needs a longer range. Showing "connect a source" to a business with 800
 * reviews and a slow week would be insulting, and showing "try 90 days" to a
 * location with nothing wired up is a dead end.
 */
export async function hasAnyReviews(
  tx: TenantDatabase,
  organizationId: string,
  locationIds: string[],
): Promise<boolean> {
  if (locationIds.length === 0) return false;

  const [row] = await tx
    .select({ id: schema.reviews.id })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        inArray(schema.reviews.locationId, locationIds),
      ),
    )
    .limit(1);

  return row !== undefined;
}
