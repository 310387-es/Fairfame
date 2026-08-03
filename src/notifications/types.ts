/**
 * Notification values a client component may import.
 *
 * `feed.ts` reaches for `db/client` → `pg` → Node's `dns`, so a `"use client"`
 * file that imports a *runtime* value from it drags a Postgres driver into the
 * browser bundle and the build fails on a missing built-in. Types are erased
 * and stay safe to import from anywhere; constants are not, and live here.
 *
 * The same split exists for search (`search/types.ts`). If you add a shared
 * constant, put it in a module like this one rather than beside the query that
 * uses it.
 */

/** One scroll-page of notifications in the bell's popover. */
export const FEED_PAGE_SIZE = 20;
