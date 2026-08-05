import { describe, expect, it } from "vitest";
import { slaState } from "@/inbox/workflow";

/**
 * The SLA clock (P2-T4).
 *
 * A deadline is a promise, so the interesting cases are the ones where saying
 * the wrong thing is worse than saying nothing: an item that never had a
 * deadline, and one that was resolved without a reply. Both must render as
 * "no state" rather than as a failure.
 */

const now = new Date("2026-08-03T12:00:00.000Z");
const hoursFromNow = (hours: number) => new Date(now.getTime() + hours * 3_600_000);

const review = (overrides: Partial<Parameters<typeof slaState>[0]> = {}) => ({
  slaDueAt: hoursFromNow(12),
  firstResponseAt: null,
  ownerRepliedAt: null,
  status: "open" as const,
  postedAt: hoursFromNow(-12),
  ...overrides,
});

describe("slaState", () => {
  it("says nothing about an item that never had a deadline", () => {
    expect(slaState(review({ slaDueAt: null }), now)).toBe("none");
  });

  it("is ok while there is plenty of time", () => {
    expect(slaState(review({ slaDueAt: hoursFromNow(20), postedAt: hoursFromNow(-4) }), now)).toBe(
      "ok",
    );
  });

  it("warns as the window runs out", () => {
    // A 24-hour window with 3 hours left: inside the last quarter.
    expect(slaState(review({ slaDueAt: hoursFromNow(3), postedAt: hoursFromNow(-21) }), now)).toBe(
      "due_soon",
    );
  });

  it("measures how much of the promise is left, not how many hours", () => {
    // The same three hours remaining, two different answers. On a four-hour
    // promise only a quarter of the time has gone, so there is no hurry; on a
    // twelve-hour one three quarters has gone and the window is closing. A
    // fixed "warn at three hours" would call both of these the same thing.
    const fourHourTarget = review({ slaDueAt: hoursFromNow(3), postedAt: hoursFromNow(-1) });
    const twelveHourTarget = review({ slaDueAt: hoursFromNow(3), postedAt: hoursFromNow(-9) });

    expect(slaState(fourHourTarget, now)).toBe("ok");
    expect(slaState(twelveHourTarget, now)).toBe("due_soon");
  });

  it("is overdue once the deadline has passed", () => {
    expect(slaState(review({ slaDueAt: hoursFromNow(-1) }), now)).toBe("overdue");
  });

  it("stops changing once someone has answered", () => {
    const answered = review({
      slaDueAt: hoursFromNow(-5),
      firstResponseAt: hoursFromNow(-8),
    });

    // Late by the clock, but answered before the deadline — and it stays "met"
    // however long ago that was.
    expect(slaState(answered, now)).toBe("met");
    expect(slaState(answered, hoursFromNow(1000))).toBe("met");
  });

  it("records an answer that arrived after the deadline as missed", () => {
    expect(
      slaState(review({ slaDueAt: hoursFromNow(-8), firstResponseAt: hoursFromNow(-2) }), now),
    ).toBe("missed");
  });

  it("does not scold a resolved item that never needed a reply", () => {
    // Someone phoned the customer, or it was spam. There is no response time to
    // judge, and a permanent red badge would be a reproach for work that was done.
    expect(slaState(review({ slaDueAt: hoursFromNow(-40), status: "done" }), now)).toBe("none");
    expect(slaState(review({ slaDueAt: hoursFromNow(-40), status: "ignored" }), now)).toBe("none");
  });

  it("still reports an unresolved item as overdue", () => {
    expect(slaState(review({ slaDueAt: hoursFromNow(-40), status: "in_progress" }), now)).toBe(
      "overdue",
    );
  });

  it("falls back to the default window when there is no posted time", () => {
    expect(slaState(review({ postedAt: null, slaDueAt: hoursFromNow(1) }), now)).toBe("due_soon");
    expect(slaState(review({ postedAt: null, slaDueAt: hoursFromNow(20) }), now)).toBe("ok");
  });

  /**
   * An answer the owner left on the platform (W1.2).
   *
   * This is the whole fake-overdue bug in one place: before the column existed
   * these reviews had a null `first_response_at`, so a review the owner had
   * personally answered in Google went red and stayed red.
   */
  describe("an answer given on the platform", () => {
    it("stops the clock exactly as our own reply does", () => {
      const answeredInGoogle = review({
        slaDueAt: hoursFromNow(-5),
        firstResponseAt: null,
        ownerRepliedAt: hoursFromNow(-8),
      });

      expect(slaState(answeredInGoogle, now)).toBe("met");
      expect(slaState(answeredInGoogle, hoursFromNow(1000))).toBe("met");
    });

    it("is judged against the deadline like any other answer", () => {
      expect(
        slaState(
          review({ slaDueAt: hoursFromNow(-8), firstResponseAt: null, ownerRepliedAt: null }),
          now,
        ),
      ).toBe("overdue");

      expect(
        slaState(
          review({
            slaDueAt: hoursFromNow(-8),
            firstResponseAt: null,
            ownerRepliedAt: hoursFromNow(-2),
          }),
          now,
        ),
      ).toBe("missed");
    });

    it("yields to the response we measured ourselves", () => {
      // Both exist: the platform's timestamp is what we were told, ours is what
      // we observed, and response-time figures are built on the latter. Here
      // they disagree across the deadline, so which one wins is visible.
      expect(
        slaState(
          review({
            slaDueAt: hoursFromNow(-6),
            firstResponseAt: hoursFromNow(-9),
            ownerRepliedAt: hoursFromNow(-2),
          }),
          now,
        ),
      ).toBe("met");
    });
  });
});
