import { describe, expect, it } from "vitest";
import type { DashboardFacts, ReviewFact } from "@/dashboard/facts";
import {
  computeBranches,
  computeKpis,
  computeRatingDistribution,
  computeResponseDistribution,
  computeResponseTimes,
  computeSentiment,
  computeSeries,
  computeSources,
  computeThemes,
  isImprovement,
  MIN_PERCENT_BASE,
} from "@/dashboard/metrics";
import { rangeWindow, SPARKLINE_BUCKETS } from "@/dashboard/range";
import { computePulse, rawPulse } from "@/digest/metrics";

/**
 * The four headline numbers.
 *
 * Every one of them is a claim about a business's reputation that an owner may
 * act on, so the cases below are the ones where a plausible implementation
 * quietly lies: percentages of percentages, deltas from an empty period, and
 * gaps rendered as zero.
 */

const NOW = new Date("2026-08-03T12:00:00Z");
const WINDOW = rangeWindow("30d", NOW);

let counter = 0;

function fact(overrides: Partial<ReviewFact> & { at: Date }): ReviewFact {
  counter += 1;

  return {
    reviewId: `review-${counter}`,
    // Everything in a single-branch fixture belongs to the same branch; the
    // per-branch tests build their own facts with real ids (W4.3).
    locationId: "branch-1",
    source: "google",
    itemType: "review",
    rating: null,
    sentiment: null,
    sentimentScore: null,
    topics: [],
    themes: [],
    repliedAt: null,
    ...overrides,
  };
}

/** `hours(at, 3)` is three hours after `at`. */
function hours(from: Date, count: number): Date {
  return new Date(from.getTime() + count * 60 * 60 * 1_000);
}

/** `daysAgo(1)` is inside the window; `daysAgo(40)` is in the previous one. */
function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000);
}

function facts(current: ReviewFact[], previous: ReviewFact[] = []): DashboardFacts {
  // The ninety-day baseline the reputation score is smoothed toward (W3.3).
  // Both windows together is what a fixture has; a real load reaches further.
  return { current, previous, baseline: [...current, ...previous] };
}

describe("average rating", () => {
  it("is rounded to the precision the card shows", () => {
    // 3.4666… displays as 3,5. Carrying more precision than that into the
    // delta produced "3,5 stars, up 0,35" — a comparison that cannot be
    // reconciled with the two numbers it sits between.
    const kpis = computeKpis(
      facts([
        fact({ at: daysAgo(1), rating: 4 }),
        fact({ at: daysAgo(2), rating: 3 }),
        fact({ at: daysAgo(3), rating: 3 }),
      ]),
      WINDOW,
    );

    expect(kpis.rating.value).toBe(3.3);
  });

  it("keeps the delta reconcilable with the values on screen", () => {
    const kpis = computeKpis(
      facts(
        [fact({ at: daysAgo(1), rating: 4 }), fact({ at: daysAgo(2), rating: 3 })],
        [fact({ at: daysAgo(40), rating: 3 }), fact({ at: daysAgo(41), rating: 3 })],
      ),
      WINDOW,
    );

    expect(kpis.rating.value! - kpis.rating.previous!).toBeCloseTo(kpis.rating.delta!, 10);
  });

  it("averages only the rated items", () => {
    // A comment carries no stars — the schema forbids it — and counting it as
    // zero would drag the average toward the floor.
    const kpis = computeKpis(
      facts([
        fact({ at: daysAgo(1), rating: 5 }),
        fact({ at: daysAgo(2), rating: 4 }),
        fact({ at: daysAgo(3), itemType: "comment", rating: null }),
      ]),
      WINDOW,
    );

    expect(kpis.rating.value).toBe(4.5);
  });

  it("reports nothing rather than zero when nothing was rated", () => {
    const kpis = computeKpis(facts([fact({ at: daysAgo(1), itemType: "comment" })]), WINDOW);

    // 0.0 stars would be a false claim; the card shows an em dash instead.
    expect(kpis.rating.value).toBeNull();
    expect(kpis.rating.delta).toBeNull();
  });

  it("compares against the previous period as a difference, not a percentage", () => {
    const kpis = computeKpis(
      facts([fact({ at: daysAgo(1), rating: 5 })], [fact({ at: daysAgo(40), rating: 4 })]),
      WINDOW,
    );

    // 4 → 5 stars is "up 1.0", never "up 25%".
    expect(kpis.rating.delta).toBe(1);
    expect(kpis.rating.unit).toBe("rating");
  });
});

