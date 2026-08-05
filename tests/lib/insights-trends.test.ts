import { describe, expect, it } from "vitest";
import { rangeWindow } from "@/dashboard/range";
import type { InsightFact } from "@/insights/facts";
import {
  compareBy,
  ratingTrend,
  sentimentMix,
  sentimentTrend,
  staffMentions,
  themeTrends,
  trendBuckets,
  volumeTrend,
} from "@/insights/trends";

/**
 * The arithmetic behind the Insights page (P3-T4).
 *
 * These are the numbers a business looks at to decide whether a branch is
 * getting worse — so "it looked about right on screen" is not verification.
 * Every figure is computed here from facts written out by hand, where the
 * expected answer can be worked out on paper.
 *
 * The cases that matter most are the empty ones. A quiet week is the normal
 * state of a small business, and the tempting bug in every function here is to
 * report absence as zero: a week with no reviews scoring 0.0 stars draws a
 * cliff, and a branch nobody rated shown as "0.0★, down 4.6" is a lie about a
 * real place.
 */

const NOW = new Date("2026-08-01T00:00:00.000Z");

const fact = (overrides: Partial<InsightFact> = {}): InsightFact => ({
  reviewId: crypto.randomUUID(),
  at: new Date("2026-07-31T12:00:00.000Z"),
  locationId: "loc-1",
  source: "google",
  rating: 5,
  sentiment: "positive",
  sentimentScore: 0.8,
  topics: ["service"],
  staff: [],
  staffAnalysed: true,
  repliedAt: null,
  ...overrides,
});

/** Days before `NOW`, at midday so a bucket boundary is never ambiguous. */
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000 + 12 * 3600 * 1000);

const window7 = rangeWindow("7d", NOW);
const window90 = rangeWindow("90d", NOW);

describe("how the range is cut up", () => {
  it("uses daily buckets for a week and weekly ones for a quarter", () => {
    expect(trendBuckets(window7)).toHaveLength(7);
    // 90 days at seven days a bucket. Thirteen points is a shape; ninety is a
    // barcode for a business receiving two reviews a day.
    expect(trendBuckets(window90)).toHaveLength(13);
  });

  it("ends the last bucket exactly at the end of the range", () => {
    const buckets = trendBuckets(window7);
    expect(buckets.at(-1)!.end.getTime()).toBe(window7.end.getTime());
  });

  it("covers the range with no gap and no overlap", () => {
    const buckets = trendBuckets(window7);

    for (let index = 1; index < buckets.length; index += 1) {
      expect(buckets[index]!.start.getTime()).toBe(buckets[index - 1]!.end.getTime());
    }
    expect(buckets[0]!.start.getTime()).toBeGreaterThanOrEqual(window7.start.getTime());
  });
});

describe("the rating trend", () => {
  /**
   * A **trailing** average: each point is the week ending at it, not the
   * bucket's own reviews. The reason is a complaint about the first version —
   * a per-bucket line on a business with reviews on a minority of days is a
   * scatter of disconnected fragments. Home settled this first; these are the
   * assertions that keep the two charts smoothing the same way.
   */
  it("averages the week ending at each point, so one review lights several", () => {
    // Two reviews yesterday (4 and 5) and one three days ago (2). Every point
    // whose trailing week reaches them has a value — a continuous line, and
    // every value a real average of real reviews.
    const points = ratingTrend(
      [
        fact({ at: daysAgo(1), rating: 4 }),
        fact({ at: daysAgo(1), rating: 5 }),
        fact({ at: daysAgo(3), rating: 2 }),
      ],
      [],
      window7,
    );

    // Once the trailing week reaches the 2-star review the line starts; once it
    // also reaches yesterday's pair it lifts. Four consecutive points from
    // three reviews, where a per-bucket line would have drawn two fragments.
    const values = points.map((point) => point.value).filter((value) => value !== null);
    expect(values).toEqual([2, 2, 3.67, 3.67]);
  });

  it("never joins across a span that really is empty", () => {
    // Smoothing is not the same as inventing. A trailing week with nothing in
    // it stays null, so the line still breaks where a business genuinely went
    // quiet — it just stops breaking between two ordinary days.
    const points = ratingTrend([fact({ at: daysAgo(1), rating: 5 })], [], window7);

    expect(points.filter((point) => point.value === null).length).toBeGreaterThan(0);
    expect(points.some((point) => point.value === 0)).toBe(false);
  });

  it("reaches into the previous window, so the first point is not starved", () => {
    // Without this the earliest points average over however little of the range
    // precedes them and dip for a reason that is not about the business. The
    // previous window is already loaded for the deltas, so it costs no query.
    const points = ratingTrend([], [fact({ at: daysAgo(8), rating: 3 })], window7);

    expect(points[0]!.value).toBe(3);
  });

  it("counts the bucket's own reviews, even though it averages a week", () => {
    // The value is deliberately the smoother number; the count is not, because
    // "how many arrived here" is what a reader hovering a point is asking.
    const at = daysAgo(1);
    const points = ratingTrend([fact({ at, rating: 5 })], [], window7);

    // Found by date rather than by index: the range ends at the *end* of today,
    // so "yesterday" is not the last bucket and an index would encode that.
    const own = points.find((point) => at >= point.start && at < point.end)!;
    expect(own.count).toBe(1);

    // Every other bucket counts nothing, while several still carry a value.
    expect(points.filter((point) => point.count > 0)).toHaveLength(1);
    expect(points.filter((point) => point.value !== null).length).toBeGreaterThan(1);
  });

  it("does not treat an unrated review as a zero-star one", () => {
    // A comment or a mention carries no stars. Averaging it in as 0 would drag
    // a five-star week to 2.5.
    const points = ratingTrend(
      [fact({ at: daysAgo(1), rating: 5 }), fact({ at: daysAgo(1), rating: null })],
      [],
      window7,
    );

    expect(points.at(-1)!.value).toBe(5);
  });
});

