import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
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
  topics: string[];
  /** When a reply was actually published, if one was. */
  repliedAt: Date | null;
};

export type DashboardFacts = {
  /** Facts inside the selected window. */
  current: ReviewFact[];
  /** The equal-length window before it — the comparison for every delta. */
  previous: ReviewFact[];
};

/** `posted_at` where the platform gave us one, else the row's own creation. */
const effectiveAt = sql<Date>`coalesce(${schema.reviews.postedAt}, ${schema.reviews.createdAt})`;

export async function loadFacts(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  window: RangeWindow,
): Promise<DashboardFacts> {
  const rows = await tx
    .select({
      reviewId: schema.reviews.id,
      at: effectiveAt,
      source: schema.reviews.source,
      itemType: schema.reviews.itemType,
      rating: schema.reviews.rating,
      sentiment: schema.reviewInsights.sentiment,
      sentimentScore: schema.reviewInsights.sentimentScore,
      topics: schema.reviewInsights.topics,
      // The earliest *published* reply. `min` rather than a plain join so a
      // review with two replies yields one fact rather than two, which would
      // otherwise double-count it in every volume figure on the page.
      repliedAt: sql<Date | null>`min(${schema.replies.postedAt})`,
    })
    .from(schema.reviews)
    .leftJoin(
      schema.reviewInsights,
      and(
        eq(schema.reviewInsights.reviewId, schema.reviews.id),
        eq(schema.reviewInsights.organizationId, schema.reviews.organizationId),
      ),
    )
    .leftJoin(
      schema.replies,
      and(
        eq(schema.replies.reviewId, schema.reviews.id),
        eq(schema.replies.organizationId, schema.reviews.organizationId),
        // A failed attempt leaves the review answerable again, so it must not
        // read as answered — the same rule the Inbox and the reply service use.
        ne(schema.replies.status, "failed"),
      ),
    )
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.locationId, locationId),
        gte(effectiveAt, window.previous.start),
        lt(effectiveAt, window.end),
      ),
    )
    .groupBy(
      schema.reviews.id,
      schema.reviews.postedAt,
      schema.reviews.createdAt,
      schema.reviews.source,
      schema.reviews.itemType,
      schema.reviews.rating,
      schema.reviewInsights.sentiment,
      schema.reviewInsights.sentimentScore,
      schema.reviewInsights.topics,
    );

  const facts: ReviewFact[] = rows.map((row) => ({
    reviewId: row.reviewId,
    at: new Date(row.at),
    source: row.source,
    itemType: row.itemType,
    rating: row.rating,
    sentiment: row.sentiment,
    sentimentScore: row.sentimentScore,
    topics: row.topics ?? [],
    repliedAt: row.repliedAt ? new Date(row.repliedAt) : null,
  }));

  // Split once here rather than filtering by date in every widget: the boundary
  // is a single rule, and this is the only place it can be got wrong.
  const current: ReviewFact[] = [];
  const previous: ReviewFact[] = [];

  for (const fact of facts) {
    if (fact.at >= window.start) current.push(fact);
    else previous.push(fact);
  }

  return { current, previous };
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
  locationId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.reviews.id })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.locationId, locationId),
      ),
    )
    .limit(1);

  return row !== undefined;
}
