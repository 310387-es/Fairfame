import { and, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { liveReplyJoin } from "../reviews/answered.ts";
import type { Sentiment } from "../db/schema.ts";
import type { RangeWindow } from "../dashboard/range.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";

/**
 * One read, every panel on Insights (P3-T4).
 *
 * The same bargain `src/dashboard/facts.ts` strikes, for the same reason: ten
 * panels describing one set of reviews as ten queries is ten chances to
 * disagree, and "the trend says 128 while the location table says 126" is the
 * kind of defect nobody reports and everybody notices.
 *
 * **Deliberately a separate loader from the dashboard's**, rather than a
 * parameter added to it. Home answers "how is *this branch* doing" and its
 * query is scoped to one location; Insights answers "where, and driven by
 * what", so its first-class question is the comparison *between* locations.
 * That means every fact has to carry its location, the query cannot filter to
 * one, and the location scope a member is allowed to see has to be applied
 * here — three differences that would turn the dashboard loader into a function
 * with a mode flag, which is how two behaviours end up sharing one set of bugs.
 *
 * Scale is the same order: an organization's reviews over at most 90 days plus
 * the comparison window. If that ever hurts, the answer is a materialised daily
 * rollup, not a query per panel.
 */

export type InsightFact = {
  reviewId: string;
  /**
   * When it counts as having happened: the platform's timestamp where there is
   * one, otherwise ingestion. Bucketing on `created_at` alone piles a backfill
   * onto the day it was imported and invents a spike.
   */
  at: Date;
  locationId: string;
  source: string;
  rating: number | null;
  sentiment: Sentiment | null;
  sentimentScore: number | null;
  topics: string[];
  /**
   * Canonical themes (W3.2), or null when this review predates the taxonomy.
   *
   * Null and `[]` are different answers and the panel needs both: `[]` means
   * "no theme fits", null means "analysed before there was a list", and a
   * trend built without that distinction understates every theme by however
   * much of the corpus has not been re-analysed.
   */
  themes: string[] | null;
  /** Names the reviewer wrote. Empty when nobody was named. */
  staff: string[];
  /**
   * Whether this review was analysed by a prompt that extracts names at all.
   *
   * Without it an un-analysed corpus and a corpus where nobody was named look
   * identical, and the staff panel would report "no mentions" about a business
   * whose customers name someone in every second review.
   */
  staffAnalysed: boolean;
  repliedAt: Date | null;
};

export type InsightFacts = {
  current: InsightFact[];
  previous: InsightFact[];
};

/** `posted_at` where the platform gave us one, else the row's own creation. */
const effectiveAt = sql<Date>`coalesce(${schema.reviews.postedAt}, ${schema.reviews.createdAt})`;

export async function loadInsightFacts(
  tx: TenantDatabase,
  organizationId: string,
  /**
   * The locations this member may see — from `src/auth/scope.ts`, never from a
   * query string. An empty list means the member is scoped to no location, and
   * the honest answer is no data rather than every location.
   */
  locationIds: string[],
  window: RangeWindow,
  /** The prompt id that extracts names; anything older did not. */
  staffPromptId: string,
): Promise<InsightFacts> {
  if (locationIds.length === 0) return { current: [], previous: [] };

  const rows = await tx
    .select({
      reviewId: schema.reviews.id,
      at: effectiveAt,
      locationId: schema.reviews.locationId,
      source: schema.reviews.source,
      rating: schema.reviews.rating,
      sentiment: schema.reviewInsights.sentiment,
      sentimentScore: schema.reviewInsights.sentimentScore,
      topics: schema.reviewInsights.topics,
      themes: schema.reviewInsights.themes,
      staff: schema.reviewInsights.staff,
      promptId: schema.reviewInsights.promptId,
      // The earliest *published* reply. `min` rather than a plain join, so a
      // review with two replies yields one fact instead of two and does not
      // double-count in every volume figure on the page.
      // `least` folds in the reply the owner left on the platform (W1.2):
      // response rate and response time here answered "did *we* post it",
      // which reports a business that replies to everything in Google as
      // replying to nothing. Postgres's `least` ignores nulls.
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
        // A direct message is private correspondence. It is legitimate inbox
        // work and it is not evidence about a branch's reputation, so it stays
        // out of every number on this page — the same call the widget scope
        // makes, for a different reason.
        ne(schema.reviews.itemType, "dm"),
        gte(effectiveAt, window.previous.start),
        lt(effectiveAt, window.end),
      ),
    )
    .groupBy(
      schema.reviews.id,
      schema.reviews.ownerRepliedAt,
      schema.reviews.postedAt,
      schema.reviews.createdAt,
      schema.reviews.locationId,
      schema.reviews.source,
      schema.reviews.rating,
      schema.reviewInsights.sentiment,
      schema.reviewInsights.sentimentScore,
      schema.reviewInsights.topics,
      schema.reviewInsights.themes,
      schema.reviewInsights.staff,
      schema.reviewInsights.promptId,
    );

  const current: InsightFact[] = [];
  const previous: InsightFact[] = [];

  for (const row of rows) {
    const at = new Date(row.at);
    const fact: InsightFact = {
      reviewId: row.reviewId,
      at,
      locationId: row.locationId,
      source: row.source,
      rating: row.rating,
      sentiment: row.sentiment,
      sentimentScore: row.sentimentScore,
      topics: row.topics ?? [],
      themes: row.themes ?? null,
      staff: row.staff ?? [],
      staffAnalysed: row.promptId === staffPromptId,
      repliedAt: row.repliedAt ? new Date(row.repliedAt) : null,
    };

    // Split once here rather than by date in every panel: the boundary is one
    // rule, and this is the only place it can be got wrong.
    if (at >= window.start) current.push(fact);
    else previous.push(fact);
  }

  return { current, previous };
}