describe("the sentiment trend", () => {
  it("averages the model's score rather than the share of positives", () => {
    const points = sentimentTrend(
      [fact({ at: daysAgo(1), sentimentScore: 1 }), fact({ at: daysAgo(1), sentimentScore: 0 })],
      [],
      window7,
    );

    expect(points.at(-1)!.value).toBe(0.5);
  });

  it("ignores reviews that have not been analysed yet", () => {
    const points = sentimentTrend(
      [
        fact({ at: daysAgo(1), sentimentScore: 0.5 }),
        fact({ at: daysAgo(1), sentiment: null, sentimentScore: null }),
      ],
      [],
      window7,
    );

    expect(points.at(-1)!.value).toBe(0.5);
  });
});

describe("the volume trend", () => {
  it("counts an empty bucket as zero, because that is a real measurement", () => {
    // The exception to the null rule, and worth stating: "no reviews arrived"
    // is a fact about the week. "The rating was nought" is not.
    const points = volumeTrend([fact({ at: daysAgo(1) })], window7);

    expect(points.every((point) => point.value !== null)).toBe(true);
    expect(points.filter((point) => point.value === 0)).toHaveLength(6);
  });
});

describe("themes over time", () => {
  const current = [
    fact({ at: daysAgo(1), topics: ["waiting time"], sentiment: "negative" }),
    fact({ at: daysAgo(2), topics: ["waiting time"], sentiment: "negative" }),
    fact({ at: daysAgo(3), topics: ["waiting time"], sentiment: "neutral" }),
    fact({ at: daysAgo(1), topics: ["food"], sentiment: "positive" }),
    fact({ at: daysAgo(2), topics: ["food"], sentiment: "positive" }),
    fact({ at: daysAgo(3), topics: ["food"], sentiment: "positive" }),
    fact({ at: daysAgo(4), topics: ["food"], sentiment: "positive" }),
  ];
  const previous = [
    fact({ topics: ["waiting time"] }),
    ...Array.from({ length: 4 }, () => fact({ topics: ["food"] })),
  ];

  it("ranks by what moved, not by what is biggest", () => {
    // "food" is the larger theme and did not change; "waiting time" tripled.
    // A page that led with food would be reporting the weather.
    const trends = themeTrends(current, previous, window7);

    expect(trends[0]!.theme).toBe("waiting time");
    expect(trends[0]!.delta).toBe(200);
    expect(trends[1]!.theme).toBe("food");
    expect(trends[1]!.delta).toBe(0);
  });

  it("shows which way a theme is going, not only that it moved", () => {
    const [waiting] = themeTrends(current, previous, window7);

    expect(waiting).toMatchObject({ count: 3, negative: 2, neutral: 1, positive: 0 });
  });

  it("refuses a percentage against a base of nothing", () => {
    // Everything is up infinitely from zero, which is not a fact about a
    // business. Null, and the UI says "new".
    const [brandNew] = themeTrends([fact({ at: daysAgo(1), topics: ["parking"] })], [], window7);

    expect(brandNew!.delta).toBeNull();
    expect(brandNew!.count).toBe(1);
  });

  it("counts a review once per theme however often it says it", () => {
    const trends = themeTrends(
      [fact({ at: daysAgo(1), topics: ["food", "food", "service"] })],
      [],
      window7,
    );

    expect(trends.find((trend) => trend.theme === "food")!.count).toBe(1);
  });

  it("falls back to volume when nothing moved, so a flat page still says something", () => {
    const flat = [fact({ topics: ["a"] }), fact({ topics: ["b"] }), fact({ topics: ["b"] })];
    const trends = themeTrends(
      flat.map((f) => ({ ...f, at: daysAgo(1) })),
      flat,
      window7,
    );

    expect(trends.map((trend) => trend.theme)).toEqual(["b", "a"]);
  });
});

