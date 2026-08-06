/**
 * The computed half of a digest (P1a-T7).
 *
 * Everything here is a **pure function of stored rows** — no clock, no network,
 * no model. That is what makes the Definition of Done's "reproducible from
 * stored data" a testable claim rather than a hope: given the same reviews and
 * insights, these numbers come out identical every time, and the digest test
 * asserts exactly that.
 *
 * The composed half (briefing, actions, social post) is a model's output and is
 * *stored*, not recomputed. Those two halves need different treatment and the
 * split between this file and ./pipeline.ts is where it lives.
 */

export type Sentiment = "positive" | "neutral" | "negative";

export type WindowReview = {
  id: string;
  rating: number | null;
  text: string | null;
  language: string | null;
  postedAt: Date | null;
  sentiment: Sentiment | null;
  sentimentScore: number | null;
  topics: string[];
  embedding: number[] | null;
  hasReply: boolean;
};

/**
 * A 0-100 reputation pulse.
 *
 * Blended from stars and sentiment rather than taken from either alone. Stars
 * are what a platform shows the public and what an owner already tracks, so a
 * pulse that ignored them would feel wrong; sentiment is what catches the
 * five-star review that reads like a complaint. Weighted toward stars because
 * that is the number a customer actually sees.
 *
 * Reviews with no rating contribute through sentiment only, and vice versa —
 * dropping them would let a week of text-only feedback read as "no change".
 */
export const RATING_WEIGHT = 0.65;
export const SENTIMENT_WEIGHT = 0.35;

/**
 * Narrowed to the two fields it reads so the live dashboard can reuse it —
 * Home and the digest must never compute the same score two ways.
 */
export type PulseInput = { rating: number | null; sentimentScore: number | null };

/**
 * Below this many reviews, there is no score — not a small one (W3.3).
 *
 * Two customers do not make a reputation. A single one-star among three
 * reviews moves the raw blend by more than twenty points, so a business with a
 * quiet week would watch a number swing wildly and correctly conclude it means
 * nothing. Ten is a judgement rather than a derivation, written here so it can
 * be argued with in one place; the surfaces say "not enough data yet" rather
 * than drawing a dial nobody should read.
 */
export const MIN_REVIEWS_FOR_PULSE = 10;

/**
 * How much the longer run pulls a short window toward it.
 *
 * Bayesian smoothing with a pseudo-count: the score is
 * `(n·window + K·prior) / (n + K)`, so a week of three reviews is mostly the
 * prior and a week of two hundred is mostly itself. **K is in units of
 * reviews** — at `K = 10`, ten reviews in the window carry equal weight with
 * the ninety-day baseline.
 *
 * Without it the weekly number is unusable on a real small business: a café
 * with eight reviews a week would show ±15 point swings driven entirely by who
 * happened to write, and a metric that moves like that trains people to ignore
 * it — the same failure the digest's filler content caused.
 */
export const PULSE_SMOOTHING_REVIEWS = 10;

export type PulseOptions = {
  /**
   * The longer-run score to smooth toward — the ninety-day blend for this
   * location. Null skips smoothing entirely, which is right for a caller that
   * *is* the long run and would otherwise be smoothed toward itself.
   */
  prior?: number | null;
};

/**
 * The raw, unsmoothed blend. Exported for the ninety-day baseline itself,
 * which has nothing to be pulled toward.
 */
export function rawPulse(reviews: readonly PulseInput[]): number | null {
  const rated = reviews.filter((review) => review.rating !== null);
  const scored = reviews.filter((review) => review.sentimentScore !== null);

  if (rated.length === 0 && scored.length === 0) return null;

  // 1-5 stars → 0-100.
  const ratingPart =
    rated.length === 0
      ? null
      : (rated.reduce((sum, review) => sum + (review.rating ?? 0), 0) / rated.length - 1) * 25;

  // -1..1 → 0-100.
  const sentimentPart =
    scored.length === 0
      ? null
      : ((scored.reduce((sum, review) => sum + (review.sentimentScore ?? 0), 0) / scored.length +
          1) /
          2) *
        100;

  if (ratingPart === null) return clamp(sentimentPart ?? 0);
  if (sentimentPart === null) return clamp(ratingPart);

  return clamp(ratingPart * RATING_WEIGHT + sentimentPart * SENTIMENT_WEIGHT);
}

