import { afterEach, describe, expect, it } from "vitest";
import {
  addBusinessDays,
  beyondKnownHolidays,
  isBusinessDay,
  istanbulDate,
  iysUploadDeadline,
  IYS_UPLOAD_BUSINESS_DAYS,
  holidayCalendarMonthsLeft,
  MOVABLE_HOLIDAYS_KNOWN_THROUGH,
  setExtraHolidays,
} from "@/compliance/business-days";

/**
 * Turkish business days (P1b-T5).
 *
 * İYS gives three business days to upload a self-collected consent, so an
 * off-by-one here is a compliance failure rather than a cosmetic bug — and one
 * nobody would notice, because the deadline is only ever checked against itself.
 *
 * The cases below are the ones where "three days" and "three business days"
 * actually diverge: weekends, fixed holidays, and the multi-day religious
 * holidays where the two can differ by a week.
 */

afterEach(() => {
  setExtraHolidays([]);
});

/** Noon Istanbul, so a test never straddles a day boundary by accident. */
function at(date: string): Date {
  return new Date(`${date}T12:00:00+03:00`);
}

describe("the Istanbul day", () => {
  it("uses Turkish local time, not the server's", () => {
    // 22:30 UTC on the 20th is 01:30 on the 21st in Istanbul. A deadline
    // computed in UTC would be a day early for anyone submitting at night.
    expect(istanbulDate(new Date("2026-07-20T22:30:00Z"))).toBe("2026-07-21");
  });
});

describe("which days count", () => {
  it("excludes Saturday and Sunday", () => {
    expect(isBusinessDay(at("2026-07-18"))).toBe(false); // Saturday
    expect(isBusinessDay(at("2026-07-19"))).toBe(false); // Sunday
    expect(isBusinessDay(at("2026-07-20"))).toBe(true); // Monday
  });

  it("excludes the fixed national holidays", () => {
    expect(isBusinessDay(at("2026-04-23"))).toBe(false);
    expect(isBusinessDay(at("2026-10-29"))).toBe(false);
    expect(isBusinessDay(at("2026-01-01"))).toBe(false);
  });

  it("excludes the religious holidays, which move each year", () => {
    // Kurban Bayramı 2026 — four days, and the reason a hard-coded list exists:
    // there is no rule reliable enough to compute these.
    expect(isBusinessDay(at("2026-05-26"))).toBe(false);
    expect(isBusinessDay(at("2026-05-29"))).toBe(false);
    // And the same holiday in a different year, ten weeks earlier.
    expect(isBusinessDay(at("2027-05-18"))).toBe(false);

    // Each extension year, first and last day of both bayrams. An off-by-one
    // when the list is renewed moves a legal deadline, and nothing else in the
    // suite would notice.
    expect(isBusinessDay(at("2028-02-27"))).toBe(false); // Ramazan 2028, day 1
    expect(isBusinessDay(at("2028-02-29"))).toBe(false); // day 3, leap year
    expect(isBusinessDay(at("2028-05-05"))).toBe(false); // Kurban 2028, day 1
    expect(isBusinessDay(at("2028-05-08"))).toBe(false); // day 4
    expect(isBusinessDay(at("2029-02-15"))).toBe(false);
    expect(isBusinessDay(at("2029-04-27"))).toBe(false);
    expect(isBusinessDay(at("2030-02-04"))).toBe(false);
    expect(isBusinessDay(at("2030-04-16"))).toBe(false);
  });

  it("treats arife as a working day, erring toward the shorter deadline", () => {
    // Arife is a half working day. Counting it as a holiday would lengthen
    // every deadline that straddles it, and being late to İYS is the fineable
    // direction — being early costs nothing.
    expect(isBusinessDay(at("2028-02-25"))).toBe(true); // Friday before arife
    expect(isBusinessDay(at("2030-04-12"))).toBe(true); // Kurban 2030 arifesi
  });

  it("honours a deployment's extra dates", () => {
    expect(isBusinessDay(at("2026-07-20"))).toBe(true);
    setExtraHolidays(["2026-07-20"]);
    expect(isBusinessDay(at("2026-07-20"))).toBe(false);
  });
});

