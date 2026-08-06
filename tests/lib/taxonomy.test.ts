import { describe, expect, it } from "vitest";
import {
  CANONICAL_THEMES,
  isVertical,
  normalizeThemes,
  THEME_KEYS,
  themesForVertical,
  VERTICALS,
} from "@/reviews/taxonomy";

/**
 * The canonical theme taxonomy (W3.2).
 *
 * What it replaces: `analyze_review` asked for tags "in the review's own
 * language", so one complaint arrived as `bekleme süresi` and `waiting time`
 * and the product charted them as two themes. The whole value of this module is
 * that a key means the same thing whatever language the customer wrote in — so
 * the tests are about the vocabulary staying *closed*, which is the only
 * property that makes a theme trendable.
 */

describe("the vocabulary is closed", () => {
  it("drops anything outside the list rather than adopting it", () => {
    // The load-bearing assertion. The model is handed a closed set; an unlisted
    // value is a failure to follow instructions, not a discovery, and promoting
    // one into the canonical column is how a closed vocabulary stops being one.
    expect(normalizeThemes(["wait_time", "vibes", "mercimek çorbası"])).toEqual(["wait_time"]);
  });

  it("accepts the spellings a model actually produces", () => {
    // Same key, three plausible renderings. Being strict here would silently
    // lose real themes to whitespace.
    expect(normalizeThemes(["Wait Time", "wait-time", "WAIT_TIME"])).toEqual(["wait_time"]);
  });

  it("counts a theme once however many times it is repeated", () => {
    expect(normalizeThemes(["price", "price"])).toEqual(["price"]);
  });

  it("survives a provider that returns nonsense instead of an array", () => {
    for (const value of [null, undefined, "wait_time", 42, {}]) {
      expect(normalizeThemes(value)).toEqual([]);
    }
  });

  it("treats no themes as a real answer", () => {
    // "None of these fit" is legitimate and better than a loose fit, which is
    // a chart line nobody can act on.
    expect(normalizeThemes([])).toEqual([]);
  });
});

describe("themes are offered by vertical", () => {
  it("gives a café its food themes and a clinic none of them", () => {
    expect(themesForVertical("cafe")).toContain("food_quality");
    expect(themesForVertical("clinic")).not.toContain("food_quality");
    expect(themesForVertical("clinic")).toContain("treatment_outcome");
  });

  it("never offers a theme belonging to another vertical", () => {
    // A theme used where it does not belong is worse than one that is missing:
    // "room comfort" in front of a barber is a chart line nobody can act on,
    // and the model will eventually reach for whatever it is shown.
    for (const vertical of VERTICALS) {
      for (const key of themesForVertical(vertical)) {
        const applies = CANONICAL_THEMES[key];
        if (applies === null) continue;
        expect(applies as readonly string[], `${key} offered to ${vertical}`).toContain(vertical);
      }
    }
  });

  it("falls back to the universal set for an unknown or missing category", () => {
    // Not to *everything* — that would put every vertical's themes in front of
    // a business we have not classified.
    const universal = THEME_KEYS.filter((key) => CANONICAL_THEMES[key] === null);

    for (const category of [null, undefined, "", "bakkal"]) {
      expect(themesForVertical(category)).toEqual(universal);
    }
  });

  it("gives every vertical something to say", () => {
    // A vertical with no themes would produce a business whose reviews can
    // never be classified at all.
    for (const vertical of VERTICALS) {
      expect(themesForVertical(vertical).length, vertical).toBeGreaterThan(0);
    }
  });
});

describe("verticals", () => {
  it("recognises its own list and nothing else", () => {
    expect(isVertical("cafe")).toBe(true);
    expect(isVertical("kafe")).toBe(false);
    expect(isVertical(null)).toBe(false);
  });

  it("keeps a home for everything else", () => {
    // A closed list with no "other" gets one business filed under the wrong
    // vertical and then trended against the wrong peers.
    expect(VERTICALS).toContain("other");
  });
});

describe("keys are identifiers, not display text", () => {
  it("uses lower snake_case throughout", () => {
    // Every label a person sees comes from `themes.*` in the message catalogue.
    // A key with a capital or a space is a key somebody has typed as a label.
    for (const key of THEME_KEYS) {
      expect(key, key).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