describe("volume", () => {
  it("counts every item, not only star reviews", () => {
    // The source breakdown lists Instagram comments; excluding them here would
    // make two widgets on one screen disagree about how much came in.
    const kpis = computeKpis(
      facts([
        fact({ at: daysAgo(1), rating: 5 }),
        fact({ at: daysAgo(2), itemType: "comment", source: "instagram" }),
        fact({ at: daysAgo(3), itemType: "mention", source: "instagram" }),
      ]),
      WINDOW,
    );

    expect(kpis.volume.value).toBe(3);
  });

  it("reports a count as a percentage change, off a base worth dividing by", () => {
    const before = Array.from({ length: 6 }, (_, index) => fact({ at: daysAgo(40 + index) }));
    const now = Array.from({ length: 9 }, (_, index) => fact({ at: daysAgo(1 + index) }));

    const kpis = computeKpis(facts(now, before), WINDOW);

    expect(kpis.volume.value).toBe(9);
    expect(kpis.volume.delta).toBe(50);
  });

  /**
   * A22-C5 — a percentage off a handful is theatre.
   *
   * One review last month and seven this month is not "+600%": it is the same
   * headline two-to-fourteen would print, and one more review would move it
   * another hundred points. The pair — 1 → 7 — is what a café owner can use,
   * and the KPI already carries `previous` for the card to render it.
   */
  it("withholds the percentage below a base worth dividing by", () => {
    const kpis = computeKpis(
      facts(
        Array.from({ length: 7 }, (_, index) => fact({ at: daysAgo(1 + index) })),
        [fact({ at: daysAgo(40) })],
      ),
      WINDOW,
    );

    expect(kpis.volume.value).toBe(7);
    expect(kpis.volume.previous).toBe(1);
    // Withheld, not zero: the card shows "1 → 7" where the percentage was.
    expect(kpis.volume.delta).toBeNull();
  });

  it("still reports one at the threshold, so the rule has an edge rather than a fade", () => {
    const before = Array.from({ length: MIN_PERCENT_BASE }, (_, index) =>
      fact({ at: daysAgo(40 + index) }),
    );
    const now = Array.from({ length: MIN_PERCENT_BASE * 2 }, (_, index) =>
      fact({ at: daysAgo(1 + index) }),
    );

    expect(computeKpis(facts(now, before), WINDOW).volume.delta).toBe(100);
  });

  it("withholds the delta when the previous period was empty", () => {
    // 0 → 5 is not "500% up". There is no percentage from nothing, and
    // inventing one puts an impressive, meaningless number on the page.
    const kpis = computeKpis(facts([fact({ at: daysAgo(1) })], []), WINDOW);

    expect(kpis.volume.value).toBe(1);
    expect(kpis.volume.delta).toBeNull();
  });
});

describe("response rate", () => {
  it("is the share with a published reply", () => {
    const kpis = computeKpis(
      facts([
        fact({ at: daysAgo(1), repliedAt: daysAgo(1) }),
        fact({ at: daysAgo(2), repliedAt: daysAgo(2) }),
        fact({ at: daysAgo(3) }),
        fact({ at: daysAgo(4) }),
      ]),
      WINDOW,
    );

    expect(kpis.responseRate.value).toBe(50);
  });

  it("moves in points, not percent of a percent", () => {
    const kpis = computeKpis(
      facts(
        [fact({ at: daysAgo(1), repliedAt: daysAgo(1) }), fact({ at: daysAgo(2) })],
        [
          fact({ at: daysAgo(40), repliedAt: daysAgo(40) }),
          fact({ at: daysAgo(41), repliedAt: daysAgo(41) }),
          fact({ at: daysAgo(42), repliedAt: daysAgo(42) }),
          fact({ at: daysAgo(43) }),
        ],
      ),
      WINDOW,
    );

    // 75% → 50% is a fall of 25 points. Reported as a percentage change it
    // would read "down 33%", which is a different and wronger claim.
    expect(kpis.responseRate.value).toBe(50);
    expect(kpis.responseRate.previous).toBe(75);
    expect(kpis.responseRate.delta).toBe(-25);
  });
});

