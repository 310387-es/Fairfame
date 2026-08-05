import type { Sentiment } from "../db/schema.ts";
import { TRAILING_DAYS, type RangeWindow } from "../dashboard/range.ts";
import type { InsightFact } from "./facts.ts";

/**
 * Every number on the Insights page (P3-T4).
 *
 * Pure functions over facts the page already loaded — no database, no clock, no
 * i18n. That is what makes them testable, and every figure here is a claim
 * about a business's reputation that somebody may act on: "are we improving,
 * where, and driven by what" is three questions whose answers are only useful
 * if they are arithmetically true.
 *
 * Two rules run through the whole file:
 *
 *   1. **A missing measurement is `null`, never `0`.** A week with no reviews
 *      did not score zero stars, and a location nobody rated does not have a
 *      rating of nought. Zero is a measurement; absence is not, and plotting
 *      one as the other draws a cliff that never happened.
 *   2. **A comparison needs both sides.** Every delta is `null` unless the
 *      window before it holds something to compare against — "up 100%" from a
 *      base of nothing is not a fact about a business.
 */

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** One bucket on a trend line. */
export type TrendPoint = {
  /** Bucket start, UTC. */
  start: Date;
  /** Bucket end, exclusive. */
  end: Date;
  /** Null where the bucket held nothing to measure. */
  value: number | null;
  /** How many reviews the value was drawn from. Zero is legitimate here. */
  count: number;
};

/** A measured value beside the same measure over the preceding window. */
export type Comparison = {
  value: number | null;
  previous: number | null;
  /** Absolute difference for ratings and scores; `null` without both sides. */
  delta: number | null;
  count: number;
};

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function mean(values: number[], places: number): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, places);
}

