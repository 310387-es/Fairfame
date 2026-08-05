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

/**
 * The largest number the bell's badge will print; past it, `9+` (W1.3).
 *
 * A badge is a nudge, not a readout. Nobody triages differently at 44 than at
 * 217 — both mean "more than you are going to deal with in one sitting" — and
 * printing the real figure on a fresh account made the product's first
 * impression a number the owner could only feel bad about. The count itself is
 * still exact everywhere it means something: the popover lists them, and
 * mark-all-read clears them.
 *
 * Here rather than in the component because this module is the db-free home for
 * shared notification constants — the `"use client"` rule in CLAUDE.md.
 */
export const BADGE_CAP = 9;
