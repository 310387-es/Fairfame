import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import { LOCATION_PAGE_PREFIX } from "@/seo/urls";

/**
 * `robots.txt`, and the one rule that can quietly delete a feature (W3.1).
 *
 * Two different things live under the word "reviews" since the rename: the
 * authenticated inbox at `/reviews`, and the public location pages at
 * `/reviews/{slug}` — the only surface in this product that is *meant* to be
 * indexed. Robots rules match by prefix, so `Disallow: /reviews` blocks both,
 * and nothing fails: the build passes, the pages render, and months later the
 * business quietly is not in search results.
 *
 * That is precisely the class of bug a test has to hold, because no person
 * reviewing a diff reads a list of paths and thinks about prefix semantics.
 */

function rules() {
  const result = robots();
  const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;
  const disallow = rule?.disallow ?? [];
  return Array.isArray(disallow) ? disallow : [disallow];
}

describe("robots.txt", () => {
  it("keeps the public review pages crawlable", () => {
    // The assertion that matters. Anchored with `$`, so the rule stops at the
    // exact path and a slug beneath it is untouched.
    const blocked = rules().filter((path) => !path.endsWith("$"));

    for (const path of blocked) {
      expect(
        `${LOCATION_PAGE_PREFIX}/kadikoy-kahve-kadikoy-subesi`.startsWith(path),
        `"${path}" would also block the public review pages`,
      ).toBe(false);
    }
  });

  it("still keeps the review inbox out of the index", () => {
    // The other half: the anchored rule has to actually cover the app page, or
    // fixing the first problem would have created a second.
    expect(rules()).toContain(`${LOCATION_PAGE_PREFIX}$`);
  });

  it("blocks the one-click surfaces a crawler must never fetch", () => {
    // `/u/` is an unsubscribe link — a crawler following it opts somebody out
    // of their own accord, and `noindex` is obeyed *after* the fetch.
    for (const path of ["/u/", "/r/", "/c/", "/api/", "/embed/"]) {
      expect(rules()).toContain(path);
    }
  });

  it("names the renamed application routes rather than the old ones", () => {
    // A stale entry here does nothing visible: the route it names is gone, so
    // the rule matches nothing and the real screen is crawlable.
    const disallow = rules();

    for (const gone of ["/home", "/inbox", "/digest", "/insights", "/requests"]) {
      expect(disallow).not.toContain(gone);
    }
    for (const current of ["/dashboard", "/weekly-plan", "/get-reviews"]) {
      expect(disallow).toContain(current);
    }
  });
});