function compare(current: number | null, previous: number | null, count: number): Comparison {
  return {
    value: current,
    previous,
    delta: current !== null && previous !== null ? round(current - previous, 2) : null,
    count,
  };
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * How the range is cut up for a trend line.
 *
 * Daily for a week, daily for a month, weekly for a quarter. Thirteen weekly
 * points rather than ninety daily ones because a 90-day line at daily
 * resolution for a business receiving two reviews a day is not a trend, it is a
 * barcode — and the question this page answers is "are we improving", which is
 * a question about the shape, not the days.
 */
export function trendBuckets(window: RangeWindow): { start: Date; end: Date }[] {
  const size = window.days > 30 ? 7 * DAY_MS : DAY_MS;
  const buckets: { start: Date; end: Date }[] = [];

  // Built backwards from the end of the range, so the last bucket always ends
  // exactly at "now" — a forward walk leaves a ragged final bucket whose value
  // is low for no reason other than it being half over.
  for (let end = window.end.getTime(); end > window.start.getTime(); end -= size) {
    const start = Math.max(end - size, window.start.getTime());
    buckets.unshift({ start: new Date(start), end: new Date(end) });
  }

  return buckets;
}

function bucketed(
  facts: readonly InsightFact[],
  window: RangeWindow,
  measure: (inBucket: InsightFact[]) => { value: number | null; count: number },
): TrendPoint[] {
  return trendBuckets(window).map(({ start, end }) => {
    const inBucket = facts.filter((fact) => fact.at >= start && fact.at < end);
    return { start, end, ...measure(inBucket) };
  });
}

/**
 * The same buckets, but each point measures the **week ending at it**.
 *
 * This is the answer to a real complaint about the first version of this page:
 * plotted per bucket, the rating line was a scatter of disconnected fragments,
 * because a real business has reviews on a minority of days. `docs/15` and
 * `src/dashboard/metrics.ts` had already settled this for Home's chart and this
 * module simply failed to reuse the reasoning:
 *
 *   - Joining across the gaps is worse than the gaps. It draws a rating for
 *     days nobody rated.
 *   - Widening the buckets throws away the resolution of the busy stretches.
 *   - A trailing average gives a **continuous line where every point is a real
 *     average of real reviews** — just measured over a wider span than the
 *     bucket it sits on. Nothing is invented, and a span with genuinely no
 *     data is still null.
 *
 * `TRAILING_DAYS` is shared with Home, so the two charts smooth identically.
 * The previous window is included in the source facts on purpose: the trailing
 * span reaches back across the range boundary, so the first points average over
 * a full week like every other point instead of over however little of the
 * range precedes them. Those facts are already loaded for the deltas.
 */
function trailing(
  facts: readonly InsightFact[],
  previousFacts: readonly InsightFact[],
  window: RangeWindow,
  measure: (inSpan: InsightFact[]) => { value: number | null; count: number },
): TrendPoint[] {
  const all = [...previousFacts, ...facts];
  const span = TRAILING_DAYS * DAY_MS;

  return trendBuckets(window).map(({ start, end }) => {
    const from = new Date(end.getTime() - span);
    const inSpan = all.filter((fact) => fact.at >= from && fact.at < end);
    const measured = measure(inSpan);

    return {
      start,
      end,
      value: measured.value,
      // The bucket's *own* count, not the span's. The count says how much
      // arrived in this period, which is what a reader hovering a point wants;
      // the value is deliberately the smoother number.
      count: facts.filter((fact) => fact.at >= start && fact.at < end).length,
    };
  });
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

/**
 * Average star rating, over the week ending at each point.
 *
 * A trailing average rather than the bucket's own — see `trailing`. Unrated
 * reviews are not zero-star ones and are excluded rather than counted as nought.
 */
export function ratingTrend(
  facts: readonly InsightFact[],
  previousFacts: readonly InsightFact[],
  window: RangeWindow,
): TrendPoint[] {
  return trailing(facts, previousFacts, window, (inSpan) => {
    const rated = inSpan.filter((fact) => fact.rating !== null);
    return {
      value: mean(
        rated.map((fact) => fact.rating!),
        2,
      ),
      count: rated.length,
    };
  });
}

/**
 * Average sentiment score per bucket, on the model's own −1…1 scale.
 *
 * Kept as the score rather than converted to a percentage of positives: the
 * share-of-positive version moves in steps on a small corpus (three reviews,
 * so 0%, 33%, 67%, 100%) and reads as violent swings in a business that had a
 * normal week.
 *
 * Trailing, like the rating, and for the same reason.
 */
export function sentimentTrend(
  facts: readonly InsightFact[],
  previousFacts: readonly InsightFact[],
  window: RangeWindow,
): TrendPoint[] {
  return trailing(facts, previousFacts, window, (inSpan) => {
    const scored = inSpan.filter((fact) => fact.sentimentScore !== null);
    return {
      value: mean(
        scored.map((fact) => fact.sentimentScore!),
        3,
      ),
      count: scored.length,
    };
  });
}

/**
 * How many reviews arrived per bucket. Zero here is a real measurement.
 *
 * **Not** smoothed, unlike the two above: a volume is a count of things that
 * happened in a period, and averaging it would hide the spike that makes
 * somebody look at the week in the first place. Home makes the same split.
 */
export function volumeTrend(facts: readonly InsightFact[], window: RangeWindow): TrendPoint[] {
  return bucketed(facts, window, (inBucket) => ({
    value: inBucket.length,
    count: inBucket.length,
  }));
}

// ---------------------------------------------------------------------------
// Themes over time
// ---------------------------------------------------------------------------

export type ThemeTrend = {
  theme: string;
  /** Mentions in the selected window. */
  count: number;
  previousCount: number;
  /** Percent change against the previous window; null without a prior base. */
  delta: number | null;
  /** How those mentions split, so a rising theme's direction is visible. */
  positive: number;
  neutral: number;
  negative: number;
  /** Mentions per bucket, for the small line beside the row. */
  points: TrendPoint[];
};

/**
 * The themes that moved, not simply the biggest ones.
 *
 * Ranked by how much a theme *changed*, because "food" being the top theme
 * every month is not news, and "waiting time" tripling is. Ties fall back to
 * volume so a flat page still shows what customers talk about.
 */
export function themeTrends(
  facts: readonly InsightFact[],
  previousFacts: readonly InsightFact[],
  window: RangeWindow,
  limit = 8,
): ThemeTrend[] {
  const countByTheme = (source: readonly InsightFact[]) => {
    const counts = new Map<string, number>();
    for (const fact of source) {
      // A theme mentioned twice in one review is one review's worth of signal.
      for (const theme of new Set(fact.topics)) {
        counts.set(theme, (counts.get(theme) ?? 0) + 1);
      }
    }
    return counts;
  };

  const current = countByTheme(facts);
  const previous = countByTheme(previousFacts);

  const trends: ThemeTrend[] = [...current.entries()].map(([theme, count]) => {
    const before = previous.get(theme) ?? 0;
    const mentions = facts.filter((fact) => fact.topics.includes(theme));

    return {
      theme,
      count,
      previousCount: before,
      // Percent change, because a theme count is a count. Null against a base
      // of zero: everything is up infinitely from nothing.
      delta: before > 0 ? round(((count - before) / before) * 100, 0) : null,
      positive: mentions.filter((fact) => fact.sentiment === "positive").length,
      neutral: mentions.filter((fact) => fact.sentiment === "neutral").length,
      negative: mentions.filter((fact) => fact.sentiment === "negative").length,
      points: bucketed(mentions, window, (inBucket) => ({
        value: inBucket.length,
        count: inBucket.length,
      })),
    };
  });

  return trends
    .sort((left, right) => {
      const movement = Math.abs(right.delta ?? 0) - Math.abs(left.delta ?? 0);
      return movement !== 0 ? movement : right.count - left.count;
    })
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------

export type GroupComparison = {
  key: string;
  rating: Comparison;
  sentiment: Comparison;
  volume: Comparison;
  /** Share of reviews that got a reply, 0–1. Null when there were none. */
  responseRate: Comparison;
};

function measureGroup(
  current: readonly InsightFact[],
  previous: readonly InsightFact[],
  key: string,
): GroupComparison {
  const rating = (source: readonly InsightFact[]) =>
    mean(
      source.filter((fact) => fact.rating !== null).map((fact) => fact.rating!),
      2,
    );

  const sentiment = (source: readonly InsightFact[]) =>
    mean(
      source.filter((fact) => fact.sentimentScore !== null).map((fact) => fact.sentimentScore!),
      3,
    );

  const responded = (source: readonly InsightFact[]) =>
    source.length === 0
      ? null
      : round(source.filter((fact) => fact.repliedAt !== null).length / source.length, 3);

  return {
    key,
    rating: compare(
      rating(current),
      rating(previous),
      current.filter((f) => f.rating !== null).length,
    ),
    sentiment: compare(sentiment(current), sentiment(previous), current.length),
    volume: compare(current.length, previous.length, current.length),
    responseRate: compare(responded(current), responded(previous), current.length),
  };
}

/** One row per group, for the location and source tables. */
export function compareBy(
  facts: readonly InsightFact[],
  previousFacts: readonly InsightFact[],
  keyOf: (fact: InsightFact) => string,
): GroupComparison[] {
  const keys = new Set([...facts.map(keyOf), ...previousFacts.map(keyOf)]);

  return (
    [...keys]
      .map((key) =>
        measureGroup(
          facts.filter((fact) => keyOf(fact) === key),
          previousFacts.filter((fact) => keyOf(fact) === key),
          key,
        ),
      )
      // Busiest first: a comparison table sorted alphabetically buries the branch
      // the reader came to look at.
      .sort((left, right) => right.volume.value! - left.volume.value!)
  );
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export type StaffMentions = {
  name: string;
  count: number;
  positive: number;
  neutral: number;
  negative: number;
  /** Average rating of the reviews that named them. Null when none were rated. */
  rating: number | null;
};

export type StaffSummary = {
  people: StaffMentions[];
  /**
   * Reviews analysed before names were extracted at all.
   *
   * Reported rather than ignored, because "nobody is named in your reviews" and
   * "we have not looked" are different sentences and only one of them is true.
   */
  notAnalysed: number;
};

/**
 * Who customers named, and what the reviews naming them said.
 *
 * **Mentions, not a performance score**, and the shape enforces the
 * distinction: this returns counts and an average of the reviews a person was
 * named in, with no ranking, no composite and no threshold. A number that
 * purported to rate an employee — and that a manager might act on — would be an
 * automated evaluation of a named individual built from strangers' prose, which
 * is not something this product has the basis or the accuracy to do. See
 * migration 0033.
 */
export function staffMentions(facts: readonly InsightFact[], limit = 12): StaffSummary {
  const byKey = new Map<string, { name: string; facts: InsightFact[] }>();

  for (const fact of facts) {
    for (const name of new Set(fact.staff)) {
      // Folded case-insensitively, Turkish-aware, so "İlker" and "ilker" are
      // one person. The first spelling seen is the one displayed.
      const key = name.toLocaleLowerCase("tr");
      const entry = byKey.get(key) ?? { name, facts: [] };
      entry.facts.push(fact);
      byKey.set(key, entry);
    }
  }

  const people = [...byKey.values()]
    .map(({ name, facts: mentions }) => ({
      name,
      count: mentions.length,
      positive: mentions.filter((fact) => fact.sentiment === "positive").length,
      neutral: mentions.filter((fact) => fact.sentiment === "neutral").length,
      negative: mentions.filter((fact) => fact.sentiment === "negative").length,
      rating: mean(
        mentions.filter((fact) => fact.rating !== null).map((fact) => fact.rating!),
        2,
      ),
    }))
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);

  return {
    people,
    notAnalysed: facts.filter((fact) => !fact.staffAnalysed).length,
  };
}

// ---------------------------------------------------------------------------
// Sentiment mix
// ---------------------------------------------------------------------------

export type SentimentMix = Record<Sentiment, number> & { analysed: number; pending: number };

/** The plain split, for the header. Pending is stated rather than absorbed. */
export function sentimentMix(facts: readonly InsightFact[]): SentimentMix {
  const analysed = facts.filter((fact) => fact.sentiment !== null);

  return {
    positive: analysed.filter((fact) => fact.sentiment === "positive").length,
    neutral: analysed.filter((fact) => fact.sentiment === "neutral").length,
    negative: analysed.filter((fact) => fact.sentiment === "negative").length,
    analysed: analysed.length,
    pending: facts.length - analysed.length,
  };
}