describe("reputation", () => {
  it("is the digest's own pulse, computed once", () => {
    const rows = [
      fact({ at: daysAgo(1), rating: 5, sentimentScore: 0.8 }),
      fact({ at: daysAgo(2), rating: 2, sentimentScore: -0.6 }),
    ];

    /**
     * Home and the digest must never report two different scores for the same
     * reviews, so this asserts identity with the shared function rather than a
     * hard-coded number that could drift from it.
     *
     * The prior is passed explicitly because that is what the dashboard does
     * (W3.3): the score is smoothed toward the ninety-day baseline, and
     * comparing against the *unsmoothed* blend would assert that Home ignores
     * the smoothing — the opposite of what this test is for.
     */
    const prior = rawPulse(rows);
    expect(computeKpis(facts(rows), WINDOW).reputation.value).toBe(computePulse(rows, { prior }));
  });
});

describe("sparklines", () => {
  it("has one point per bucket, whatever the range", () => {
    const kpis = computeKpis(facts([fact({ at: daysAgo(1), rating: 5 })]), WINDOW);

    expect(kpis.rating.spark).toHaveLength(SPARKLINE_BUCKETS);
  });

  it("leaves a quiet bucket empty rather than calling it zero", () => {
    // One review, 30-day window: only the last bucket has data. A zero in the
    // other six would draw a rating that collapsed and recovered.
    const kpis = computeKpis(facts([fact({ at: daysAgo(1), rating: 5 })]), WINDOW);

    expect(kpis.rating.spark.filter((point) => point !== null)).toEqual([5]);
    expect(kpis.rating.spark.at(-1)).toBe(5);
  });

  it("counts zero for a quiet bucket, because none is a real count", () => {
    // Volume differs from rating on purpose: "no reviews that week" is a fact
    // worth drawing, while "no rating that week" is an absence of evidence.
    const kpis = computeKpis(facts([fact({ at: daysAgo(1) })]), WINDOW);

    expect(kpis.volume.spark.filter((point) => point === 0)).toHaveLength(SPARKLINE_BUCKETS - 1);
  });

  it("puts each review in exactly one bucket", () => {
    const rows = Array.from({ length: 30 }, (_, index) => fact({ at: daysAgo(index) }));
    const kpis = computeKpis(facts(rows), WINDOW);

    const total = kpis.volume.spark.reduce<number>((sum, point) => sum + (point ?? 0), 0);
    expect(total).toBe(30);
  });
});

describe("direction", () => {
  it("says nothing when there is nothing to say", () => {
    const kpis = computeKpis(facts([fact({ at: daysAgo(1) })], []), WINDOW);

    expect(isImprovement(kpis.volume)).toBeNull();
  });

  it("reads a flat delta as neither better nor worse", () => {
    const kpis = computeKpis(
      facts([fact({ at: daysAgo(1), rating: 4 })], [fact({ at: daysAgo(40), rating: 4 })]),
      WINDOW,
    );

    expect(kpis.rating.delta).toBe(0);
    expect(isImprovement(kpis.rating)).toBeNull();
  });
});

