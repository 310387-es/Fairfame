import { describe, expect, it } from "vitest";
import { ratingScale } from "../../src/components/ds/chart-scale.ts";

/**
 * The rating axis (W4 fold-in — `docs/remediation-plan.md` line 103).
 *
 * The two failure modes this has to hold off at once are opposites, so most of
 * these tests are about the *bounds* rather than about a particular window:
 *
 *   - Pinned to 1–5, a business sitting between 4.1 and 4.7 draws a flat line
 *     in the top fifth of the box and the chart says nothing.
 *   - Fitted with no padding, a 4.4 → 4.5 wobble fills the whole height and the
 *     chart says something false.
 *
 * The ±0.3 padding is what makes both bounded, so the assertions here are that
 * a real window is never narrower than the padding allows and never leaves the
 * star scale.
 */

describe("ratingScale", () => {
  it("zooms in on a business that lives in the high fours", () => {
    const { domain } = ratingScale([4.4, 4.5, 4.4, 4.6]);
    expect(domain[0]).toBeGreaterThan(3.5);
    expect(domain[1]).toBeLessThanOrEqual(5);
  });

  it("never draws a window narrower than the padding allows", () => {
    // A perfectly flat series is the worst case: with no padding its window is
    // zero wide, and every point sits on the axis line.
    const { domain } = ratingScale([4.4, 4.4, 4.4]);
    expect(domain[1] - domain[0]).toBeGreaterThanOrEqual(0.5);
  });

  it("never leaves the star scale", () => {
    for (const values of [
      [5, 5, 5],
      [1, 1],
      [1, 5],
      [4.9, 5],
    ]) {
      const { domain, ticks } = ratingScale(values);
      expect(domain[0]).toBeGreaterThanOrEqual(1);
      expect(domain[1]).toBeLessThanOrEqual(5);
      for (const tick of ticks) {
        expect(tick).toBeGreaterThanOrEqual(1);
        expect(tick).toBeLessThanOrEqual(5);
      }
    }
  });

  it("keeps every value inside the window it draws", () => {
    const values = [3.2, 4.8, 4.1, 2.9];
    const { domain } = ratingScale(values);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(domain[0]);
      expect(value).toBeLessThanOrEqual(domain[1]);
    }
  });

  it("treats null as absence, not as zero", () => {
    // W3.3's rule. A null dragged to the floor would pin every axis to 1.
    const withNulls = ratingScale([null, 4.5, null, 4.6, undefined]);
    expect(withNulls).toEqual(ratingScale([4.5, 4.6]));
  });

  it("shows the whole scale when there is nothing to fit", () => {
    // An empty chart claiming a zoomed-in view is claiming data it lacks.
    expect(ratingScale([])).toEqual({ domain: [1, 5], ticks: [1, 2, 3, 4, 5], decimals: 0 });
    expect(ratingScale([null, null]).domain).toEqual([1, 5]);
  });

  it("puts three to five gridlines on the axis, whatever the spread", () => {
    for (const values of [
      [4.4, 4.5],
      [3, 5],
      [1, 5],
      [2.2, 2.4],
      [4.95, 5],
    ]) {
      const { ticks } = ratingScale(values);
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      expect(ticks.length).toBeLessThanOrEqual(5);
    }
  });

  it("ticks the ends of its own window", () => {
    const { domain, ticks } = ratingScale([4.4, 4.5]);
    expect(ticks[0]).toBe(domain[0]);
    expect(ticks[ticks.length - 1]).toBe(domain[1]);
  });

  it("emits no duplicate ticks — float drift is how that happens", () => {
    for (const values of [
      [4.4, 4.5],
      [3.1, 4.9],
      [1.2, 1.3],
    ]) {
      const { ticks } = ratingScale(values);
      expect(new Set(ticks).size).toBe(ticks.length);
      // And the labels are formatted at the stated precision, so two ticks
      // must not round to the same string either.
      const { decimals } = ratingScale(values);
      expect(new Set(ticks.map((tick) => tick.toFixed(decimals))).size).toBe(ticks.length);
    }
  });

  it("asks for a decimal only when the step needs one", () => {
    expect(ratingScale([1, 5]).decimals).toBe(0);
    expect(ratingScale([4.4, 4.5]).decimals).toBe(1);
  });
});
