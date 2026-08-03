import { describe, expect, it } from "vitest";
import {
  chartBuckets,
  DEFAULT_RANGE,
  parseRange,
  RANGE_DAYS,
  RANGES,
  rangeWindow,
  splitWindow,
  SPARKLINE_BUCKETS,
  sparklineBuckets,
  type Window,
} from "@/dashboard/range";

/**
 * The dashboard's time scope.
 *
 * Every number on Home is computed against these windows, and an error here
 * would be invisible: the page would render confidently and be wrong by a day.
 * The cases below are the ones that decide whether two numbers on the same
 * screen can be compared at all — adjacency, exhaustiveness, and no overlap.
 */

/** Mid-month, mid-afternoon UTC, so nothing lands on a boundary by luck. */
const NOW = new Date("2026-08-03T14:32:11.500Z");

const DAY_MS = 24 * 60 * 60 * 1_000;

function days(window: { start: Date; end: Date }): number {
  return (window.end.getTime() - window.start.getTime()) / DAY_MS;
}

describe("reading the range from a URL", () => {
  it("takes the three it knows", () => {
    for (const range of RANGES) expect(parseRange(range)).toBe(range);
  });

  it("falls back rather than failing", () => {
    // A shared link with a typo, or one from a future version of the page,
    // must still render — the range decides which rows are read, so there is
    // no safe way to carry an unknown value forward.
    expect(parseRange("42d")).toBe(DEFAULT_RANGE);
    expect(parseRange("")).toBe(DEFAULT_RANGE);
    expect(parseRange(undefined)).toBe(DEFAULT_RANGE);
    expect(parseRange("7D")).toBe(DEFAULT_RANGE);
  });

  it("takes the first of a repeated parameter", () => {
    // `?range=7d&range=90d` reaches Next as an array.
    expect(parseRange(["7d", "90d"])).toBe("7d");
    expect(parseRange([])).toBe(DEFAULT_RANGE);
  });

  it("defaults to 30 days", () => {
    expect(DEFAULT_RANGE).toBe("30d");
  });
});

describe("the window", () => {
  it("spans exactly the range's days", () => {
    for (const range of RANGES) {
      expect(days(rangeWindow(range, NOW))).toBe(RANGE_DAYS[range]);
    }
  });

  it("ends at the end of today, so today is included", () => {
    const window = rangeWindow("30d", NOW);

    // Tomorrow 00:00 UTC — today counts, partially, which is what makes the
    // page live rather than a report about yesterday.
    expect(window.end.toISOString()).toBe("2026-08-04T00:00:00.000Z");
    expect(window.start.toISOString()).toBe("2026-07-05T00:00:00.000Z");
  });

  it("lands on day boundaries whatever the time of day", () => {
    // Two renders an hour apart must draw the same chart; a window anchored to
    // the instant would re-bucket every request.
    const morning = rangeWindow("7d", new Date("2026-08-03T06:00:00Z"));
    const midnight = rangeWindow("7d", new Date("2026-08-03T23:59:59Z"));

    expect(morning).toEqual(midnight);
  });

  it("compares against the period immediately before, without overlapping", () => {
    const window = rangeWindow("30d", NOW);

    // Adjacent to the millisecond. A gap would drop reviews out of the
    // comparison; an overlap would let one review count on both sides of its
    // own delta.
    expect(window.previous.end.toISOString()).toBe(window.start.toISOString());
    expect(days(window.previous)).toBe(30);
  });

  it("crosses a month boundary without shortening", () => {
    // 1 March is the classic off-by-one: naive month arithmetic lands in
    // February and quietly loses two or three days.
    const window = rangeWindow("30d", new Date("2026-03-01T09:00:00Z"));

    expect(days(window)).toBe(30);
    expect(window.start.toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });
});

describe("bucketing", () => {
  const window = rangeWindow("30d", NOW);

  function assertCovers(buckets: Window[], covered: { start: Date; end: Date }) {
    expect(buckets[0]?.start.toISOString()).toBe(covered.start.toISOString());
    expect(buckets.at(-1)?.end.toISOString()).toBe(covered.end.toISOString());

    // Contiguous: each bucket starts exactly where the previous ended. A gap
    // would drop reviews from a chart that looks complete, and an overlap would
    // draw them twice.
    for (let index = 1; index < buckets.length; index += 1) {
      expect(buckets[index]?.start.toISOString()).toBe(buckets[index - 1]?.end.toISOString());
    }
  }

  it("gives a sparkline seven points on every range", () => {
    for (const range of RANGES) {
      const scope = rangeWindow(range, NOW);
      const buckets = sparklineBuckets(scope);

      expect(buckets).toHaveLength(SPARKLINE_BUCKETS);
      assertCovers(buckets, scope);
    }
  });

  it("charts a day at a time up to 30 days", () => {
    expect(chartBuckets(rangeWindow("7d", NOW))).toHaveLength(7);
    expect(chartBuckets(rangeWindow("30d", NOW))).toHaveLength(30);
  });

  it("charts a week at a time over 90 days", () => {
    // Ninety points on a line a few hundred pixels wide is a smear; the long
    // range trades resolution for a readable shape.
    const buckets = chartBuckets(rangeWindow("90d", NOW));

    expect(buckets).toHaveLength(13);
    assertCovers(buckets, rangeWindow("90d", NOW));
  });

  it("covers the whole window with no gap and no overlap", () => {
    assertCovers(chartBuckets(window), window);
  });

  it("refuses to split into nothing", () => {
    expect(splitWindow(window, 0)).toEqual([]);
    expect(splitWindow(window, -1)).toEqual([]);
  });
});