describe("the reputation series", () => {
  it("has one point per chart bucket", () => {
    expect(computeSeries(facts([]), rangeWindow("7d", NOW))).toHaveLength(7);
    expect(computeSeries(facts([]), rangeWindow("30d", NOW))).toHaveLength(30);
    expect(computeSeries(facts([]), rangeWindow("90d", NOW))).toHaveLength(13);
  });

  it("carries one review across the trailing span instead of drawing a fragment", () => {
    // Ten days back, so the full trailing span fits inside the window.
    const series = computeSeries(facts([fact({ at: daysAgo(10), rating: 4 })]), WINDOW);

    // One review, 30 daily buckets. Raw, that is a single point and an
    // invisible line; over a 7-day trailing span it is a readable stretch —
    // and every one of those points is the same real 4.0, not an invention.
    const drawn = series.filter((point) => point.rating !== null);

    expect(drawn).toHaveLength(7);
    expect(drawn.every((point) => point.rating === 4)).toBe(true);

    // Volume stays exact: the bar is the day's own count, not a smoothed one.
    expect(series.filter((point) => point.volume === 0)).toHaveLength(29);
  });

  it("still reports nothing when the whole trailing week is empty", () => {
    const series = computeSeries(facts([fact({ at: daysAgo(1), rating: 4 })]), WINDOW);

    // Smoothing must not become fabrication: three weeks before the only
    // review, there is nothing to average.
    expect(series[0]?.rating).toBeNull();
  });

  it("reaches back before the range so the first points are not thin", () => {
    // A review from the previous period still informs the opening days of the
    // chart. Without this the first week of every range averaged over whatever
    // little of it had happened yet, and jumped when the window filled up.
    const series = computeSeries(
      facts([], [fact({ at: daysAgo(32), rating: 4 })]),
      rangeWindow("30d", NOW),
    );

    expect(series[0]?.rating).toBe(4);
    // And it stops mattering once a week has passed.
    expect(series[8]?.rating).toBeNull();
  });

  it("leaves no hole mid-line on the short range", () => {
    // The 7-day view's actual failure: reviews on Tuesday, nothing until
    // Saturday, and a three-day window left Friday empty — a break in the
    // middle of a seven-point line.
    const series = computeSeries(
      facts([fact({ at: daysAgo(6), rating: 2 }), fact({ at: daysAgo(1), rating: 4 })]),
      rangeWindow("7d", NOW),
    );

    expect(series.every((point) => point.rating !== null)).toBe(true);
  });

  it("averages the span rather than repeating the last value", () => {
    const series = computeSeries(
      facts([fact({ at: daysAgo(1), rating: 2 }), fact({ at: daysAgo(2), rating: 4 })]),
      WINDOW,
    );

    expect(series.at(-1)?.rating).toBe(3);
  });

  it("puts every review in exactly one bucket", () => {
    const rows = Array.from({ length: 30 }, (_, index) => fact({ at: daysAgo(index) }));
    const series = computeSeries(facts(rows), WINDOW);

    expect(series.reduce((sum, point) => sum + point.volume, 0)).toBe(30);
  });

  it("ignores the previous period", () => {
    // The chart plots the selected range only; the comparison window exists
    // for deltas, and drawing it would silently double the axis.
    const series = computeSeries(
      facts([fact({ at: daysAgo(1) })], [fact({ at: daysAgo(40) })]),
      WINDOW,
    );

    expect(series.reduce((sum, point) => sum + point.volume, 0)).toBe(1);
  });

  it("agrees with the volume KPI on the same facts", () => {
    const rows = [fact({ at: daysAgo(1) }), fact({ at: daysAgo(5) }), fact({ at: daysAgo(20) })];

    // The failure this guards against is the one nobody reports: a KPI saying
    // 128 above a chart that plots 126.
    const total = computeSeries(facts(rows), WINDOW).reduce((sum, p) => sum + p.volume, 0);
    expect(total).toBe(computeKpis(facts(rows), WINDOW).volume.value);
  });
});

describe("sentiment", () => {
  it("counts unanalysed items apart rather than as neutral", () => {
    const breakdown = computeSentiment(
      facts([
        fact({ at: daysAgo(1), sentiment: "positive" }),
        fact({ at: daysAgo(2), sentiment: "negative" }),
        fact({ at: daysAgo(3) }),
      ]),
    );

    // Analysis is asynchronous. Folding a pending review into "neutral" would
    // drag every donut toward the middle and make a bad week look calm.
    expect(breakdown.analysed).toBe(2);
    expect(breakdown.neutral).toBe(0);
    expect(breakdown.pending).toBe(1);
  });
});

describe("sources", () => {
  it("ranks by volume and scales bars against the busiest", () => {
    const rows = computeSources(
      facts([
        fact({ at: daysAgo(1), source: "google", rating: 5 }),
        fact({ at: daysAgo(2), source: "google", rating: 3 }),
        fact({ at: daysAgo(3), source: "instagram", itemType: "comment" }),
      ]),
    );

    expect(rows.map((row) => row.source)).toEqual(["google", "instagram"]);
    expect(rows[0]?.rating).toBe(4);
    expect(rows[0]?.share).toBe(1);
    expect(rows[1]?.share).toBe(0.5);
  });

  it("reports no rating for a source that carries none", () => {
    // Instagram comments have no stars; claiming an average would invent one.
    const rows = computeSources(
      facts([fact({ at: daysAgo(1), source: "instagram", itemType: "comment" })]),
    );

    expect(rows[0]?.rating).toBeNull();
  });

  it("lists only sources that sent something", () => {
    // A permanent "Trustpilot 0" row would be a product brochure, not a
    // breakdown of this location's week.
    expect(computeSources(facts([fact({ at: daysAgo(1), source: "google" })]))).toHaveLength(1);
  });
});