/**
 * The score a surface should show: smoothed, whole, or nothing at all.
 *
 * **Whole numbers** (W3.3). The decimal was precision the measurement does not
 * have — "72,4" invites somebody to care about the 0,4, which is one
 * indifferent review either way — and it was half of why the same reputation
 * read as 70 on one screen and 72.3 on another.
 */
export function computePulse(
  reviews: readonly PulseInput[],
  options: PulseOptions = {},
): number | null {
  const usable = reviews.filter(
    (review) => review.rating !== null || review.sentimentScore !== null,
  );

  const raw = rawPulse(usable);
  if (raw === null) return null;

  const prior = options.prior ?? null;

  // Nothing to smooth toward: the sample has to stand on its own, and below
  // the floor it cannot.
  if (prior === null) {
    return usable.length < MIN_REVIEWS_FOR_PULSE ? null : Math.round(raw);
  }

  const n = usable.length;
  const smoothed = (n * raw + PULSE_SMOOTHING_REVIEWS * prior) / (n + PULSE_SMOOTHING_REVIEWS);
  return Math.round(clamp(smoothed));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export type ThemeCluster = {
  /** The label shown to the owner — the most common member slug. */
  label: string;
  /** Every slug folded into this cluster, including the label. */
  slugs: string[];
  reviewCount: number;
  positive: number;
  negative: number;
  neutral: number;
  /** Mean sentiment score across the cluster's reviews. */
  averageSentiment: number;
  /** Review ids, newest first — the evidence an action can point at. */
  reviewIds: string[];
};

/** Cosine similarity between two unit-ish vectors. */
export function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }

  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * How close two theme *labels* must be to count as the same theme.
 *
 * Measured against real `gemini-embedding-2` vectors rather than guessed.
 * Should merge, and does:
 *
 *   yemek    ~ yiyecek      0.950      servis   ~ hizmet      0.856
 *   food quality ~ yemek kalitesi 0.899  personel ~ staff     0.855
 *   otopark  ~ parking      0.890      kahvaltı ~ yiyecek     0.805
 *   fiyat    ~ price        0.875      temizlik ~ cleanliness 0.800
 *
 * Should not, and does not:
 *
 *   temizlik ~ yemek        0.753      fiyat    ~ temizlik    0.645
 *   yemek    ~ food quality 0.668      personel ~ fiyat       0.606
 *
 * **The gap is narrower than it looks.** Cross-language pairs separate cleanly
 * (0.80+ against 0.60-0.66), but same-language near-neighbours do not:
 * `temizlik ~ yemek` at 0.753 sits only 0.047 below the weakest true positive.
 * 0.78 threads that gap, and at 0.75 the live corpus really did fold "yemek"
 * into "temizlik". A single global threshold will misjudge an occasional pair;
 * the `tags` table exists so an owner can correct the vocabulary when it does.
 */
export const THEME_MERGE_THRESHOLD = 0.78;

/**
 * Groups reviews into themes, merging cross-language duplicates via embeddings.
 *
 * Two stages, and the order matters. Exact slug grouping first, because the
 * model's own words are the evidence and must not be paraphrased away. Then the
 * *label* embeddings are compared, folding slugs that mean the same thing —
 * which is the only way `personel` and `staff` become one line in a briefing,
 * and the reason embeddings are in this schema at all.
 *
 * **Labels, not review centroids.** An earlier version averaged each theme's
 * review vectors and compared those. It collapsed at realistic volume: 50 slugs
 * became one theme over a 57-review window, because short restaurant reviews in
 * one language are all similar to each other. Measured, review centroids
 * separate a translation pair from an unrelated pair by 0.765 vs 0.721 — no
 * usable gap — while the labels separate at 0.855 vs 0.606. The question being
 * asked is "do these two words mean the same thing", so the words are what must
 * be compared.
 *
 * A label with no vector never merges. That is the right failure: an unmerged
 * theme is untidy, a wrongly merged one is a lie about what customers said.
 */
