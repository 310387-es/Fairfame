import { describe, expect, it } from "vitest";
import {
  clusterThemes,
  computeChanges,
  computePulse,
  MIN_REVIEWS_FOR_PULSE,
  rawPulse,
  cosineSimilarity,
  openNegatives,
  priorWindow,
  THEME_MERGE_THRESHOLD,
  topReview,
  weekWindow,
  type WindowReview,
} from "@/digest/metrics";

/**
 * The computed half of the digest (P1a-T7).
 *
 * This is where "reproducible from stored data" is actually tested. Everything
 * here is a pure function of rows, so the same inputs must give the same
 * numbers — and the numbers are what the model is handed as fact, so an error
 * here becomes a confident false statement on the product's hero screen.
 */

function review(overrides: Partial<WindowReview> = {}): WindowReview {
  return {
    id: crypto.randomUUID(),
    rating: 5,
    text: "Bir yorum.",
    language: "tr",
    postedAt: new Date("2026-07-20T10:00:00Z"),
    sentiment: "positive",
    sentimentScore: 0.8,
    topics: ["servis"],
    // Free tags by default, so the existing cases keep exercising the
    // fallback path and the semantic merge that only the tail needs.
    themes: [],
    embedding: null,
    hasReply: false,
    ...overrides,
  };
}

/** A unit vector pointing along one axis, so similarity is predictable. */
function vector(axis: number, dimensions = 16): number[] {
  return Array.from({ length: dimensions }, (_, index) => (index === axis ? 1 : 0));
}

/** Label vectors, the input the clustering actually compares. */
function labels(entries: Record<string, number>): Map<string, number[]> {
  return new Map(Object.entries(entries).map(([slug, axis]) => [slug, vector(axis)]));
}

describe("the reputation pulse — the blend itself", () => {
  /**
   * `rawPulse` is the formula; `computePulse` is what a screen may show (W3.3).
   *
   * The split exists because the formula is meaningful on one review and the
   * *score* is not. These cases are about the arithmetic, so they use the raw
   * one; the floor and the smoothing that stand between it and a screen are
   * the block below.
   */
  it("is null when there is nothing to measure", () => {
    expect(rawPulse([])).toBeNull();
    expect(rawPulse([review({ rating: null, sentimentScore: null })])).toBeNull();
  });

  it("puts a perfect week at 100 and a terrible one at 0", () => {
    expect(rawPulse([review({ rating: 5, sentimentScore: 1 })])).toBe(100);
    expect(rawPulse([review({ rating: 1, sentimentScore: -1, sentiment: "negative" })])).toBe(0);
  });

  it("scores a rating-only week from the stars alone", () => {
    // A source that gives no text still moves the pulse; treating it as
    // unmeasurable would make a week of silent 1-stars read as "no change".
    expect(rawPulse([review({ rating: 3, sentimentScore: null, sentiment: null })])).toBe(50);
  });

  it("scores a text-only week from sentiment alone", () => {
    expect(rawPulse([review({ rating: null, sentimentScore: 0 })])).toBe(50);
  });

  it("lets sentiment pull down a five-star week", () => {
    // "Great, if you enjoy waiting an hour." The stars say 100; the words do
    // not, and an owner needs the pulse to notice.
    const glowing = rawPulse([review({ rating: 5, sentimentScore: 1 })]) ?? 0;
    const sarcastic =
      rawPulse([review({ rating: 5, sentimentScore: -0.8, sentiment: "negative" })]) ?? 0;

    expect(sarcastic).toBeLessThan(glowing);
    expect(sarcastic).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const reviews = [review({ rating: 4 }), review({ rating: 2, sentimentScore: -0.5 })];
    expect(rawPulse(reviews)).toBe(rawPulse([...reviews]));
  });
});

/**
 * What a screen is allowed to show (W3.3).
 *
 * The audit found the same reputation rendered as 70, 72.3, 63/100 and 4/100.
 * Part of that was a broken fixture and part was the decimal, but the part that
 * mattered is this: on a small business the raw blend is not a measurement. A
 * café with three reviews sees a number swing twenty points on one indifferent
 * visit, and a metric that behaves like that teaches people to ignore it.
 */