describe("themes", () => {
  it("colours a theme by how people felt, not how often they said it", () => {
    const rows = computeThemes(
      facts([
        fact({ at: daysAgo(1), sentiment: "negative", themes: ["service"] }),
        fact({ at: daysAgo(2), sentiment: "negative", themes: ["service"] }),
        fact({ at: daysAgo(3), sentiment: "positive", themes: ["service"] }),
        fact({ at: daysAgo(4), sentiment: "positive", themes: ["food_quality"] }),
      ]),
    );

    // "servis, 3 mentions" means something different from "kahve, 1 mention".
    expect(rows[0]?.slug).toBe("service");
    expect(rows[0]?.dominant).toBe("negative");
    expect(rows[1]?.dominant).toBe("positive");
  });

  it("calls an evenly split theme mixed", () => {
    const rows = computeThemes(
      facts([
        fact({ at: daysAgo(1), sentiment: "negative", themes: ["price"] }),
        fact({ at: daysAgo(2), sentiment: "positive", themes: ["price"] }),
      ]),
    );

    expect(rows[0]?.dominant).toBe("neutral");
  });
});

describe("rating distribution", () => {
  it("always has all five rungs", () => {
    const buckets = computeRatingDistribution(facts([fact({ at: daysAgo(1), rating: 5 })]));

    // A missing 2★ row reads as "no data", not as "nobody left two stars".
    expect(buckets.map((bucket) => bucket.rating)).toEqual([5, 4, 3, 2, 1]);
    expect(buckets.filter((bucket) => bucket.count === 0)).toHaveLength(4);
  });
});

describe("response time", () => {
  it("uses the median, so one late reply does not define the week", () => {
    const times = computeResponseTimes(
      facts([
        fact({ at: daysAgo(5), repliedAt: hours(daysAgo(5), 1) }),
        fact({ at: daysAgo(4), repliedAt: hours(daysAgo(4), 2) }),
        fact({ at: daysAgo(3), repliedAt: hours(daysAgo(3), 3) }),
        fact({ at: daysAgo(2), repliedAt: hours(daysAgo(2), 500) }),
      ]),
    );

    // Mean would be over two days; the typical wait was two and a half hours.
    expect(times.medianHours).toBe(2.5);
  });

  it("reports the share answered within a day", () => {
    const times = computeResponseTimes(
      facts([
        fact({ at: daysAgo(5), repliedAt: hours(daysAgo(5), 2) }),
        fact({ at: daysAgo(4), repliedAt: hours(daysAgo(4), 40) }),
      ]),
    );

    expect(times.withinDayShare).toBe(50);
  });

  it("says nothing when nothing was answered", () => {
    const times = computeResponseTimes(facts([fact({ at: daysAgo(1) })]));

    // "0h" would read as instant service rather than as no service.
    expect(times.medianHours).toBeNull();
    expect(times.withinDayShare).toBeNull();
  });

  it("clamps a reply that predates its review instead of going negative", () => {
    const times = computeResponseTimes(facts([fact({ at: daysAgo(1), repliedAt: daysAgo(2) })]));

    // Clock skew between a platform and us, not a reply sent before the review.
    expect(times.medianHours).toBe(0);
  });
});

