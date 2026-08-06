import { describe, expect, it } from "vitest";
import {
  computePriority,
  DEFAULT_SLA_HOURS,
  readOrgSlaHours,
  resolveSlaHours,
  slaDueAt,
} from "@/reviews/workflow";

/**
 * Triage derivation (P2-T1).
 *
 * The formula behind `reviews.priority` and `reviews.sla_due_at`. Pure, so it is
 * tested without a database — and it needs to be tested, because these are the
 * two numbers in the product that nobody enters and therefore nobody would
 * notice being quietly wrong.
 */

describe("computePriority", () => {
  it("ranks an unanswered negative review above an unanswered positive one", () => {
    const negative = computePriority({ rating: 1, sentiment: "negative", answered: false });
    const positive = computePriority({ rating: 5, sentiment: "positive", answered: false });

    expect(negative).toBeGreaterThan(positive);
  });

  it("sinks a review once it has been answered", () => {
    const before = computePriority({ rating: 2, sentiment: "negative", answered: false });
    const after = computePriority({ rating: 2, sentiment: "negative", answered: true });

    expect(after).toBeLessThan(before);
  });

  it("still ranks an answered one-star above an unanswered five-star", () => {
    // Answering something does not make it uninteresting. This is the ordering
    // an "everything" view depends on.
    expect(computePriority({ rating: 1, sentiment: "negative", answered: true })).toBeGreaterThan(
      computePriority({ rating: 5, sentiment: "positive", answered: false }),
    );
  });

  it("scores on the rating alone before the analysis has run", () => {
    const unanalyzed = computePriority({ rating: 1, sentiment: null, answered: false });

    expect(unanalyzed).toBeGreaterThan(
      computePriority({ rating: 4, sentiment: null, answered: false }),
    );
  });

  it("takes the harsher of a rating and an analysis that disagree", () => {
    // Sarcasm, and mis-clicked stars. Triage errs toward a human looking.
    const sarcastic = computePriority({ rating: 1, sentiment: "positive", answered: false });
    const consistent = computePriority({ rating: 1, sentiment: "negative", answered: false });

    expect(sarcastic).toBe(consistent);
  });

  it("gives an unrated, unanalyzed item a middling score", () => {
    // A fresh Instagram comment: no stars to read, no analysis yet. It must not
    // jump the queue, and must not sink below a five-star nobody needs to read.
    const unknown = computePriority({ rating: null, sentiment: null, answered: false });

    expect(unknown).toBeGreaterThan(
      computePriority({ rating: 5, sentiment: null, answered: true }),
    );
    expect(unknown).toBeLessThan(computePriority({ rating: 1, sentiment: null, answered: false }));
  });

  it("stays inside the range the check constraint allows", () => {
    const ratings = [null, 1, 2, 3, 4, 5] as const;
    const sentiments = [null, "negative", "neutral", "positive"] as const;

    for (const rating of ratings) {
      for (const sentiment of sentiments) {
        for (const answered of [true, false]) {
          const score = computePriority({ rating, sentiment, answered });
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(100);
          expect(Number.isInteger(score)).toBe(true);
        }
      }
    }
  });
});

describe("resolveSlaHours", () => {
  it("prefers the location's own target", () => {
    expect(resolveSlaHours(4, { inbox: { slaHours: 48 } })).toBe(4);
  });

  it("falls through to the organization when the location has none", () => {
    expect(resolveSlaHours(null, { inbox: { slaHours: 48 } })).toBe(48);
  });

  it("falls through to the default when neither is set", () => {
    expect(resolveSlaHours(null, {})).toBe(DEFAULT_SLA_HOURS);
    expect(resolveSlaHours(null, null)).toBe(DEFAULT_SLA_HOURS);
  });

  it("ignores a malformed settings blob rather than failing the inbox", () => {
    expect(readOrgSlaHours({ inbox: { slaHours: "soon" } })).toBeNull();
    expect(readOrgSlaHours("not an object")).toBeNull();
    expect(resolveSlaHours(null, { inbox: { slaHours: -3 } })).toBe(DEFAULT_SLA_HOURS);
  });
});

describe("slaDueAt", () => {
  it("adds the target to the posted time", () => {
    const posted = new Date("2026-08-03T09:00:00.000Z");

    expect(slaDueAt(posted, 4)?.toISOString()).toBe("2026-08-03T13:00:00.000Z");
  });

  it("does not pause over a weekend", () => {
    // Wall-clock on purpose: a customer waiting on a Saturday is waiting.
    const saturday = new Date("2026-08-01T09:00:00.000Z");

    expect(slaDueAt(saturday, 24)?.toISOString()).toBe("2026-08-02T09:00:00.000Z");
  });

  it("has no deadline without a posted time or without a target", () => {
    expect(slaDueAt(null, 24)).toBeNull();
    expect(slaDueAt(new Date(), undefined)).toBeNull();
  });
});