describe("the reputation pulse — what a screen may show", () => {
  const many = (count: number, rating: number) =>
    Array.from({ length: count }, () => review({ rating, sentimentScore: null, sentiment: null }));

  it("refuses to score a sample too small to mean anything", () => {
    // Not a low score — no score. "3 reviews say 40/100" is a sentence about
    // three people, dressed up as a sentence about a business.
    expect(computePulse(many(MIN_REVIEWS_FOR_PULSE - 1, 5))).toBeNull();
    expect(computePulse(many(MIN_REVIEWS_FOR_PULSE, 5))).toBe(100);
  });

  it("scores a small sample once there is a baseline to lean on", () => {
    // With a prior there is something to smooth toward, so a short window is
    // usable — that is the whole point of the smoothing.
    expect(computePulse(many(2, 5), { prior: 50 })).not.toBeNull();
  });

  it("pulls a short window toward the longer run", () => {
    /**
     * Two reviews at five stars is 100 raw. Against a baseline of 50, the
     * smoothed figure is `(2·100 + 10·50) / 12 ≈ 58` — much closer to the
     * business's own history than to a fortnight's luck.
     */
    expect(computePulse(many(2, 5), { prior: 50 })).toBe(58);
  });

  it("lets a large window speak for itself", () => {
    // A hundred reviews outweigh a ten-review pseudo-count, so the baseline
    // barely moves it. Smoothing must not flatten a real change.
    const smoothed = computePulse(many(100, 5), { prior: 50 }) ?? 0;
    expect(smoothed).toBeGreaterThan(90);
  });

  it("shows whole numbers, because the measurement has no decimal in it", () => {
    // "72,4" invites somebody to care about the 0,4, which is one indifferent
    // review either way — and it is half of why one reputation read as 70 on
    // one screen and 72.3 on another.
    const score = computePulse(many(11, 4), { prior: 61.7 });
    expect(score).not.toBeNull();
    expect(Number.isInteger(score)).toBe(true);
  });

  it("never leaves the scale, however extreme the baseline", () => {
    expect(computePulse(many(12, 5), { prior: 200 })).toBeLessThanOrEqual(100);
    expect(computePulse(many(12, 1), { prior: -50 })).toBeGreaterThanOrEqual(0);
  });
});

