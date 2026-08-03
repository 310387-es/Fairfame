/**
 * The dashboard's time scope (Home live dashboard §3).
 *
 * One range drives every widget on the page, so it lives here as a pure module
 * rather than inside any of them: a KPI whose delta covered a different window
 * than the chart beside it would be worse than showing no delta at all, and
 * that kind of drift is invisible until someone compares two numbers by hand.
 *
 * Windows are `[start, end)` in UTC, matching `digest/metrics.ts`. UTC rather
 * than the location's timezone for the same reason the digest gives: a chain's
 * two branches must share one definition of "the last 30 days" or their numbers
 * cannot be compared.
 */

export const RANGES = ["7d", "30d", "90d"] as const;

export type Range = (typeof RANGES)[number];

/**
 * 30 days is the default because it is the shortest window that survives a
 * quiet week. At 7 days a location with a handful of reviews shows deltas that
 * swing wildly on one review, which reads as noise; at 90 the page stops
 * feeling live.
 */
export const DEFAULT_RANGE: Range = "30d";

export const RANGE_DAYS: Record<Range, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** Points in a KPI sparkline, whatever the range. */
export const SPARKLINE_BUCKETS = 7;

const DAY_MS = 24 * 60 * 60 * 1_000;

export type Window = { start: Date; end: Date };

export type RangeWindow = {
  range: Range;
  days: number;
  /** The selected window. */
  start: Date;
  end: Date;
  /** The equal-length window immediately before it — what deltas compare to. */
  previous: Window;
};

function isRange(value: string): value is Range {
  return (RANGES as readonly string[]).includes(value);
}

/**
 * Reads `?range=` into a range, falling back rather than failing.
 *
 * A URL is user input and this one is meant to be shared, so a typo or a stale
 * link must land on a working page. Nothing downstream is safe to skip on a bad
 * value: the range decides which rows are read.
 */
export function parseRange(value: string | string[] | undefined): Range {
  const first = Array.isArray(value) ? value[0] : value;
  return first && isRange(first) ? first : DEFAULT_RANGE;
}

/**
 * The window for a range, ending at the end of `now`'s UTC day.
 *
 * The end is tomorrow midnight rather than this instant so buckets land on day
 * boundaries and the same page rendered twice an hour apart draws the same
 * chart. Today is included and therefore partial — that is what makes the
 * dashboard live rather than a report about yesterday.
 */
export function rangeWindow(range: Range, now: Date): RangeWindow {
  const days = RANGE_DAYS[range];

  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  const start = new Date(end.getTime() - days * DAY_MS);

  return {
    range,
    days,
    start,
    end,
    // Immediately adjacent, never overlapping: a review must not be able to
    // count in both halves of its own comparison.
    previous: { start: new Date(start.getTime() - days * DAY_MS), end: new Date(start) },
  };
}

/**
 * Splits a window into `count` contiguous buckets.
 *
 * Contiguous and exhaustive by construction — each bucket starts where the last
 * ended and the final one ends exactly at the window's end — because a gap
 * would silently drop reviews from a chart that looks complete.
 */
export function splitWindow(window: Window, count: number): Window[] {
  if (count < 1) return [];

  const span = window.end.getTime() - window.start.getTime();
  const step = span / count;

  return Array.from({ length: count }, (_, index) => ({
    start: new Date(window.start.getTime() + index * step),
    end:
      index === count - 1
        ? new Date(window.end)
        : new Date(window.start.getTime() + (index + 1) * step),
  }));
}

/**
 * Buckets for the reputation chart: one per day, or per week over 90 days.
 *
 * Ninety daily points on a line a few hundred pixels wide is a smear — the
 * shape stops being readable at roughly a point every four pixels, so the long
 * range trades resolution for legibility.
 */
export function chartBuckets(window: RangeWindow): Window[] {
  const perBucket = window.days > 30 ? 7 : 1;
  return splitWindow(window, Math.ceil(window.days / perBucket));
}

/** Seven points across the range, whatever its length. */
export function sparklineBuckets(window: RangeWindow): Window[] {
  return splitWindow(window, SPARKLINE_BUCKETS);
}

/**
 * The span each chart point averages over: one week, on every range.
 *
 * A daily rating is far too sparse to plot — a real location has reviews on a
 * minority of days, so a raw daily line is mostly holes with unreadable
 * fragments between them. A trailing average gives a continuous line without
 * inventing a data point: every value is a real average of real reviews,
 * measured over a wider window.
 *
 * Seven days rather than something shorter on the short range, because a
 * three-day window over a quiet midweek is still empty — the 7-day view had a
 * hole in the middle of its line for exactly that reason. A week is also the
 * shortest span that survives the weekday/weekend rhythm most of these
 * businesses run on.
 *
 * On the 90-day range a bucket is already a week, so this adds no smoothing at
 * all: the point is its own bucket's average.
 */
export const TRAILING_DAYS = 7;
