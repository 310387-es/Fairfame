import { describe, expect, it } from "vitest";
import {
  addOpenHours,
  isOpenAt,
  openMinutesBetween,
  parseBusinessHours,
} from "../../src/locations/opening-hours.ts";
import { slaDueAt } from "../../src/reviews/workflow.ts";
import {
  isQuietAt,
  quietWindowOf,
  sendAfter,
  clockToMinutes,
  minutesToClock,
} from "../../src/notifications/quiet-hours.ts";

/**
 * Opening hours and quiet hours (W5-8, W5-15).
 *
 * Both answer the same shape of question — "is now a moment when this counts?"
 * — and both are wrong in the same direction if they get midnight wrong, so
 * they are tested together.
 *
 * The headline for W5-8 is the audit's own complaint: *SLA counts weekends
 * today*. A one-star review at 19:00 on Friday against a four-hour target was
 * overdue at 23:00 on Friday, while the branch was shut. The last test in the
 * first block is that sentence as an assertion.
 *
 * Times are Europe/Istanbul (UTC+3), which is what all three of this codebase's
 * calendar modules assume — see the comment in `opening-hours.ts`.
 */

/** A weekday-only café: Mon–Fri 09:00–18:00, closed at weekends. */
const WEEKDAYS = parseBusinessHours([
  null, // Sunday
  { open: "09:00", close: "18:00" },
  { open: "09:00", close: "18:00" },
  { open: "09:00", close: "18:00" },
  { open: "09:00", close: "18:00" },
  { open: "09:00", close: "18:00" },
  null, // Saturday
])!;

/** A bar open every evening until 02:00 — the past-midnight case. */
const LATE = parseBusinessHours(
  Array.from({ length: 7 }, () => ({ open: "18:00", close: "02:00" })),
)!;

/** 2026-08-07 is a Friday. 19:00 Istanbul is 16:00Z. */
const FRIDAY_EVENING = new Date("2026-08-07T16:00:00.000Z");
/** 2026-08-05 is a Wednesday. 10:00 Istanbul is 07:00Z. */
const WEDNESDAY_MORNING = new Date("2026-08-05T07:00:00.000Z");

describe("parseBusinessHours", () => {
  it("reads a week", () => {
    expect(WEEKDAYS[1]).toEqual({ open: 540, close: 1080 });
    expect(WEEKDAYS[0]).toBeNull();
  });

  it("treats a close before its open as running past midnight", () => {
    // A bar open 18:00–02:00 stores 1560, not 120. Reading it as 120 would make
    // every night a negative-length window and silently disable the calendar.
    expect(LATE[1]).toEqual({ open: 1080, close: 1560 });
  });

  it("falls back to null for anything it does not recognise", () => {
    // jsonb, so a malformed value must cost a branch its calendar and not its
    // inbox — the rule `readOrgSlaHours` and `parseBranding` both follow.
    expect(parseBusinessHours(null)).toBeNull();
    expect(parseBusinessHours({ monday: "09:00" })).toBeNull();
    expect(parseBusinessHours([{ open: "25:00", close: "09:00" }])).toBeNull();
    expect(parseBusinessHours(Array.from({ length: 6 }, () => null))).toBeNull();
  });

  it("reads seven closed days as no schedule at all", () => {
    // Not "never open": a deadline that never arrives is worse than a wrong one.
    expect(parseBusinessHours(Array.from({ length: 7 }, () => null))).toBeNull();
  });
});

describe("addOpenHours", () => {
  it("counts only the hours the branch is open", () => {
    // Wednesday 10:00 + 4 open hours = Wednesday 14:00. Nothing exotic.
    const due = addOpenHours(WEDNESDAY_MORNING, 4, WEEKDAYS);
    expect(due?.toISOString()).toBe("2026-08-05T11:00:00.000Z");
  });

  it("carries an evening arrival into the next open day", () => {
    // Friday 19:00 is outside the window, so the clock starts Monday 09:00 and
    // four hours lands at 13:00. On a wall clock this was overdue at 23:00 on
    // Friday — the audit's complaint, as an assertion.
    const due = addOpenHours(FRIDAY_EVENING, 4, WEEKDAYS);
    expect(due?.toISOString()).toBe("2026-08-10T10:00:00.000Z");
  });

  it("spans several days when the target is longer than one", () => {
    // 12 open hours from Wednesday 10:00: 8 left on Wednesday, 4 on Thursday.
    const due = addOpenHours(WEDNESDAY_MORNING, 12, WEEKDAYS);
    expect(due?.toISOString()).toBe("2026-08-06T10:00:00.000Z");
  });

  it("handles a window that runs past midnight", () => {
    // Friday 19:00, open 18:00–02:00: one hour in already, so +4 is 23:00.
    const due = addOpenHours(FRIDAY_EVENING, 4, LATE);
    expect(due?.toISOString()).toBe("2026-08-07T20:00:00.000Z");
  });

  it("gives up rather than inventing a date a fortnight out", () => {
    const oneHourAWeek = parseBusinessHours([
      { open: "09:00", close: "10:00" },
      null,
      null,
      null,
      null,
      null,
      null,
    ])!;

    expect(addOpenHours(WEDNESDAY_MORNING, 100, oneHourAWeek)).toBeNull();
  });
});