describe("theme clustering", () => {
  it("groups reviews by the model's own words", () => {
    const themes = clusterThemes([
      review({ topics: ["servis"] }),
      review({ topics: ["servis"] }),
      review({ topics: ["fiyat"] }),
    ]);

    expect(themes[0]?.label).toBe("servis");
    expect(themes[0]?.reviewCount).toBe(2);
    expect(themes).toHaveLength(2);
  });

  it("merges the same theme across languages", () => {
    // The reason embeddings are in this schema. The corpus produces `personel`
    // and `staff` as separate themes for one concern, because topics come out
    // in the review's own language.
    const themes = clusterThemes(
      [
        review({ topics: ["personel"] }),
        review({ topics: ["personel"] }),
        review({ topics: ["staff"] }),
      ],
      { labelVectors: labels({ personel: 0, staff: 0 }) },
    );

    expect(themes).toHaveLength(1);
    expect(themes[0]?.label).toBe("personel");
    expect(themes[0]?.slugs).toEqual(expect.arrayContaining(["personel", "staff"]));
    expect(themes[0]?.reviewCount).toBe(3);
  });

  it("labels a merged cluster with the larger slug", () => {
    const themes = clusterThemes(
      [
        review({ topics: ["staff"] }),
        review({ topics: ["personel"] }),
        review({ topics: ["personel"] }),
        review({ topics: ["personel"] }),
      ],
      { labelVectors: labels({ personel: 0, staff: 0 }) },
    );

    expect(themes[0]?.label).toBe("personel");
  });

  it("does not merge unrelated themes", () => {
    const themes = clusterThemes(
      [review({ topics: ["servis"] }), review({ topics: ["otopark"] })],
      { labelVectors: labels({ servis: 0, otopark: 5 }) },
    );

    // Orthogonal vectors: similarity 0, far below the threshold. A wrongly
    // merged theme is a lie about what customers said.
    expect(themes).toHaveLength(2);
  });

  it("leaves a theme unmerged when no label vectors are available", () => {
    const themes = clusterThemes([review({ topics: ["personel"] }), review({ topics: ["staff"] })]);

    // Untidy beats wrong: with nothing to compare, no merge is claimed.
    expect(themes).toHaveLength(2);
  });

  it("counts sentiment within a theme", () => {
    const themes = clusterThemes([
      review({ topics: ["servis"], sentiment: "negative", sentimentScore: -0.9 }),
      review({ topics: ["servis"], sentiment: "positive", sentimentScore: 0.9 }),
      review({ topics: ["servis"], sentiment: "neutral", sentimentScore: 0 }),
    ]);

    expect(themes[0]).toMatchObject({ positive: 1, negative: 1, neutral: 1 });
    expect(themes[0]?.averageSentiment).toBe(0);
  });

  it("returns review ids as evidence, newest first", () => {
    const older = review({
      topics: ["servis"],
      postedAt: new Date("2026-07-18T10:00:00Z"),
    });
    const newer = review({
      topics: ["servis"],
      postedAt: new Date("2026-07-21T10:00:00Z"),
    });

    const themes = clusterThemes([older, newer]);
    expect(themes[0]?.reviewIds).toEqual([newer.id, older.id]);
  });

  it("is deterministic across runs", () => {
    const reviews = [
      review({ topics: ["servis"] }),
      review({ topics: ["fiyat"] }),
      review({ topics: ["servis"] }),
    ];
    const labelVectors = labels({ servis: 0, fiyat: 3 });

    expect(clusterThemes(reviews, { labelVectors })).toEqual(
      clusterThemes([...reviews], { labelVectors }),
    );
  });

  it("does not chain unrelated themes through an intermediate", () => {
    // A~B and B~C must not drag A and C together. Averaging a running centroid
    // after each merge is what let one theme swallow 50 slugs over a
    // 57-review window in the first live run.
    const near = (axis: number, tilt: number) => {
      const values = new Array<number>(16).fill(0);
      values[axis] = 1;
      values[axis + 1] = tilt;
      const magnitude = Math.hypot(...values);
      return values.map((value) => value / magnitude);
    };

    const themes = clusterThemes(
      [
        review({ topics: ["a"] }),
        review({ topics: ["a"] }),
        review({ topics: ["b"] }),
        review({ topics: ["c"] }),
      ],
      {
        // a~b = 0.8, b~c = 0.8, a~c = 0.28 — b bridges them, and must not.
        labelVectors: new Map([
          ["a", near(0, 0)],
          ["b", near(0, 0.75)],
          ["c", [0, 1, 0, ...new Array<number>(13).fill(0)]],
        ]),
        threshold: 0.75,
      },
    );

    expect(themes.find((theme) => theme.slugs.includes("c"))?.slugs).toEqual(["c"]);
  });

  it("uses a threshold inside the measured gap", () => {
    // Real gemini-embedding-2: the weakest true positive is
    // `temizlik ~ cleanliness` at 0.800 and the strongest false positive is
    // `temizlik ~ yemek` at 0.753. The threshold must sit between them.
    expect(THEME_MERGE_THRESHOLD).toBeGreaterThan(0.753);
    expect(THEME_MERGE_THRESHOLD).toBeLessThan(0.8);
    expect(cosineSimilarity(vector(0), vector(0))).toBe(1);
    expect(cosineSimilarity(vector(0), vector(1))).toBe(0);
  });
});

