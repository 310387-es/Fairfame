import { describe, expect, it } from "vitest";
import { completedPeriod, isPeriodDue } from "@/reports/period";

/**
 * Which period a scheduled report covers (P3-T5).
 *
 * The module the whole feature's idempotency rests on. The sweep never asks
 * "has enough time passed since the last send" — it asks "which complete period
 * are we after", and the ledger is keyed by that answer. So every one of these
 * cases is really a question about whether a report can be sent twice, or
 * silently not at all.
 *
 * The awkward dates are the point: month ends, a leap February, and the two
 * Sundays a year when a timezone-aware implementation would be an hour out.
 */

describe("the weekly period", () => {
  it("covers the week that just ended, not the one in progress", () => {
    // Monday 3 August 2026, 09:00 UTC. The report that goes out this morning is
    // last week's — a report covering "the last seven days from now" would mean
    // two recipients got different windows depending on when the sweep fired.
    const period = completedPeriod("weekly", new Date("2026-08-03T09:00:00Z"));

    expect(period.start.toISOString()).toBe("2026-07-27T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-08-03T00:00:00.000Z");
  });

  it("starts on Monday, whatever day the sweep runs", () => {
    // Every day of one week must resolve to the same period, or a sweep that
    // ran on Wednesday would send a second, different report.
    const periods = ["2026-08-03T00:00:01Z", "2026-08-05T13:00:00Z", "2026-08-09T23:59:59Z"].map(
      (at) => completedPeriod("weekly", new Date(at)),
    );

    for (const period of periods) {
      expect(period.start.toISOString()).toBe("2026-07-27T00:00:00.000Z");
    }
  });

  it("treats Sunday as the last day of the week, not the first", () => {
    // `getUTCDay()` is 0 for Sunday. The naive version puts Sunday at the start
    // of a new week and ships the same report twice in two days.
    const sunday = completedPeriod("weekly", new Date("2026-08-02T12:00:00Z"));
    const saturday = completedPeriod("weekly", new Date("2026-08-01T12:00:00Z"));

    expect(sunday.start.toISOString()).toBe(saturday.start.toISOString());
    expect(sunday.start.toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("compares against the week before it", () => {
    const period = completedPeriod("weekly", new Date("2026-08-03T09:00:00Z"));

    expect(period.previous.start.toISOString()).toBe("2026-07-20T00:00:00.000Z");
    expect(period.previous.end.toISOString()).toBe(period.start.toISOString());
  });
});

describe("the monthly period", () => {
  it("covers the calendar month that just ended", () => {
    const period = completedPeriod("monthly", new Date("2026-08-05T09:00:00Z"));

    expect(period.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("uses calendar months, not thirty days", () => {
    // A "monthly" report measured in days drifts a day earlier every February
    // and eventually covers most of two months.
    const march = completedPeriod("monthly", new Date("2027-03-15T00:00:00Z"));

    expect(march.start.toISOString()).toBe("2027-02-01T00:00:00.000Z");
    expect(march.end.toISOString()).toBe("2027-03-01T00:00:00.000Z");
  });

  it("handles a leap February without a special case", () => {
    const period = completedPeriod("monthly", new Date("2028-03-02T00:00:00Z"));

    expect(period.start.toISOString()).toBe("2028-02-01T00:00:00.000Z");
    // 29 days in 2028.
    expect((period.end.getTime() - period.start.getTime()) / 86_400_000).toBe(29);
  });

  it("crosses a year boundary without arithmetic on the month number", () => {
    const january = completedPeriod("monthly", new Date("2027-01-04T00:00:00Z"));

    expect(january.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(january.previous.start.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("whether it is due", () => {
  it("is due the moment the period ends", () => {
    const period = completedPeriod("weekly", new Date("2026-08-03T00:00:00Z"));
    expect(isPeriodDue(period, new Date("2026-08-03T00:00:00Z"))).toBe(true);
  });

  it("resolves to the same period all week, so a late sweep sends once", () => {
    // Not a statement about `isPeriodDue` alone: the guarantee is that the
    // ledger key does not move, so a sweep that misses Monday and first runs on
    // Friday still sends Monday's report — once.
    const monday = completedPeriod("weekly", new Date("2026-08-03T06:00:00Z"));
    const friday = completedPeriod("weekly", new Date("2026-08-07T06:00:00Z"));

    expect(friday.start.getTime()).toBe(monday.start.getTime());
  });

  it("moves on once the next period closes", () => {
    const first = completedPeriod("weekly", new Date("2026-08-03T06:00:00Z"));
    const next = completedPeriod("weekly", new Date("2026-08-10T06:00:00Z"));

    expect(next.start.getTime()).toBeGreaterThan(first.start.getTime());
    expect(next.start.toISOString()).toBe(first.end.toISOString());
  });
});