describe("counting forward", () => {
  it("starts from the next day, not the same one", () => {
    // Consent at 09:00 Monday is due end of Thursday. Counting the collection
    // day itself would shave a day off a legal window.
    const due = addBusinessDays(new Date("2026-07-20T09:00:00+03:00"), 3);
    expect(istanbulDate(due)).toBe("2026-07-23");
  });

  it("lands at the end of the day, not the same clock time", () => {
    const due = addBusinessDays(new Date("2026-07-20T21:00:00+03:00"), 3);

    // A deadline is a day, not a moment. Carrying the time forward would give
    // an evening submission three hours less than a morning one.
    expect(due.toISOString()).toBe("2026-07-23T20:59:59.999Z");
  });

  it("skips the weekend", () => {
    // Thursday + 3 business days = Tuesday, five calendar days later.
    expect(istanbulDate(addBusinessDays(at("2026-07-23"), 3))).toBe("2026-07-28");
  });

  it("skips a fixed holiday in the middle", () => {
    // 29 October 2026 is a Thursday. Tuesday + 3 → Monday, not Friday.
    expect(istanbulDate(addBusinessDays(at("2026-10-27"), 3))).toBe("2026-11-02");
  });

  it("survives a multi-day religious holiday", () => {
    // Kurban Bayramı runs 26-29 May 2026 (Tue-Fri). Consent on Monday the 25th
    // is not due until Wednesday 3 June — nine calendar days.
    const due = addBusinessDays(at("2026-05-25"), 3);
    expect(istanbulDate(due)).toBe("2026-06-03");
  });

  it("is the difference between three days and three business days", () => {
    // The whole reason this module exists: over that holiday, a naive
    // calculation would have been six days early.
    const naive = new Date(at("2026-05-25").getTime() + 3 * 24 * 60 * 60 * 1_000);
    const correct = addBusinessDays(at("2026-05-25"), 3);

    expect(correct.getTime() - naive.getTime()).toBeGreaterThan(5 * 24 * 60 * 60 * 1_000);
  });
});

describe("the İYS deadline", () => {
  it("is three business days", () => {
    expect(IYS_UPLOAD_BUSINESS_DAYS).toBe(3);
    expect(iysUploadDeadline(at("2026-07-20")).toISOString()).toBe(
      addBusinessDays(at("2026-07-20"), 3).toISOString(),
    );
  });

  it("says when it has outrun the holiday calendar", () => {
    // Past the list, the answer silently ignores four to seven holidays a year.
    // Better to know than to be quietly wrong.
    expect(beyondKnownHolidays(at(`${MOVABLE_HOLIDAYS_KNOWN_THROUGH}-06-01`))).toBe(false);
    expect(beyondKnownHolidays(at(`${MOVABLE_HOLIDAYS_KNOWN_THROUGH + 1}-06-01`))).toBe(true);
  });

  it("counts down the runway so the calendar cannot lapse quietly", () => {
    // The point is the warning arriving *before* the last date. Renewing means
    // looking up officially published dates — a task with a lead time.
    expect(holidayCalendarMonthsLeft(at(`${MOVABLE_HOLIDAYS_KNOWN_THROUGH}-12-01`))).toBe(0);
    expect(holidayCalendarMonthsLeft(at(`${MOVABLE_HOLIDAYS_KNOWN_THROUGH}-01-01`))).toBe(11);
    expect(holidayCalendarMonthsLeft(at(`${MOVABLE_HOLIDAYS_KNOWN_THROUGH - 1}-08-01`))).toBe(16);
    // Past the end it goes negative, which `golive` reports as blocked.
    expect(
      holidayCalendarMonthsLeft(at(`${MOVABLE_HOLIDAYS_KNOWN_THROUGH + 1}-06-01`)),
    ).toBeLessThan(0);
  });
});