describe("what changed", () => {
  const noThemes = { themes: [], priorThemes: [] };

  it("reports nothing when the week was flat", () => {
    const changes = computeChanges({
      pulse: 70,
      priorPulse: 70.5,
      reviewCount: 10,
      priorReviewCount: 10,
      ...noThemes,
    });

    // A briefing that reports noise trains the reader to skim it.
    expect(changes).toEqual([]);
  });

  it("reports a real pulse move with a direction", () => {
    const [change] = computeChanges({
      pulse: 60,
      priorPulse: 75,
      reviewCount: 5,
      priorReviewCount: 5,
      ...noThemes,
    });

    expect(change?.kind).toBe("pulse");
    expect(change?.direction).toBe(-1);
    expect(change?.detail).toMatchObject({ from: 75, to: 60, delta: -15 });
  });

  it("reports a volume swing", () => {
    const changes = computeChanges({
      pulse: 70,
      priorPulse: 70,
      reviewCount: 20,
      priorReviewCount: 10,
      ...noThemes,
    });

    expect(changes.some((change) => change.kind === "volume")).toBe(true);
  });

  it("flags a theme that did not exist last week", () => {
    const changes = computeChanges({
      pulse: null,
      priorPulse: null,
      reviewCount: 3,
      priorReviewCount: 3,
      themes: [
        {
          label: "otopark",
          slugs: ["otopark"],
          reviewCount: 3,
          positive: 0,
          negative: 3,
          neutral: 0,
          averageSentiment: -0.8,
          reviewIds: [],
        },
      ],
      priorThemes: [],
    });

    expect(changes[0]).toMatchObject({
      kind: "theme",
      direction: -1,
      detail: { label: "otopark", status: "new" },
    });
  });

  it("ignores a brand-new theme with a single mention", () => {
    const changes = computeChanges({
      pulse: null,
      priorPulse: null,
      reviewCount: 1,
      priorReviewCount: 1,
      themes: [
        {
          label: "müzik",
          slugs: ["müzik"],
          reviewCount: 1,
          positive: 0,
          negative: 1,
          neutral: 0,
          averageSentiment: -0.5,
          reviewIds: [],
        },
      ],
      priorThemes: [],
    });

    // One opinion is not a trend.
    expect(changes).toEqual([]);
  });

  it("says nothing about volume when there is no prior week", () => {
    const changes = computeChanges({
      pulse: 80,
      priorPulse: null,
      reviewCount: 12,
      priorReviewCount: 0,
      ...noThemes,
    });

    expect(changes).toEqual([]);
  });
});

describe("assets", () => {
  it("finds unanswered negatives, newest first", () => {
    const answered = review({ rating: 1, sentiment: "negative", hasReply: true });
    const old = review({
      rating: 2,
      sentiment: "negative",
      postedAt: new Date("2026-07-18T10:00:00Z"),
    });
    const fresh = review({
      rating: 1,
      sentiment: "negative",
      postedAt: new Date("2026-07-21T10:00:00Z"),
    });

    const found = openNegatives([answered, old, fresh]);

    expect(found.map((row) => row.id)).toEqual([fresh.id, old.id]);
  });

  it("counts a low rating as negative even without sentiment", () => {
    const found = openNegatives([review({ rating: 2, sentiment: null, sentimentScore: null })]);
    expect(found).toHaveLength(1);
  });

  it("skips a rating-only review, which has nothing to reply to", () => {
    expect(openNegatives([review({ rating: 1, sentiment: "negative", text: null })])).toEqual([]);
  });

  it("picks the most enthusiastic substantial review for a social post", () => {
    const short = review({ text: "Harika!", sentimentScore: 1 });
    const good = review({
      text: "Kahvaltı tabağı beklediğimden çok daha zengindi ve personel gerçekten ilgiliydi.",
      sentimentScore: 0.9,
    });

    // A glowing one-liner makes a thin post; specificity is what is worth
    // sharing.
    expect(topReview([short, good])?.id).toBe(good.id);
  });

  it("returns nothing when the week held no praise", () => {
    expect(
      topReview([review({ rating: 1, sentiment: "negative", sentimentScore: -0.9 })]),
    ).toBeNull();
  });
});

describe("the weekly window", () => {
  it("covers the last completed Monday-to-Monday week", () => {
    // Wednesday 22 July 2026.
    const { start, end } = weekWindow(new Date("2026-07-22T14:30:00Z"));

    // A digest generated mid-week reports the finished week, not three days of
    // the current one.
    expect(start.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("treats Monday itself as the start of a fresh week", () => {
    const { start, end } = weekWindow(new Date("2026-07-20T00:00:01Z"));
    expect(start.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("handles Sunday without rolling into the next week", () => {
    const { start, end } = weekWindow(new Date("2026-07-19T23:59:59Z"));
    expect(start.toISOString()).toBe("2026-07-06T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("produces an adjoining prior window with no gap or overlap", () => {
    const window = weekWindow(new Date("2026-07-22T14:30:00Z"));
    const prior = priorWindow(window);

    expect(prior.end.toISOString()).toBe(window.start.toISOString());
    expect(prior.start.toISOString()).toBe("2026-07-06T00:00:00.000Z");
  });
});
