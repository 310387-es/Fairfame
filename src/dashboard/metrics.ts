import type { Sentiment } from "../db/schema.ts";
import { computePulse, rawPulse } from "../digest/metrics.ts";
import type { DashboardFacts, ReviewFact } from "./facts.ts";
import {
  chartBuckets,
  sparklineBuckets,
  TRAILING_DAYS,
  type RangeWindow,
  type Window,
} from "./range.ts";

/**
 * The numbers on Home (Home live dashboard §4).
 *
 * Pure functions over the facts the page already loaded — no database, no
 * clock, no i18n. That is what makes them testable at all: every figure here is
 * a claim about a business's reputation, and "the KPI looked about right" is
 * not verification.
 */

export type KpiKey = "reputation" | "rating" | "volume" | "responseRate";

/**
 * How to read the number, and therefore how to read its delta.
 *
 * A count that goes 100 → 118 rose 18%; a response rate that goes 88% → 91%
 * rose three *points*, not 3.4%. Reporting the second as a percentage of a
 * percentage is a classic dashboard lie, so the unit travels with the value.
 */
export type KpiUnit = "score" | "rating" | "count" | "percent";

export type Kpi = {
  key: KpiKey;
  unit: KpiUnit;
  /** `null` when the window holds nothing to measure — not zero. */
  value: number | null;
  previous: number | null;
  /** Percent change for counts, absolute difference otherwise. `null` when
   * there is nothing honest to compare against. */
  delta: number | null;
  /** Seven points across the range. `null` where a bucket had no data. */
  spark: (number | null)[];
};

export type DashboardKpis = Record<KpiKey, Kpi>;

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function inWindow(facts: readonly ReviewFact[], window: Window): ReviewFact[] {
  return facts.filter((fact) => fact.at >= window.start && fact.at < window.end);
}

/**
 * 0-100, blended from stars and sentiment — the digest's own definition.
 *
 * Smoothed toward the ninety-day baseline (W3.3), which is what makes the
 * number usable on a real small business: a café with eight reviews in the
 * selected week would otherwise show swings of fifteen points driven entirely
 * by who happened to write, and a metric that moves like that teaches people
 * to ignore it.
 *
 * The baseline itself is computed **raw** — it is the long run, and smoothing
 * it toward itself would be circular.
 */
function reputationWith(baseline: readonly ReviewFact[]) {
  const prior = rawPulse(baseline);
  return (facts: readonly ReviewFact[]): number | null => computePulse(facts, { prior });
}

/**
 * Rounded to the one decimal the card shows.
 *
 * Not a display concern: keeping two decimals here and showing one produced
 * "3,5 stars, up 0,35" — a delta that does not reconcile with the numbers
 * beside it. Whatever precision is on screen has to be the precision the
 * comparison was made at.
 */
function averageRating(facts: readonly ReviewFact[]): number | null {
  const rated = facts.filter((fact) => fact.rating !== null);
  if (rated.length === 0) return null;

  return round(rated.reduce((sum, fact) => sum + (fact.rating ?? 0), 0) / rated.length, 1);
}

/**
 * Everything that arrived, not only star reviews.
 *
 * An Instagram comment is customer voice and shows up in the source breakdown,
 * so excluding it here would make two widgets on the same screen disagree about
 * how much came in.
 */
function volume(facts: readonly ReviewFact[]): number {
  return facts.length;
}

/** Share of what arrived that has a published reply. */
function responseRate(facts: readonly ReviewFact[]): number | null {
  if (facts.length === 0) return null;

  const answered = facts.filter((fact) => fact.repliedAt !== null).length;
  return round((answered / facts.length) * 100, 1);
}

/**
 * Percent change, but only where that means something.
 *
 * From zero there is no percentage — 0 → 5 is not "500% up", it is "five where
 * there were none" — so the delta is withheld rather than invented.
 */
function percentChange(value: number, previous: number): number | null {
  if (previous === 0) return null;
  return round(((value - previous) / previous) * 100, 1);
}

function difference(value: number | null, previous: number | null, places: number): number | null {
  if (value === null || previous === null) return null;
  return round(value - previous, places);
}

function kpi(
  key: KpiKey,
  unit: KpiUnit,
  current: readonly ReviewFact[],
  previous: readonly ReviewFact[],
  buckets: Window[],
  measure: (facts: readonly ReviewFact[]) => number | null,
): Kpi {
  const value = measure(current);
  const before = measure(previous);

  const delta =
    unit === "count"
      ? value !== null && before !== null
        ? percentChange(value, before)
        : null
      : difference(value, before, 1);

  return {
    key,
    unit,
    value,
    previous: before,
    delta,
    spark: buckets.map((bucket) => measure(inWindow(current, bucket))),
  };
}

