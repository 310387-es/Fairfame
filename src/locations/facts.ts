import { and, eq, gte, lt, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { liveReplyJoin, UNANSWERED } from "../reviews/answered.ts";
import { normalizeThemes, type CanonicalTheme } from "../reviews/taxonomy.ts";

/**
 * The per-branch numbers behind the Locations table (W4.2).
 *
 * ## Why the table needed its own loader
 *
 * The Locations screen used to show one figure — total reviews, all time — and
 * a total is the least useful thing a table of branches can carry: it ranks
 * branches by how long they have been open. What a multi-branch owner is
 * scanning for is which branch has moved, so the columns are all **thirty-day**
 * and the rating carries a delta against the thirty days before it.
 *
 * `src/analytics/facts.ts` already computes a two-window comparison, and this
 * is deliberately not that: it pulls every review row into memory with its
 * insight, which is right for a workspace that charts and cross-tabs them and
 * wrong for a table that needs five numbers per branch. Aggregating in Postgres
 * keeps a chain of forty branches to one round trip.
 *
 * ## The rules it inherits rather than re-deriving
 *
 * - **Unanswered** is `UNANSWERED` from `src/reviews/answered.ts`, with its
 *   join. There were four opinions about this once (W1.2) and a table showing a
 *   fifth would put a number on screen that disagrees with the queue it links
 *   to.
 * - **Themes** are canonical keys through `normalizeThemes`, so a branch's top
 *   themes are the same vocabulary the filters and Insights use — free text
 *   here would give a Turkish branch different themes from an English one for
 *   the same complaint.
 * - **Absence is null, never zero.** A branch with no rated reviews in thirty
 *   days did not average nought stars, and a delta needs both sides to exist.
 *   The same rule `src/analytics/trends.ts` is built on.
 */

export const WINDOW_DAYS = 30;
/** How many themes a row's detail panel shows. More is a list, not a signal. */
export const TOP_THEMES = 4;

export type LocationFact = {
  locationId: string;
  reviews: number;
  /** Mean rating over the window, or null when nothing rated arrived. */
  rating: number | null;
  /** Change against the previous window. Null unless both sides exist. */
  ratingDelta: number | null;
  previousReviews: number;
  unanswered: number;
  themes: { theme: CanonicalTheme; count: number }[];
};

export async function loadLocationFacts(
  tx: TenantDatabase,
  organizationId: string,
  now = new Date(),
): Promise<Map<string, LocationFact>> {
  const day = 24 * 60 * 60 * 1_000;
  const since = new Date(now.getTime() - WINDOW_DAYS * day);
  const before = new Date(now.getTime() - WINDOW_DAYS * 2 * day);

  // `posted_at` where the platform gave us one, else ingestion — the same
  // definition the analytics facts use, so a branch's thirty days here and its
  // thirty days there are the same thirty days.
  const at = sql<Date>`coalesce(${schema.reviews.postedAt}, ${schema.reviews.createdAt})`;

  const [current, previous, unanswered, themes] = [
    await tx
      .select({
        locationId: schema.reviews.locationId,
        reviews: sql<number>`count(*)::int`,
        rating: sql<number | null>`avg(${schema.reviews.rating})`,
      })
      .from(schema.reviews)
      .where(and(eq(schema.reviews.organizationId, organizationId), gte(at, since)))
      .groupBy(schema.reviews.locationId),

    await tx
      .select({
        locationId: schema.reviews.locationId,
        reviews: sql<number>`count(*)::int`,
        rating: sql<number | null>`avg(${schema.reviews.rating})`,
      })
      .from(schema.reviews)
      .where(and(eq(schema.reviews.organizationId, organizationId), gte(at, before), lt(at, since)))
      .groupBy(schema.reviews.locationId),

    /**
     * Unanswered is deliberately **not** windowed. A one-star review from six
     * weeks ago that nobody has replied to is still unanswered, and hiding it
     * behind the same thirty days as the volume column would make the number
     * shrink as the backlog aged — the exact opposite of what a backlog count
     * is for.
     */
    await tx
      .select({
        locationId: schema.reviews.locationId,
        unanswered: sql<number>`count(*)::int`,
      })
      .from(schema.reviews)
      .leftJoin(schema.replies, liveReplyJoin)
      .where(and(eq(schema.reviews.organizationId, organizationId), UNANSWERED))
      .groupBy(schema.reviews.locationId),

    await tx
      .select({
        locationId: schema.reviews.locationId,
        themes: schema.reviewInsights.themes,
      })
      .from(schema.reviews)
      .innerJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
      .where(and(eq(schema.reviews.organizationId, organizationId), gte(at, since))),
  ];

  const previousBy = new Map(previous.map((row) => [row.locationId, row]));
  const unansweredBy = new Map(unanswered.map((row) => [row.locationId, row.unanswered]));

  const themeCounts = new Map<string, Map<CanonicalTheme, number>>();
  for (const row of themes) {
    const counts = themeCounts.get(row.locationId) ?? new Map<CanonicalTheme, number>();
    for (const theme of normalizeThemes(row.themes)) {
      counts.set(theme, (counts.get(theme) ?? 0) + 1);
    }
    themeCounts.set(row.locationId, counts);
  }

  const facts = new Map<string, LocationFact>();

  // Every location that has *any* of these signals, not just the ones with
  // reviews this month: a branch with an unanswered backlog and no new reviews
  // is precisely the row somebody needs to see.
  const ids = new Set([
    ...current.map((row) => row.locationId),
    ...unansweredBy.keys(),
    ...themeCounts.keys(),
  ]);

  for (const locationId of ids) {
    const now_ = current.find((row) => row.locationId === locationId);
    const then = previousBy.get(locationId);

    // `avg()` comes back as a string from `pg` for a numeric result, and as
    // null when nothing was rated. Both have to be handled here or the delta
    // becomes string arithmetic that silently concatenates.
    const rating = toNumber(now_?.rating);
    const previousRating = toNumber(then?.rating);

    facts.set(locationId, {
      locationId,
      reviews: now_?.reviews ?? 0,
      rating,
      ratingDelta: rating !== null && previousRating !== null ? rating - previousRating : null,
      previousReviews: then?.reviews ?? 0,
      unanswered: unansweredBy.get(locationId) ?? 0,
      themes: [...(themeCounts.get(locationId) ?? new Map())]
        .sort((left, right) => right[1] - left[1])
        .slice(0, TOP_THEMES)
        .map(([theme, count]) => ({ theme, count })),
    });
  }

  return facts;
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
