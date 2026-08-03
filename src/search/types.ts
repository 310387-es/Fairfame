/**
 * The search contract, free of any database import.
 *
 * `queries.ts` reaches for `db/client`, which reaches for `pg`, which reaches
 * for `dns` — so a client component that imports so much as a constant from it
 * drags a Postgres driver into the browser bundle and the build fails on a
 * missing Node built-in. Types alone would be erased and would have been fine;
 * `MIN_QUERY_LENGTH` is a runtime value, and that is what pulls the module in.
 *
 * Anything the palette and the query layer must agree on lives here.
 */

/** Below this, matches are too broad to be worth a query. */
export const MIN_QUERY_LENGTH = 2;

export type ReviewHit = {
  id: string;
  authorName: string | null;
  text: string | null;
  rating: number | null;
  source: string;
  postedAt: Date | null;
};

export type ThemeHit = { slug: string; count: number };

export type SearchResults = {
  reviews: ReviewHit[];
  themes: ThemeHit[];
  /** True when more reviews matched than were returned. */
  hasMore: boolean;
};
