/**
 * How a rating axis is scaled (W4 fold-in, `docs/remediation-plan.md` line 103).
 *
 * No imports, deliberately: both charts that use this are `"use client"`, and a
 * client file that pulls in a module reaching the database fails the build on a
 * missing Node built-in. It is also the reason this is a `.ts` beside the design
 * system's components rather than a helper inside one of them — two charts
 * sharing an axis by copy is two charts that eventually disagree about it.
 *
 * ## Why not the fixed 1–5 scale it replaces
 *
 * Both rating charts pinned the axis to `[1, 5]`, with a stated reason: an
 * auto-fitted axis turns a 4.4 → 4.5 wobble into a cliff. That reason is right
 * about *unpadded* auto-fit, and it was the wrong fix. On the fixed scale a real
 * business — which lives between about 4.1 and 4.7 — gets a flat line in the top
 * fifth of the box, and the chart answers "how are we moving" with a shrug.
 *
 * The audit asks for `[min - 0.3, max + 0.3]`, and the padding is the whole
 * point: it is what stops the zoom from becoming the cliff. A range of 4.4–4.5
 * gets a 0.8-wide window rather than a 0.1-wide one, so the movement is a
 * quarter of the height instead of the entire height. Both failure modes are
 * bounded by the same constant.
 *
 * The result is then clamped into `[1, 5]`, because there is no such thing as a
 * 5.3-star review, and rounded outward to the tick step so the axis labels land
 * on the edges of the box rather than floating inside it.
 */

/** The audit's figure. Bigger flattens real movement; smaller re-creates the cliff. */
const PADDING = 0.3;

/** Star ratings live here and nowhere else. */
const FLOOR = 1;
const CEILING = 5;

/**
 * Tick steps, coarsest last.
 *
 * Chosen so a padded window always yields three to five gridlines: fewer reads
 * as an unlabelled box, more turns the axis into a ruler.
 */
const STEPS = [0.25, 0.5, 1] as const;

export type RatingScale = {
  domain: [number, number];
  ticks: number[];
  /** Decimals the tick labels need. 0.25 steps written as whole numbers repeat. */
  decimals: number;
};

/**
 * The axis for a set of rating points.
 *
 * `null` is absence, not zero — the codebase's rule since W3.3 — so nulls are
 * dropped rather than dragging the floor to the bottom of the scale. With
 * nothing to measure at all, the full 1–5 is the honest answer: an empty chart
 * should not claim a zoomed-in view of data it does not have.
 */
export function ratingScale(values: readonly (number | null | undefined)[]): RatingScale {
  const present = values.filter((value): value is number => typeof value === "number");

  if (present.length === 0) {
    return { domain: [FLOOR, CEILING], ticks: [1, 2, 3, 4, 5], decimals: 0 };
  }

  const low = Math.max(FLOOR, Math.min(...present) - PADDING);
  const high = Math.min(CEILING, Math.max(...present) + PADDING);

  const step = STEPS.find((candidate) => (high - low) / candidate <= 4) ?? STEPS[STEPS.length - 1]!;

  // Outward to the step, then back inside the star scale — rounding out can
  // push past 5, and an axis that ticks at 5.25 is claiming a rating nobody can
  // give.
  const from = Math.max(FLOOR, roundTo(low, step, Math.floor));
  const to = Math.min(CEILING, roundTo(high, step, Math.ceil));

  const ticks: number[] = [];
  // Accumulating with `+= step` drifts on 0.25 (0.75 + 0.25 = 1.0000000000000002
  // is enough for Recharts to render a second label at the same place), so the
  // ticks are computed from the index instead.
  for (let index = 0; from + index * step <= to + 1e-9; index += 1) {
    ticks.push(round2(from + index * step));
  }

  return { domain: [from, to], ticks, decimals: step < 1 ? 1 : 0 };
}

function roundTo(value: number, step: number, direction: (value: number) => number): number {
  return round2(direction(value / step) * step);
}

/** Two decimals is enough for every step here and kills the float noise. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
