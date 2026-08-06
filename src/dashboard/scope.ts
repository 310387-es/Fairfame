import type { LocationOption } from "../lib/active-location.ts";

/**
 * Which branches Home is showing (W4.3).
 *
 * ## Why this is Home's own control and not the global switcher
 *
 * `docs/remediation-plan.md` asks Home to **default to all locations** with a
 * branch comparison strip, and the obvious move is to teach the top-bar
 * switcher an "All branches" option. That would be wrong today, and quietly:
 * the switcher is global, and Reviews, the weekly plan and search all resolve a
 * single branch through `resolveActiveLocation` with location ids threaded into
 * raw SQL. They would fall back to the first branch — which is what they
 * already do for an unrecognised cookie — while the switcher said "All
 * branches". A control that names a scope three screens do not honour is worse
 * than no control.
 *
 * So the scope lives in Home's own URL. It is a view of one page, it is
 * shareable, and it commits nothing about screens that cannot honour it yet.
 * When the queue learns to span branches, this moves up to the switcher and
 * this module is where that decision is recorded.
 *
 * ## Why the default is everything
 *
 * A chain owner opening Home wants to know how the business is doing, not how
 * whichever branch a cookie last remembered is doing. The single-branch view is
 * the drill-in, reached by pressing a row in the strip. On a one-branch account
 * the two are the same thing and no control is shown at all.
 *
 * Db-free and framework-free: the page reads it, the strip's links build it.
 */

export const ALL_BRANCHES = "all";

export const BRANCH_PARAM = "branch";

export type HomeScope = {
  /** Null when every branch is in view. */
  locationId: string | null;
  /** The branches actually queried — one, or every branch the member may see. */
  locationIds: string[];
  /** What the header says. Null means "all branches", worded by the caller. */
  name: string | null;
};

/**
 * Resolves the requested branch against what this member may actually see.
 *
 * An unknown id falls back to **all branches**, not to the first one. Pasting a
 * link to a branch you cannot see should show you your own business, not
 * silently reinterpret the URL as somebody else's branch — and unlike the
 * active-location cookie there is no "the one I was last looking at" to fall
 * back to.
 */
export function resolveHomeScope(
  locations: LocationOption[],
  requested: string | string[] | undefined,
): HomeScope {
  const all = {
    locationId: null,
    locationIds: locations.map((location) => location.id),
    name: null,
  };

  const value = Array.isArray(requested) ? requested[0] : requested;
  if (value === undefined || value === ALL_BRANCHES) return all;

  const found = locations.find((location) => location.id === value);
  if (!found) return all;

  return { locationId: found.id, locationIds: [found.id], name: found.name };
}

/** The Home URL for a branch, or for all of them. */
export function homeHref(locationId: string | null, range?: string): string {
  const params = new URLSearchParams();
  if (locationId !== null) params.set(BRANCH_PARAM, locationId);
  if (range) params.set("range", range);

  const query = params.toString();
  return query === "" ? "/dashboard" : `/dashboard?${query}`;
}
