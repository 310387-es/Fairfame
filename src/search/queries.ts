import { and, eq, or, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { MIN_QUERY_LENGTH, type SearchResults } from "./types.ts";

export { MIN_QUERY_LENGTH };
export type { ReviewHit, SearchResults, ThemeHit } from "./types.ts";

/**
 * Search, for the command palette.
 *
 * Scoped to one location, not the whole organization. Every result links into
 * the Inbox, and the Inbox reads the active-location cookie — an org-wide
 * search would happily return reviews that the destination then filters out,
 * which is a worse experience than not finding them.
 *
 * Matching is case- *and* diacritic-insensitive, which in Turkish is not a
 * nicety: `lower('İstanbul') = 'istanbul'` is false, and people type ASCII on
 * phone keyboards constantly. Both sides are folded through
 * `lower(immutable_unaccent(…))` — the exact expression migration 0022 indexes,
 * so the fold stays a index scan rather than becoming a sequential one.
 *
 * Substring matching with `LIKE '%term%'` rather than full-text search. The
 * things people type here are fragments — half a customer's name, a word they
 * remember from a complaint — and `to_tsquery` matches whole lexemes, so
 * "beklem" would find nothing while "bekleme" found everything. Trigram
 * indexes (migration 0021) are what keep the leading wildcard affordable.
 *
 * This is deliberately not ranked. With one location's reviews the useful
 * ordering is "most recent first", and a relevance score computed over a few
 * hundred rows would be a guess dressed up as a ranking.
 */

/**
 * `%` and `_` are wildcards to LIKE, so a customer searching for "50%" would
 * otherwise match everything. Escaping them — and the escape character itself —
 * keeps the query meaning what the person typed.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The folded comparison, written exactly as migration 0022 indexes it. Any
 * drift between the two — a stray `ilike`, a differently-nested `lower` — turns
 * every keystroke back into a sequential scan without failing a single test.
 */
function foldedMatch(column: unknown, pattern: string) {
  return sql`lower(immutable_unaccent(${column})) like lower(immutable_unaccent(${pattern}))`;
}

export async function search(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  rawQuery: string,
  limit = 6,
): Promise<SearchResults> {
  const query = rawQuery.trim();
  if (query.length < MIN_QUERY_LENGTH) return { reviews: [], themes: [], hasMore: false };

  const pattern = `%${escapeLike(query)}%`;

  const [reviewRows, themeRows] = await Promise.all([
    tx
      .select({
        id: schema.reviews.id,
        authorName: schema.reviews.authorName,
        text: schema.reviews.text,
        rating: schema.reviews.rating,
        source: schema.reviews.source,
        postedAt: schema.reviews.postedAt,
      })
      .from(schema.reviews)
      .where(
        and(
          eq(schema.reviews.organizationId, organizationId),
          eq(schema.reviews.locationId, locationId),
          or(
            foldedMatch(schema.reviews.text, pattern),
            foldedMatch(schema.reviews.authorName, pattern),
          ),
        ),
      )
      .orderBy(sql`${schema.reviews.postedAt} desc nulls last`)
      // One more than asked for, so "there are others" needs no second COUNT.
      .limit(limit + 1),

    // Themes come from the analysed topics rather than a table of their own, so
    // this unnests and counts. `ilike` on the unnested value means typing
    // "bekle" surfaces "bekleme süresi".
    tx
      .select({
        slug: sql<string>`topic`,
        count: sql<number>`count(*)::int`,
      })
      .from(
        sql`${schema.reviews}
            join ${schema.reviewInsights}
              on ${schema.reviewInsights.reviewId} = ${schema.reviews.id}
            cross join lateral unnest(${schema.reviewInsights.topics}) as topic`,
      )
      .where(
        and(
          eq(schema.reviews.organizationId, organizationId),
          eq(schema.reviews.locationId, locationId),
          foldedMatch(sql`topic`, pattern),
        ),
      )
      .groupBy(sql`topic`)
      .orderBy(sql`count(*) desc, topic asc`)
      .limit(limit),
  ]);

  return {
    reviews: reviewRows.slice(0, limit),
    themes: themeRows,
    hasMore: reviewRows.length > limit,
  };
}
