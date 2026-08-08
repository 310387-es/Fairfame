import { describe, expect, it } from "vitest";
import {
  DUPLICATE_DISTANCE,
  DUPLICATE_DISTANCE_WITH_AUTHOR,
  DUPLICATE_WINDOW_DAYS,
  isDuplicate,
  normalizeAuthor,
} from "../../src/reviews/duplicates.ts";

/**
 * Cross-source duplicate detection (W5-7).
 *
 * The dangerous direction here is the false positive, so most of these are
 * about refusing. Marking two different customers as one person hides a real
 * review behind somebody else's — and the reviews that read most alike are
 * complaints about the same thing, which is the thing this product exists to
 * find. "Otopark yok, 15 dakika tur attık" and "Park yeri bulamadım" are the
 * same *complaint*, not the same *review*.
 */

const DAY = 24 * 60 * 60 * 1_000;
const MONDAY = new Date("2026-08-03T10:00:00.000Z");

const subject = {
  reviewId: "a",
  source: "google",
  authorName: "Ayşe Yılmaz",
  postedAt: MONDAY,
};

function candidate(overrides: Partial<Parameters<typeof isDuplicate>[1]> = {}) {
  return {
    reviewId: "b",
    source: "firstparty",
    authorName: "Ayse Yilmaz",
    postedAt: MONDAY,
    distance: 0.02,
    ...overrides,
  };
}

describe("normalizeAuthor", () => {
  it("folds the ways two platforms print one Turkish name", () => {
    expect(normalizeAuthor("Ayşe Yılmaz")).toBe(normalizeAuthor("Ayse Yilmaz"));
    expect(normalizeAuthor("  AYŞE   YILMAZ ")).toBe(normalizeAuthor("ayşe yılmaz"));
  });

  it("lower-cases İ the Turkish way", () => {
    // `İ.toLowerCase()` is locale-dependent, and the naive recipe leaves a
    // combining dot behind — the trap `src/seo/slug.ts` documents.
    expect(normalizeAuthor("İrem")).toBe("irem");
  });

  it("is null for a name that carries no signal", () => {
    expect(normalizeAuthor(null)).toBeNull();
    expect(normalizeAuthor("   ")).toBeNull();
    expect(normalizeAuthor("!!!")).toBeNull();
  });

  it("does not collapse two different people", () => {
    expect(normalizeAuthor("Ayşe Yılmaz")).not.toBe(normalizeAuthor("Ayşe Yıldız"));
  });
});

describe("isDuplicate", () => {
  it("links the same words from another source on the same day", () => {
    expect(isDuplicate(subject, candidate())).toBe(true);
  });

  it("refuses two reviews on the same platform", () => {
    // The platform allowed both; we are not going to argue with it.
    expect(isDuplicate(subject, candidate({ source: "google" }))).toBe(false);
  });

  it("refuses a review from outside the date window", () => {
    const later = new Date(MONDAY.getTime() + (DUPLICATE_WINDOW_DAYS + 1) * DAY);
    expect(isDuplicate(subject, candidate({ postedAt: later }))).toBe(false);
  });

  it("accepts inside the window in either direction", () => {
    for (const shift of [-1, 1]) {
      const at = new Date(MONDAY.getTime() + shift * (DUPLICATE_WINDOW_DAYS - 1) * DAY);
      expect(isDuplicate(subject, candidate({ postedAt: at }))).toBe(true);
    }
  });

  it("refuses when either side has no timestamp", () => {
    // A review that cannot be placed in time cannot be placed beside another
    // one; guessing would merge exactly the unplaceable ones.
    expect(isDuplicate({ ...subject, postedAt: null }, candidate())).toBe(false);
    expect(isDuplicate(subject, candidate({ postedAt: null }))).toBe(false);
  });

  it("refuses two similar complaints from different people", () => {
    // The headline false positive. Same day, different sources, same subject —
    // and a distance that is close but not the same words.
    const other = candidate({ authorName: "Mehmet Demir", distance: 0.2 });
    expect(isDuplicate(subject, other)).toBe(false);
  });

  it("allows a looser match once the name agrees", () => {
    expect(
      isDuplicate(subject, candidate({ distance: DUPLICATE_DISTANCE_WITH_AUTHOR - 0.01 })),
    ).toBe(true);
    expect(
      isDuplicate(subject, candidate({ distance: DUPLICATE_DISTANCE_WITH_AUTHOR + 0.01 })),
    ).toBe(false);
  });

  it("needs near-identical words when there is no name to agree on", () => {
    const anonymous = { ...subject, authorName: null };
    expect(
      isDuplicate(anonymous, candidate({ authorName: null, distance: DUPLICATE_DISTANCE })),
    ).toBe(true);
    expect(
      isDuplicate(anonymous, candidate({ authorName: null, distance: DUPLICATE_DISTANCE + 0.01 })),
    ).toBe(false);
  });

  it("does not treat two anonymous reviews as the same person", () => {
    // Both nameless is not "the same name". Without this, every pair of
    // wordless anonymous reviews on two sources would match on the loose
    // threshold.
    const anonymous = { ...subject, authorName: null };
    expect(isDuplicate(anonymous, candidate({ authorName: null, distance: 0.2 }))).toBe(false);
  });

  it("keeps the two thresholds in the right order", () => {
    // A reminder in test form: the name is corroborating evidence, so it may
    // only ever *loosen* the text requirement.
    expect(DUPLICATE_DISTANCE).toBeLessThan(DUPLICATE_DISTANCE_WITH_AUTHOR);
  });
});
