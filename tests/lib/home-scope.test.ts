import { describe, expect, it } from "vitest";
import { ALL_BRANCHES, homeHref, resolveHomeScope } from "@/dashboard/scope";

/**
 * Home's branch scope (W4.3).
 *
 * The interesting behaviour is entirely in what it refuses. The default is
 * *every* branch — that is the audit's ask — and the fallbacks all lead back to
 * it rather than to "the first one", which is what the active-location cookie
 * does and would be wrong here.
 */

const branches = [
  { id: "kadikoy", name: "Kadıköy Şubesi" },
  { id: "besiktas", name: "Beşiktaş Şubesi" },
];

describe("the default is the whole business", () => {
  it("shows every branch with no parameter", () => {
    const scope = resolveHomeScope(branches, undefined);

    expect(scope.locationId).toBeNull();
    expect(scope.locationIds).toEqual(["kadikoy", "besiktas"]);
    expect(scope.name).toBeNull();
  });

  it("shows every branch for the explicit sentinel", () => {
    expect(resolveHomeScope(branches, ALL_BRANCHES).locationId).toBeNull();
  });

  it("falls back to every branch for an id this member cannot see", () => {
    /**
     * Not to the first branch. Pasting a link to somebody else's branch should
     * show you your own business, not silently reinterpret the URL as a
     * different branch — and unlike the active-location cookie there is no
     * "the one I was last looking at" to fall back to.
     */
    const scope = resolveHomeScope(branches, "a-branch-from-another-org");

    expect(scope.locationId).toBeNull();
    expect(scope.locationIds).toEqual(["kadikoy", "besiktas"]);
  });

  it("returns nothing for a member scoped to no branch", () => {
    // The `src/analytics/facts.ts` rule: an empty scope means nothing, never
    // everything — the failure that looks perfect to the admin testing it.
    expect(resolveHomeScope([], undefined).locationIds).toEqual([]);
  });
});

describe("drilling into one branch", () => {
  it("narrows to it and names it", () => {
    const scope = resolveHomeScope(branches, "besiktas");

    expect(scope.locationId).toBe("besiktas");
    expect(scope.locationIds).toEqual(["besiktas"]);
    expect(scope.name).toBe("Beşiktaş Şubesi");
  });

  it("takes the first of a repeated parameter rather than throwing", () => {
    expect(resolveHomeScope(branches, ["kadikoy", "besiktas"]).locationId).toBe("kadikoy");
  });
});

describe("the links the strip builds", () => {
  it("carries the range across a drill-in", () => {
    // Reordering is not filtering: changing which branch you are looking at
    // must not silently reset the period you were looking at it over.
    expect(homeHref("kadikoy", "90d")).toBe("/dashboard?branch=kadikoy&range=90d");
  });

  it("says nothing at all for the default", () => {
    // A bare URL, so the default view has one address rather than two.
    expect(homeHref(null)).toBe("/dashboard");
  });
});