describe("the response-time distribution (W4.3)", () => {
  const answered = (hours: number) =>
    fact({
      at: new Date("2026-08-01T00:00:00Z"),
      repliedAt: new Date(Date.parse("2026-08-01T00:00:00Z") + hours * 3_600_000),
    });

  const bucket = (rows: DashboardFacts, key: string) =>
    computeResponseDistribution(rows).find((entry) => entry.key === key);

  it("puts each wait in the bucket its promise belongs to", () => {
    const rows = facts([answered(0.5), answered(6), answered(48), answered(200)]);

    expect(bucket(rows, "under_hour")?.count).toBe(1);
    expect(bucket(rows, "under_day")?.count).toBe(1);
    expect(bucket(rows, "under_three_days")?.count).toBe(1);
    expect(bucket(rows, "slower")?.count).toBe(1);
  });

  it("counts the unanswered rather than leaving them out", () => {
    /**
     * The assertion the card exists for. A queue that never got a reply is the
     * worst response time there is, and a distribution drawn over answered
     * reviews only is the same flattery as measuring satisfaction among the
     * people who did not leave.
     */
    const rows = facts([answered(2), fact({ at: new Date("2026-08-01T00:00:00Z") })]);

    expect(bucket(rows, "unanswered")?.count).toBe(1);
    expect(bucket(rows, "unanswered")?.share).toBe(50);
  });

  it("keeps its empty buckets", () => {
    // A distribution missing them reads as a different shape entirely.
    expect(computeResponseDistribution(facts([answered(2)]))).toHaveLength(5);
  });

  it("treats a reply timestamped before its review as instant, not negative", () => {
    // Clock skew, clamped — the same rule `computeResponseTimes` applies.
    const skewed = fact({
      at: new Date("2026-08-01T10:00:00Z"),
      repliedAt: new Date("2026-08-01T09:00:00Z"),
    });

    expect(bucket(facts([skewed]), "under_hour")?.count).toBe(1);
  });

  it("shares nothing rather than dividing by zero", () => {
    for (const entry of computeResponseDistribution(facts([]))) {
      expect(entry.share).toBe(0);
      expect(entry.count).toBe(0);
    }
  });
});

describe("the branch comparison strip (W4.3)", () => {
  const at = (locationId: string, overrides: Partial<ReviewFact> = {}) =>
    fact({ at: new Date("2026-08-01T00:00:00Z"), locationId, ...overrides });

  it("slices the same facts the headline numbers were computed from", () => {
    /**
     * The whole reason `locationId` is carried on a fact. A per-branch query
     * would be a second definition of "this month's rating", and the two would
     * disagree the first time somebody changed one of them.
     */
    const rows = computeBranches(
      facts([at("a", { rating: 5 }), at("a", { rating: 3 }), at("b", { rating: 1 })]),
      ["a", "b"],
    );

    expect(rows[0]?.rating).toBe(4);
    expect(rows[1]?.rating).toBe(1);
    expect(rows[0]?.volume).toBe(2);
  });

  it("reports null, not zero, for a branch with nothing rated", () => {
    // A branch with no rated reviews did not score nought stars.
    const rows = computeBranches(facts([at("a", { rating: null })]), ["a"]);

    expect(rows[0]?.rating).toBeNull();
    expect(rows[0]?.ratingDelta).toBeNull();
    expect(rows[0]?.volume).toBe(1);
  });

  it("returns a row for a branch with nothing at all", () => {
    // Otherwise a quiet branch vanishes from the comparison, which is the one
    // reading a comparison must never allow.
    const rows = computeBranches(facts([at("a", { rating: 4 })]), ["a", "b"]);

    expect(rows).toHaveLength(2);
    expect(rows[1]?.volume).toBe(0);
    expect(rows[1]?.rating).toBeNull();
  });

  it("withholds a volume delta from zero", () => {
    // 0 → 5 is not "500% up", it is "five where there were none" — the same
    // rule `percentChange` applies to the headline KPI.
    const rows = computeBranches(facts([at("a"), at("a")], []), ["a"]);
    expect(rows[0]?.volumeDelta).toBeNull();
  });

  it("compares a branch against its own previous window", () => {
    const rows = computeBranches(
      facts([at("a", { rating: 5 })], [at("a", { rating: 3 }), at("b", { rating: 1 })]),
      ["a"],
    );

    expect(rows[0]?.ratingDelta).toBe(2);
  });

  it("counts a branch's unanswered and takes the median of what was answered", () => {
    const rows = computeBranches(
      facts([
        at("a", { repliedAt: new Date("2026-08-01T02:00:00Z") }),
        at("a", { repliedAt: new Date("2026-08-01T06:00:00Z") }),
        at("a"),
      ]),
      ["a"],
    );

    expect(rows[0]?.unanswered).toBe(1);
    expect(rows[0]?.medianResponseHours).toBe(4);
  });

  it("keeps the caller's order rather than sorting", () => {
    // Sorting here would fix an order the reader is meant to choose on screen.
    const rows = computeBranches(facts([at("a"), at("b"), at("b")]), ["b", "a"]);
    expect(rows.map((row) => row.locationId)).toEqual(["b", "a"]);
  });
});
