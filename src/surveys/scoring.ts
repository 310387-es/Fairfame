/**
 * What a survey answer means, and what a pile of them adds up to (P4-T2).
 *
 * Pure and db-free: the public answer page is a client component and needs the
 * scale, the results screen needs the arithmetic, and the Insights card needs
 * both. One definition, no database import — the `"use client"` rule in
 * CLAUDE.md makes that not merely tidy but load-bearing.
 *
 * The two scales are genuinely different instruments and are kept apart rather
 * than normalised into one 0–1 number. NPS asks about *likelihood to
 * recommend* on 0–10 and is reported as a net figure from −100 to 100; CSAT
 * asks about *satisfaction* on 1–5 and is reported as an average and a
 * satisfied share. Squashing them together would produce a figure that matches
 * nothing any business has ever been quoted.
 */

export const SURVEY_TYPES = ["nps", "csat"] as const;
export type SurveyType = (typeof SURVEY_TYPES)[number];

/**
 * The scale, per type. Inclusive at both ends.
 *
 * **NPS starts at 0 and CSAT starts at 1**, which is not a detail: an NPS 0 is
 * a real, meaningful answer ("would never recommend you") while a CSAT 0 does
 * not exist. A shared 1–10 scale would silently move every NPS detractor.
 */
export const SCALE: Record<SurveyType, { min: number; max: number }> = {
  nps: { min: 0, max: 10 },
  csat: { min: 1, max: 5 },
};

export function scalePoints(type: SurveyType): number[] {
  const { min, max } = SCALE[type];
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

export function isValidScore(type: SurveyType, score: number): boolean {
  const { min, max } = SCALE[type];
  return Number.isInteger(score) && score >= min && score <= max;
}

/**
 * Unhappy, neutral, happy.
 *
 * NPS's own vocabulary, used for both types on purpose. The *thresholds*
 * differ — a 6 is a detractor on 0–10 and does not exist on 1–5 — but the
 * *meaning* does not, and the detractor follow-up has to behave identically for
 * a 3/10 and a 1/5. Two parallel vocabularies would mean two follow-up rules,
 * and the second one would be the one nobody tested.
 */
export type SurveyBand = "detractor" | "passive" | "promoter";

/**
 * Thresholds, per type.
 *
 * NPS is Reichheld's standard split and is not ours to tune: 0–6 detractor,
 * 7–8 passive, 9–10 promoter. Every business that has seen an NPS before
 * expects those exact cuts, and a "improved" split would make our number
 * incomparable with the one they already track.
 *
 * CSAT's is the equally conventional one: 4–5 satisfied, 3 neutral, 1–2 not.
 */
export function bandFor(type: SurveyType, score: number): SurveyBand {
  if (type === "nps") {
    if (score >= 9) return "promoter";
    return score >= 7 ? "passive" : "detractor";
  }

  if (score >= 4) return "promoter";
  return score >= 3 ? "passive" : "detractor";
}

export type SurveyScore = {
  type: SurveyType;
  /** How many people actually answered. */
  responses: number;
  /**
   * NPS only, −100…100. Null for CSAT, and null with no responses.
   *
   * **Null rather than 0, and here that matters more than usual.** An NPS of
   * zero is a real and quite common result — as many promoters as detractors —
   * so a codebase that used 0 for "nobody answered" would show a business a
   * score it had genuinely not earned, in either direction. Same rule as
   * `src/analytics/trends.ts`, with sharper teeth.
   */
  nps: number | null;
  /** The mean answer on the type's own scale. Null with no responses. */
  average: number | null;
  /** Share in the top band, 0–1. Null with no responses. */
  satisfiedRate: number | null;
  counts: Record<SurveyBand, number>;
};

/**
 * Below this, the number is noise and the screen says so.
 *
 * Not a threshold that hides anything — the score is still shown, because a
 * business with six answers wants to see its six answers. It drives a caveat,
 * because NPS on a handful of responses swings fifty points on one more reply
 * and somebody will otherwise put it in a board pack.
 */
export const MIN_MEANINGFUL_RESPONSES = 10;

/** Rounds half away from zero, so −0.5 is −1 rather than −0. */
function roundAway(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Scores a set of answers.
 *
 * Takes raw scores rather than rows, so it is testable without a database and
 * cannot accidentally depend on a column that is not in the projection.
 * Anything off the type's scale is **dropped rather than clamped**: a clamped
 * value is an invented answer, and the database already refuses to store one.
 */
export function scoreSurvey(type: SurveyType, scores: readonly number[]): SurveyScore {
  const valid = scores.filter((score) => isValidScore(type, score));
  const counts: Record<SurveyBand, number> = { detractor: 0, passive: 0, promoter: 0 };

  for (const score of valid) counts[bandFor(type, score)] += 1;

  if (valid.length === 0) {
    return { type, responses: 0, nps: null, average: null, satisfiedRate: null, counts };
  }

  const total = valid.length;
  const average = valid.reduce((sum, score) => sum + score, 0) / total;

  return {
    type,
    responses: total,
    nps:
      type === "nps"
        ? roundAway(((counts.promoter - counts.detractor) / total) * 100)
        : // CSAT has no net score. Reporting one would be inventing a figure
          // nobody asked for out of a scale it was not measured on.
          null,
    average,
    satisfiedRate: counts.promoter / total,
    counts,
  };
}

/**
 * The headline figure for a type, as a number plus how to read it.
 *
 * Returned rather than formatted, because formatting is the caller's job and
 * this module must stay locale-free — Turkish writes 4,3 where English writes
 * 4.3, and `Intl` on the server is what settles that.
 */
export function headline(score: SurveyScore): {
  kind: "nps" | "average";
  value: number | null;
  /** Decimal places the value should be shown with. */
  digits: number;
} {
  return score.type === "nps"
    ? { kind: "nps", value: score.nps, digits: 0 }
    : { kind: "average", value: score.average, digits: 1 };
}