describe("comparing branches", () => {
  const current = [
    fact({ locationId: "a", rating: 5, repliedAt: new Date() }),
    fact({ locationId: "a", rating: 3, repliedAt: null }),
    fact({ locationId: "b", rating: 2, repliedAt: null }),
  ].map((f) => ({ ...f, at: daysAgo(1) }));

  const previous = [fact({ locationId: "a", rating: 4 }), fact({ locationId: "b", rating: 4 })];

  it("measures each branch on its own reviews", () => {
    const rows = compareBy(current, previous, (f) => f.locationId);
    const a = rows.find((row) => row.key === "a")!;

    expect(a.rating.value).toBe(4);
    expect(a.volume.value).toBe(2);
    expect(a.responseRate.value).toBe(0.5);
  });

  it("puts the busiest branch first, not the alphabetically first", () => {
    expect(compareBy(current, previous, (f) => f.locationId).map((row) => row.key)).toEqual([
      "a",
      "b",
    ]);
  });

  it("reports the change as a difference in stars, not a percentage of stars", () => {
    // 4.0 → 2.0 is "down 2 stars", not "down 50%". Reporting a rating like a
    // count is a classic dashboard lie.
    const b = compareBy(current, previous, (f) => f.locationId).find((row) => row.key === "b")!;

    expect(b.rating.previous).toBe(4);
    expect(b.rating.value).toBe(2);
    expect(b.rating.delta).toBe(-2);
  });

  it("gives a branch with nothing in the window a null rating, never a zero", () => {
    const rows = compareBy([], [fact({ locationId: "c", rating: 4 })], (f) => f.locationId);
    const c = rows.find((row) => row.key === "c")!;

    expect(c.rating.value).toBeNull();
    expect(c.volume.value).toBe(0);
    // And no delta, because there is nothing honest to compare.
    expect(c.rating.delta).toBeNull();
  });

  it("groups by source with the same function", () => {
    // The location table and the source table are one aggregate with a
    // different key, so they cannot drift apart.
    const rows = compareBy(current, previous, (f) => f.source);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("google");
  });
});

describe("who customers named", () => {
  it("counts mentions and what the reviews naming them said", () => {
    const { people } = staffMentions([
      fact({ staff: ["Ayşe"], sentiment: "positive", rating: 5 }),
      fact({ staff: ["Ayşe"], sentiment: "negative", rating: 2 }),
      fact({ staff: ["Mehmet"], sentiment: "positive", rating: 4 }),
    ]);

    expect(people[0]).toMatchObject({ name: "Ayşe", count: 2, positive: 1, negative: 1 });
    expect(people[0]!.rating).toBe(3.5);
  });

  it("treats one person spelled two ways as one person", () => {
    // Turkish casing, so a dotted capital does not split somebody in half.
    const { people } = staffMentions([
      fact({ staff: ["İlker"] }),
      fact({ staff: ["ilker"] }),
      fact({ staff: ["İLKER"] }),
    ]);

    expect(people).toHaveLength(1);
    // The first spelling seen is the one shown — a name is a person, not a key.
    expect(people[0]).toMatchObject({ name: "İlker", count: 3 });
  });

  it("distinguishes 'nobody was named' from 'we have not looked'", () => {
    // The distinction the whole `staffAnalysed` flag exists for. Reporting an
    // un-analysed corpus as a quiet one is a false negative a business would
    // act on.
    const summary = staffMentions([
      fact({ staff: [], staffAnalysed: true }),
      fact({ staff: [], staffAnalysed: false }),
      fact({ staff: [], staffAnalysed: false }),
    ]);

    expect(summary.people).toEqual([]);
    expect(summary.notAnalysed).toBe(2);
  });

  it("does not rank people by anything composite", () => {
    // Ordered by how often they were mentioned and nothing else. A score that
    // purported to rate an employee is not something this data can support.
    const { people } = staffMentions([
      fact({ staff: ["Quiet"], sentiment: "positive", rating: 5 }),
      fact({ staff: ["Busy"], sentiment: "negative", rating: 1 }),
      fact({ staff: ["Busy"], sentiment: "negative", rating: 1 }),
    ]);

    expect(people.map((person) => person.name)).toEqual(["Busy", "Quiet"]);
    expect(Object.keys(people[0]!).sort()).toEqual([
      "count",
      "name",
      "negative",
      "neutral",
      "positive",
      "rating",
    ]);
  });
});

describe("the sentiment mix", () => {
  it("states what has not been analysed rather than absorbing it", () => {
    const mix = sentimentMix([
      fact({ sentiment: "positive" }),
      fact({ sentiment: "negative" }),
      fact({ sentiment: null, sentimentScore: null }),
    ]);

    expect(mix).toMatchObject({ positive: 1, negative: 1, neutral: 0, analysed: 2, pending: 1 });
  });
});