export function computeKpis(facts: DashboardFacts, window: RangeWindow): DashboardKpis {
  const buckets = sparklineBuckets(window);
  const { current, previous } = facts;

  return {
    reputation: kpi(
      "reputation",
      "score",
      current,
      previous,
      buckets,
      reputationWith(facts.baseline),
    ),
    rating: kpi("rating", "rating", current, previous, buckets, averageRating),
    volume: kpi("volume", "count", current, previous, buckets, volume),
    responseRate: kpi("responseRate", "percent", current, previous, buckets, responseRate),
  };
}

/**
 * Which direction is *good*.
 *
 * Every KPI here improves as it rises, but that is a fact about these four
 * rather than about dashboards — response *time*, coming later, gets better as
 * it falls. Keeping the judgement next to the metric stops a future widget
 * inheriting a green arrow that means the opposite.
 */
export function isImprovement(kpi: Kpi): boolean | null {
  if (kpi.delta === null || kpi.delta === 0) return null;
  return kpi.delta > 0;
}

/**
 * The reputation-over-time series (widget 3).
 *
 * Rating and volume in one row per bucket, because the chart draws them on one
 * pair of axes and two arrays would be two chances to misalign them.
 *
 * `volume` is the bucket's own count — 0 where nothing arrived, because "no
 * reviews that day" is a real number and a missing bar would read as missing
 * data.
 *
 * `rating` is a **trailing average**, not the bucket's own. A real location has
 * reviews on a minority of days: at this location, twelve days in the last
 * thirty. Plotted raw, the rating line is a scatter of disconnected fragments —
 * technically true and impossible to read. Joining across the gaps would be
 * worse, because it draws a rating for days nobody rated. Averaging over a
 * trailing span gives a continuous line where every point is a real average of
 * real reviews, and it is still null when the whole span is empty.
 */
export type SeriesPoint = {
  start: Date;
  end: Date;
  /** Trailing average — see `trailingBuckets`. Null when the span had no ratings. */
  rating: number | null;
  volume: number;
};

const DAY_MS = 24 * 60 * 60 * 1_000;

export function computeSeries(facts: DashboardFacts, window: RangeWindow): SeriesPoint[] {
  // The trailing window reaches back across the range boundary, so the first
  // points are averaged over a full week like every other point rather than
  // over however little of the range happens to precede them. The facts already
  // hold the previous period for the deltas, so this costs no extra query.
  const rated = [...facts.previous, ...facts.current];

  return chartBuckets(window).map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    rating: averageRating(
      inWindow(rated, {
        start: new Date(bucket.end.getTime() - TRAILING_DAYS * DAY_MS),
        end: bucket.end,
      }),
    ),
    // The bar is the bucket's own count. Smoothing a volume would hide the
    // spike that makes someone look at the week in the first place.
    volume: inWindow(facts.current, bucket).length,
  }));
}

/* -------------------------------------------------------------------------
 * The lower row (widgets 5-9). Pure, over the facts the page already holds.
 * ---------------------------------------------------------------------- */

export type SentimentBreakdown = {
  positive: number;
  neutral: number;
  negative: number;
  /** Items carrying an analysis. The shares are of this, not of everything. */
  analysed: number;
  /** Items still waiting for the analyser. */
  pending: number;
};

/**
 * Sentiment is a share of what has been *analysed*.
 *
 * Analysis runs asynchronously, so a review can sit in the table for a minute
 * without one. Counting those as neutral would drag every donut toward the
 * middle and make a bad week look calm; they are reported separately instead.
 */
export function computeSentiment(facts: DashboardFacts): SentimentBreakdown {
  let positive = 0;
  let neutral = 0;
  let negative = 0;
  let pending = 0;

  for (const fact of facts.current) {
    if (fact.sentiment === "positive") positive += 1;
    else if (fact.sentiment === "negative") negative += 1;
    else if (fact.sentiment === "neutral") neutral += 1;
    else pending += 1;
  }

  return { positive, neutral, negative, analysed: positive + neutral + negative, pending };
}

export type SourceRow = {
  source: string;
  count: number;
  /** Null where the source carries no stars at all, like Instagram comments. */
  rating: number | null;
  /** Of the busiest source, for the bar width. */
  share: number;
};