describe("slaDueAt", () => {
  it("is unchanged for a branch with no opening hours", () => {
    // The feature is opt-in. Nobody's existing deadlines are reinterpreted by
    // this shipping.
    const plain = slaDueAt(FRIDAY_EVENING, 4);
    expect(plain?.toISOString()).toBe("2026-08-07T20:00:00.000Z");
    expect(slaDueAt(FRIDAY_EVENING, 4, null)).toEqual(plain);
  });

  it("uses the calendar when there is one", () => {
    expect(slaDueAt(FRIDAY_EVENING, 4, WEEKDAYS)?.toISOString()).toBe("2026-08-10T10:00:00.000Z");
  });

  it("falls back to the clock rather than leaving no deadline", () => {
    const oneHourAWeek = parseBusinessHours([
      { open: "09:00", close: "10:00" },
      null,
      null,
      null,
      null,
      null,
      null,
    ])!;

    // The overdue filter is the reason the column exists; a null here would
    // quietly take a review out of it for ever.
    expect(slaDueAt(WEDNESDAY_MORNING, 100, oneHourAWeek)).not.toBeNull();
  });
});

describe("openMinutesBetween / isOpenAt", () => {
  it("measures the open time inside a span", () => {
    const from = WEDNESDAY_MORNING;
    const to = new Date("2026-08-06T07:00:00.000Z"); // Thursday 10:00 local
    // 8 hours left on Wednesday, 1 hour on Thursday.
    expect(openMinutesBetween(from, to, WEEKDAYS)).toBe(9 * 60);
  });

  it("knows a bar is still open after midnight", () => {
    // 00:30 local on Saturday belongs to Friday's window.
    expect(isOpenAt(new Date("2026-08-07T21:30:00.000Z"), LATE)).toBe(true);
    expect(isOpenAt(new Date("2026-08-08T09:00:00.000Z"), LATE)).toBe(false);
  });

  it("is closed at the weekend for a weekday branch", () => {
    expect(isOpenAt(new Date("2026-08-08T09:00:00.000Z"), WEEKDAYS)).toBe(false);
  });
});

describe("quiet hours", () => {
  const NIGHT = quietWindowOf(22 * 60, 8 * 60)!;

  it("wraps midnight, which is the only shape anybody wants", () => {
    expect(isQuietAt(new Date("2026-08-07T20:00:00.000Z"), NIGHT)).toBe(true); // 23:00
    expect(isQuietAt(new Date("2026-08-08T00:40:00.000Z"), NIGHT)).toBe(true); // 03:40
    expect(isQuietAt(new Date("2026-08-08T09:00:00.000Z"), NIGHT)).toBe(false); // 12:00
  });

  it("releases at the end of the window", () => {
    // 03:40 → 08:00 the same morning.
    const held = sendAfter(new Date("2026-08-08T00:40:00.000Z"), NIGHT);
    expect(held?.toISOString()).toBe("2026-08-08T05:00:00.000Z");
  });

  it("releases the next morning for a late-evening alert", () => {
    // 23:00 on the 7th → 08:00 on the 8th.
    const held = sendAfter(new Date("2026-08-07T20:00:00.000Z"), NIGHT);
    expect(held?.toISOString()).toBe("2026-08-08T05:00:00.000Z");
  });

  it("returns null outside the window, and with no window at all", () => {
    // Null means "no delay was ever asked for", which is a different fact from
    // "the delay expired a millisecond ago" — and the sender's predicate reads
    // it that way.
    expect(sendAfter(new Date("2026-08-08T09:00:00.000Z"), NIGHT)).toBeNull();
    expect(sendAfter(new Date("2026-08-08T00:40:00.000Z"), null)).toBeNull();
  });

  it("refuses a zero-length window rather than reading it as a whole day", () => {
    // The failure this guards silences somebody's alerts for ever without
    // anybody choosing that.
    expect(quietWindowOf(480, 480)).toBeNull();
    expect(quietWindowOf(null, 480)).toBeNull();
    expect(quietWindowOf(-1, 480)).toBeNull();
  });

  it("round-trips a clock time", () => {
    expect(minutesToClock(clockToMinutes("22:30")!)).toBe("22:30");
    expect(minutesToClock(clockToMinutes("00:00")!)).toBe("00:00");
    expect(clockToMinutes("24:00")).toBeNull();
    expect(clockToMinutes("7:30")).toBeNull();
  });
});
