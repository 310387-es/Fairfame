import { describe, expect, it } from "vitest";
import {
  bandFor,
  headline,
  isValidScore,
  MIN_MEANINGFUL_RESPONSES,
  scoreSurvey,
} from "@/surveys/scoring";

/**
 * Survey arithmetic (P4-T2).
 *
 * Pure, so the whole rule fits in a file with no database. The property most
 * worth pinning is the null one: **an NPS of 0 is a real result**, so "nobody
 * answered" must not render as it. Every other module — the survey list, the
 * results page, the Insights card — reads its number from here, so getting this
 * wrong would be wrong in three places at once.
 */

describe("bands", () => {
  it("uses the standard NPS cuts", () => {
    // Reichheld's split, and not ours to improve: a business that already
    // tracks NPS expects these exact cuts, and a "better" one would make our
    // number incomparable with theirs.
    expect([0, 3, 6].map((score) => bandFor("nps", score))).toEqual([
      "detractor",
      "detractor",
      "detractor",
    ]);
    expect([7, 8].map((score) => bandFor("nps", score))).toEqual(["passive", "passive"]);
    expect([9, 10].map((score) => bandFor("nps", score))).toEqual(["promoter", "promoter"]);
  });

  it("uses CSAT's own middle, which is not NPS's", () => {
    expect([1, 2].map((score) => bandFor("csat", score))).toEqual(["detractor", "detractor"]);
    expect(bandFor("csat", 3)).toBe("passive");
    expect([4, 5].map((score) => bandFor("csat", score))).toEqual(["promoter", "promoter"]);
  });
});

describe("validity", () => {
  it("refuses a score off the instrument's scale", () => {
    expect(isValidScore("nps", 0)).toBe(true);
    expect(isValidScore("nps", 10)).toBe(true);
    expect(isValidScore("nps", 11)).toBe(false);
    // A CSAT 0 does not exist, even though the database's floor allows it.
    expect(isValidScore("csat", 0)).toBe(false);
    expect(isValidScore("csat", 5)).toBe(true);
    expect(isValidScore("csat", 3.5)).toBe(false);
  });
});

describe("scoring", () => {
  it("returns null, never zero, when nobody answered", () => {
    const score = scoreSurvey("nps", []);
    expect(score.responses).toBe(0);
    expect(score.nps).toBeNull();
    expect(score.average).toBeNull();
    expect(score.satisfiedRate).toBeNull();
  });

  it("returns a genuine zero when promoters and detractors balance", () => {
    // The reason the case above must be null: this is what 0 actually means.
    const score = scoreSurvey("nps", [10, 0]);
    expect(score.nps).toBe(0);
    expect(score.responses).toBe(2);
  });

  it("computes NPS as promoters minus detractors, as a percentage", () => {
    // 6 promoters, 2 passives, 2 detractors → 60 − 20 = 40.
    const scores = [10, 10, 10, 9, 9, 9, 8, 7, 3, 0];
    expect(scoreSurvey("nps", scores).nps).toBe(40);
  });

  it("rounds a negative score away from zero rather than to −0", () => {
    // 1 promoter, 2 detractors of 3 → −33.33…, which must print as −33.
    const score = scoreSurvey("nps", [10, 2, 1]);
    expect(score.nps).toBe(-33);
    expect(Object.is(score.nps, -0)).toBe(false);
  });

  it("gives CSAT an average and a satisfied share, and no net score", () => {
    const score = scoreSurvey("csat", [5, 4, 3, 1]);
    expect(score.average).toBeCloseTo(3.25, 5);
    expect(score.satisfiedRate).toBeCloseTo(0.5, 5);
    // Reporting a net score for CSAT would invent a figure from a scale it was
    // never measured on.
    expect(score.nps).toBeNull();
  });

  it("drops an out-of-range answer rather than clamping it", () => {
    // Clamping invents an answer. The database refuses to store one, and this
    // refuses to count one that arrived some other way.
    const score = scoreSurvey("csat", [5, 9, 0, 4]);
    expect(score.responses).toBe(2);
    expect(score.average).toBeCloseTo(4.5, 5);
  });

  it("counts the bands", () => {
    const score = scoreSurvey("nps", [10, 9, 8, 6, 0]);
    expect(score.counts).toEqual({ promoter: 2, passive: 1, detractor: 2 });
  });
});

describe("headline", () => {
  it("reports NPS whole and CSAT to one decimal", () => {
    expect(headline(scoreSurvey("nps", [10, 10]))).toEqual({
      kind: "nps",
      value: 100,
      digits: 0,
    });

    const csat = headline(scoreSurvey("csat", [5, 4]));
    expect(csat.kind).toBe("average");
    expect(csat.digits).toBe(1);
    expect(csat.value).toBeCloseTo(4.5, 5);
  });

  it("carries the null through rather than substituting a number", () => {
    expect(headline(scoreSurvey("nps", [])).value).toBeNull();
    expect(headline(scoreSurvey("csat", [])).value).toBeNull();
  });
});

describe("small samples", () => {
  it("names a threshold the screens can caveat with", () => {
    // Not a threshold that hides anything — a business with six answers wants
    // to see its six answers. It drives a warning, because NPS on a handful
    // swings fifty points on one more reply.
    expect(MIN_MEANINGFUL_RESPONSES).toBeGreaterThan(1);
    expect(scoreSurvey("nps", [10, 0]).responses).toBeLessThan(MIN_MEANINGFUL_RESPONSES);
  });
});