export function computeSources(facts: DashboardFacts): SourceRow[] {
  const grouped = new Map<string, ReviewFact[]>();

  for (const fact of facts.current) {
    const bucket = grouped.get(fact.source);
    if (bucket) bucket.push(fact);
    else grouped.set(fact.source, [fact]);
  }

  const rows = [...grouped.entries()]
    .map(([source, items]) => ({
      source,
      count: items.length,
      rating: averageRating(items),
      share: 0,
    }))
    .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source));

  // Relative to the busiest, not to the total: with four sources the widest bar
  // would otherwise be a third full and the smallest invisible.
  const busiest = rows[0]?.count ?? 0;

  return rows.map((row) => ({ ...row, share: busiest === 0 ? 0 : row.count / busiest }));
}

export type ThemeRow = {
  slug: string;
  count: number;
  positive: number;
  negative: number;
  /** What people mostly feel about it — the bar's colour. */
  dominant: Sentiment;
  share: number;
};

/**
 * The themes people actually talked about, most-mentioned first.
 *
 * Colour comes from the dominant sentiment rather than the count, because
 * "cleanliness, 22 mentions" means opposite things depending on whether those
 * mentions were praise or complaints.
 */
export function computeThemes(facts: DashboardFacts, limit = 5): ThemeRow[] {
  const counts = new Map<string, { count: number; positive: number; negative: number }>();

  for (const fact of facts.current) {
    /*
      Canonical themes (W3.2), not the free-text `topics` tail.

      This panel is a *list of names shown to a reader*, so it is under the same
      rule as the insight strip above it: a theme only belongs on screen if it
      means the same thing in both languages. Reading `topics` printed whatever
      word the customer happened to use — so a Turkish account saw "bekleme
      süresi" on an English dashboard, and the same complaint counted twice
      when two customers phrased it differently.

      `topics` is still carried on the fact and is still the right thing to
      count for the long tail; it is just not a label.
    */
    for (const theme of fact.themes) {
      const entry = counts.get(theme) ?? { count: 0, positive: 0, negative: 0 };
      entry.count += 1;
      if (fact.sentiment === "positive") entry.positive += 1;
      if (fact.sentiment === "negative") entry.negative += 1;
      counts.set(theme, entry);
    }
  }

  const rows = [...counts.entries()]
    .map(([slug, entry]) => ({
      slug,
      ...entry,
      dominant:
        entry.negative > entry.positive
          ? ("negative" as const)
          : entry.positive > entry.negative
            ? ("positive" as const)
            : ("neutral" as const),
      share: 0,
    }))
    .sort((left, right) => right.count - left.count || left.slug.localeCompare(right.slug))
    .slice(0, limit);

  const top = rows[0]?.count ?? 0;

  return rows.map((row) => ({ ...row, share: top === 0 ? 0 : row.count / top }));
}

export type RatingBucket = { rating: number; count: number; share: number };

/** Five to one, always all five, so a missing rung reads as zero not absent. */
export function computeRatingDistribution(facts: DashboardFacts): RatingBucket[] {
  const counts = [5, 4, 3, 2, 1].map((rating) => ({
    rating,
    count: facts.current.filter((fact) => fact.rating === rating).length,
    share: 0,
  }));

  const most = Math.max(...counts.map((bucket) => bucket.count), 0);

  return counts.map((bucket) => ({
    ...bucket,
    share: most === 0 ? 0 : bucket.count / most,
  }));
}

export type ResponseTimes = {
  /** Median hours from arrival to a published reply. Null with nothing replied. */
  medianHours: number | null;
  previousMedianHours: number | null;
  /** Share of replied items answered inside a day, 0-100. */
  withinDayShare: number | null;
  replied: number;
  total: number;
};

const HOUR_MS = 60 * 60 * 1_000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/**
 * How long people wait, measured as a median rather than a mean.
 *
 * One review answered three weeks late would drag a mean past anything a
 * customer would recognise; the median says what the typical wait actually was,
 * which is the number worth improving.
 */
export function computeResponseTimes(facts: DashboardFacts): ResponseTimes {
  const waits = (items: readonly ReviewFact[]) =>
    items
      .filter((fact) => fact.repliedAt !== null)
      .map((fact) => ((fact.repliedAt as Date).getTime() - fact.at.getTime()) / HOUR_MS)
      // A reply timestamped before the review it answers is a clock skew, not a
      // negative wait. Clamped rather than dropped, so the count still matches.
      .map((hours) => Math.max(0, hours));

  const current = waits(facts.current);
  const rounded = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);

  return {
    medianHours: rounded(median(current)),
    previousMedianHours: rounded(median(waits(facts.previous))),
    withinDayShare:
      current.length === 0
        ? null
        : Math.round((current.filter((hours) => hours <= 24).length / current.length) * 100),
    replied: current.length,
    total: facts.current.length,
  };
}