export function clusterThemes(
  reviews: WindowReview[],
  options: {
    /** Embedding per theme slug. Absent slugs are never merged. */
    labelVectors?: Map<string, number[]>;
    threshold?: number;
    limit?: number;
  } = {},
): ThemeCluster[] {
  const threshold = options.threshold ?? THEME_MERGE_THRESHOLD;
  const labelVectors = options.labelVectors ?? new Map<string, number[]>();

  // Stage one: exact slug.
  const bySlug = new Map<string, WindowReview[]>();
  for (const review of reviews) {
    for (const topic of new Set(review.topics)) {
      const bucket = bySlug.get(topic);
      if (bucket) bucket.push(review);
      else bySlug.set(topic, [review]);
    }
  }

  type Bucket = { slugs: string[]; reviews: WindowReview[] };

  const buckets: [string, WindowReview[]][] = [...bySlug.entries()].sort(
    // Largest first, so the dominant slug becomes the cluster label and smaller
    // synonyms fold into it rather than the other way round. Ties break on the
    // slug so the result does not depend on map insertion order.
    (left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]),
  );

  // Stage two: merge by meaning.
  const merged: Bucket[] = [];

  for (const [slug, slugReviews] of buckets) {
    const vector = labelVectors.get(slug);

    // Compared against each cluster's *representative* label only, never a
    // running average. Averaging lets A~B and B~C drag C into A's cluster even
    // when A and C are unrelated, which is how a chain swallows a whole corpus.
    const target = vector
      ? merged.find((candidate) => {
          const representative = labelVectors.get(candidate.slugs[0] ?? "");
          return (
            representative !== undefined && cosineSimilarity(representative, vector) >= threshold
          );
        })
      : undefined;

    if (!target) {
      merged.push({ slugs: [slug], reviews: [...slugReviews] });
      continue;
    }

    target.slugs.push(slug);
    for (const review of slugReviews) {
      if (!target.reviews.includes(review)) target.reviews.push(review);
    }
  }

  const clusters = merged.map((bucket) => {
    const counts = { positive: 0, neutral: 0, negative: 0 };
    let scoreSum = 0;
    let scored = 0;

    for (const review of bucket.reviews) {
      if (review.sentiment) counts[review.sentiment] += 1;
      if (review.sentimentScore !== null) {
        scoreSum += review.sentimentScore;
        scored += 1;
      }
    }

    return {
      label: bucket.slugs[0] ?? "other",
      slugs: bucket.slugs,
      reviewCount: bucket.reviews.length,
      ...counts,
      averageSentiment: scored === 0 ? 0 : Number((scoreSum / scored).toFixed(3)),
      reviewIds: [...bucket.reviews]
        .sort((left, right) => (right.postedAt?.getTime() ?? 0) - (left.postedAt?.getTime() ?? 0))
        .map((review) => review.id),
    };
  });

  return clusters
    .sort(
      (left, right) =>
        right.reviewCount - left.reviewCount || left.label.localeCompare(right.label),
    )
    .slice(0, options.limit ?? 8);
}

export type WindowChange = {
  kind: "pulse" | "volume" | "theme";
  /** Positive is an improvement, negative is a decline, zero is flat. */
  direction: 1 | 0 | -1;
  /** Machine-readable detail; the UI and the prompt render it. */
  detail: Record<string, unknown>;
};

/**
 * What moved against the previous window.
 *
 * Only differences worth a sentence. A pulse that shifted 0.3 points is noise,
 * and a briefing that reports noise trains the reader to skim — so the
 * thresholds below are the difference between a digest people act on and one
 * they stop opening.
 */
export const PULSE_CHANGE_THRESHOLD = 2;
export const VOLUME_CHANGE_THRESHOLD = 0.25;

