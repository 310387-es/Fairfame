/**
 * Where a hosted review page lives.
 *
 * Its own tiny module rather than a line in `src/lib/urls.ts`, and the reason
 * is the `"use client"` rule in `CLAUDE.md`: the locations screen and the embed
 * builder both need to show this URL, and `lib/urls.ts` reads the environment
 * through `getEnv()`, which drags server-only configuration into a client
 * bundle. The pure builder is safe anywhere; the environment-reading wrapper
 * stays behind `publicBaseUrl()` at the call site.
 *
 * `/reviews/` rather than a single letter like `/c/` or `/r/`. Those are short
 * because they are printed on counters and typed by hand; this one is meant to
 * be read in a search result, where the words in the path are part of what a
 * person is deciding about.
 */

export const LOCATION_PAGE_PREFIX = "/reviews";

export function locationPageUrl(base: string, slug: string): string {
  return `${base.replace(/\/+$/, "")}${LOCATION_PAGE_PREFIX}/${slug}`;
}