/**
 * The response-time distribution (W4.3).
 *
 * **Why a median was not enough.** "24 sa" answers "how long do people
 * typically wait" and nothing else. The question a manager actually has is
 * *where the tail is*: a business with a 4-hour median and a fifth of its
 * reviews sitting for a week has a real problem that the median hides by
 * construction, because the median is exactly the number a tail cannot move.
 *
 * The buckets are the shape of the promise, not equal spans. Under an hour is
 * "we were watching"; under a day is the commitment most businesses make and
 * the one `withinDayShare` already reports; under three days is late but
 * recoverable; beyond that the customer has moved on. Equal-width buckets would
 * be arithmetically tidier and would tell nobody anything.
 *
 * **The unanswered are in it.** They are the whole point — a queue that never
 * got a reply is the worst response time there is, and a distribution drawn
 * only over *answered* reviews is the same flattery as measuring satisfaction
 * among people who did not leave. They sit in their own terminal bucket rather
 * than being given a fictional wait.
 */
export const RESPONSE_BUCKETS = ["under_hour", "under_day", "under_three_days", "slower"] as const;

export type ResponseBucketKey = (typeof RESPONSE_BUCKETS)[number] | "unanswered";

export type ResponseBucket = {
  key: ResponseBucketKey;
  count: number;
  /** 0–100 of everything in the window, answered or not. */
  share: number;
};

export function computeResponseDistribution(facts: DashboardFacts): ResponseBucket[] {
  const counts = new Map<ResponseBucketKey, number>();
  const add = (key: ResponseBucketKey) => counts.set(key, (counts.get(key) ?? 0) + 1);

  for (const fact of facts.current) {
    if (fact.repliedAt === null) {
      add("unanswered");
      continue;
    }

    // Clamped for the same clock-skew reason `computeResponseTimes` clamps.
    const hours = Math.max(0, (fact.repliedAt.getTime() - fact.at.getTime()) / HOUR_MS);

    if (hours < 1) add("under_hour");
    else if (hours <= 24) add("under_day");
    else if (hours <= 72) add("under_three_days");
    else add("slower");
  }

  const total = facts.current.length;

  return [...RESPONSE_BUCKETS, "unanswered" as const].map((key) => ({
    key,
    count: counts.get(key) ?? 0,
    // Absence renders as an empty bar rather than being dropped: a distribution
    // missing its empty buckets reads as a different shape entirely.
    share: total === 0 ? 0 : round(((counts.get(key) ?? 0) / total) * 100, 1),
  }));
}

/**
 * One row per branch, for the comparison strip (W4.3).
 *
 * **Same facts, same arithmetic.** Every measure here is the function the
 * headline KPI already uses, applied to a filtered slice — so a chain's rating
 * and the rating of its only branch cannot disagree, and neither can they drift
 * when somebody changes how a rating is averaged. That is the entire reason
 * `locationId` is carried on `ReviewFact` rather than fetched per branch.
 *
 * **Absence is null.** A branch with nothing in the window did not score nought
 * stars and did not answer 0% of nothing; a delta needs both sides. Zero is
 * reserved for `volume` and `unanswered`, where it is a real count.
 *
 * The rows are returned in the caller's branch order and sorted on screen —
 * sorting here would fix an order the reader is meant to choose.
 */
export type BranchRow = {
  locationId: string;
  rating: number | null;
  ratingDelta: number | null;
  volume: number;
  volumeDelta: number | null;
  unanswered: number;
  medianResponseHours: number | null;
};

export function computeBranches(facts: DashboardFacts, locationIds: string[]): BranchRow[] {
  const at = (items: readonly ReviewFact[], locationId: string) =>
    items.filter((fact) => fact.locationId === locationId);

  return locationIds.map((locationId) => {
    const current = at(facts.current, locationId);
    const previous = at(facts.previous, locationId);

    const rating = averageRating(current);
    const previousRating = averageRating(previous);

    const waits = current
      .filter((fact) => fact.repliedAt !== null)
      .map((fact) =>
        Math.max(0, ((fact.repliedAt as Date).getTime() - fact.at.getTime()) / HOUR_MS),
      );

    return {
      locationId,
      rating,
      ratingDelta: difference(rating, previousRating, 1),
      volume: current.length,
      // Percent, matching the volume KPI's own delta — and null from zero, for
      // the reason `percentChange` withholds it: 0 → 5 is not "500% up".
      volumeDelta: percentChange(current.length, previous.length),
      unanswered: current.filter((fact) => fact.repliedAt === null).length,
      medianResponseHours: (() => {
        const value = median(waits);
        return value === null ? null : Math.round(value * 10) / 10;
      })(),
    };
  });
}