export function computeChanges(input: {
  pulse: number | null;
  priorPulse: number | null;
  reviewCount: number;
  priorReviewCount: number;
  themes: ThemeCluster[];
  priorThemes: ThemeCluster[];
}): WindowChange[] {
  const changes: WindowChange[] = [];

  if (input.pulse !== null && input.priorPulse !== null) {
    const delta = Number((input.pulse - input.priorPulse).toFixed(1));
    if (Math.abs(delta) >= PULSE_CHANGE_THRESHOLD) {
      changes.push({
        kind: "pulse",
        direction: delta > 0 ? 1 : -1,
        detail: { from: input.priorPulse, to: input.pulse, delta },
      });
    }
  }

  if (input.priorReviewCount > 0) {
    const ratio = (input.reviewCount - input.priorReviewCount) / input.priorReviewCount;
    if (Math.abs(ratio) >= VOLUME_CHANGE_THRESHOLD) {
      changes.push({
        kind: "volume",
        // More reviews is not automatically good, but it is what the owner is
        // being told; direction here means "up" and the copy stays neutral.
        direction: ratio > 0 ? 1 : -1,
        detail: {
          from: input.priorReviewCount,
          to: input.reviewCount,
          percent: Math.round(ratio * 100),
        },
      });
    }
  }

  const priorByLabel = new Map(input.priorThemes.map((theme) => [theme.label, theme]));

  for (const theme of input.themes) {
    const prior = priorByLabel.get(theme.label);

    if (!prior) {
      // A theme that did not exist last week is the most actionable kind of
      // change, so it is reported even at low volume — but not at volume one,
      // which is a single opinion rather than a trend.
      if (theme.reviewCount >= 2) {
        changes.push({
          kind: "theme",
          direction: theme.averageSentiment >= 0 ? 1 : -1,
          detail: { label: theme.label, status: "new", count: theme.reviewCount },
        });
      }
      continue;
    }

    const delta = theme.reviewCount - prior.reviewCount;
    if (Math.abs(delta) >= 2) {
      changes.push({
        kind: "theme",
        direction: delta > 0 ? (theme.averageSentiment >= 0 ? 1 : -1) : 0,
        detail: {
          label: theme.label,
          status: delta > 0 ? "rising" : "falling",
          from: prior.reviewCount,
          to: theme.reviewCount,
        },
      });
    }
  }

  return changes;
}

/**
 * Negative reviews with no reply yet — the digest's most concrete work item.
 *
 * Newest first: an unanswered complaint from yesterday is still worth
 * answering, one from six days ago mostly is not.
 */
export function openNegatives(reviews: WindowReview[], limit = 3): WindowReview[] {
  return reviews
    .filter(
      (review) =>
        !review.hasReply &&
        review.text !== null &&
        (review.sentiment === "negative" || (review.rating !== null && review.rating <= 3)),
    )
    .sort((left, right) => (right.postedAt?.getTime() ?? 0) - (left.postedAt?.getTime() ?? 0))
    .slice(0, limit);
}

/**
 * The single review most worth turning into a social post.
 *
 * Highest sentiment, then longest text: a glowing one-liner makes a thin post,
 * and specificity is what makes a quote worth sharing.
 */
export function topReview(reviews: WindowReview[]): WindowReview | null {
  const candidates = reviews.filter(
    (review) =>
      review.text !== null &&
      review.text.trim().length >= 40 &&
      (review.sentiment === "positive" || (review.rating !== null && review.rating >= 4)),
  );

  return (
    [...candidates].sort(
      (left, right) =>
        (right.sentimentScore ?? 0) - (left.sentimentScore ?? 0) ||
        (right.text?.length ?? 0) - (left.text?.length ?? 0),
    )[0] ?? null
  );
}

/**
 * The UTC week containing `now`, Monday 00:00 inclusive to the next Monday.
 *
 * UTC rather than the location's timezone, and Monday rather than Sunday,
 * because a digest window has to be comparable week over week and across a
 * chain's locations. A per-location timezone would make two branches'
 * "same week" different windows and their deltas incomparable.
 */
export function weekWindow(now: Date): { start: Date; end: Date } {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );

  // getUTCDay: 0 is Sunday. Shift so Monday is 0.
  const offset = (end.getUTCDay() + 6) % 7;
  end.setUTCDate(end.getUTCDate() - offset);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);

  // The window is the *completed* week: a digest generated on Wednesday
  // reports last Monday-to-Sunday, not three days of the current week.
  return { start, end };
}

/** The window immediately before this one. */
export function priorWindow(window: { start: Date; end: Date }): { start: Date; end: Date } {
  const start = new Date(window.start);
  start.setUTCDate(start.getUTCDate() - 7);
  return { start, end: new Date(window.start) };
}
