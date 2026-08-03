/**
 * Turkish business days (P1b-T5).
 *
 * İYS gives a business **three business days** to upload a consent it collected
 * itself. Missing that window is a compliance failure regardless of whether any
 * message was ever sent, so the deadline has to be computed rather than
 * approximated — "three days" and "three business days" differ by up to four
 * calendar days over a holiday weekend, which is exactly when a backlog builds.
 *
 * Pure, and timezone-explicit: the deadline is a Turkish legal one, so the day
 * boundaries are Europe/Istanbul (UTC+3, no daylight saving since 2016) rather
 * than the server's.
 */

/** Türkiye has been on permanent UTC+3 since 2016. */
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1_000;

/**
 * Fixed-date national holidays.
 *
 * `MM-DD`. These do not move.
 *
 * Half-days are deliberately absent: the afternoon of 28 October and the
 * morning of 23 April are public holidays in practice, but treating a half-day
 * as a working day is the conservative direction — it can only make a deadline
 * earlier, never later.
 */
const FIXED_HOLIDAYS = new Set([
  "01-01", // Yılbaşı
  "04-23", // Ulusal Egemenlik ve Çocuk Bayramı
  "05-01", // Emek ve Dayanışma Günü
  "05-19", // Atatürk'ü Anma, Gençlik ve Spor Bayramı
  "07-15", // Demokrasi ve Millî Birlik Günü
  "08-30", // Zafer Bayramı
  "10-29", // Cumhuriyet Bayramı
]);

/**
 * Religious holidays, which move with the lunar calendar.
 *
 * **This list needs maintaining once a year.** There is no closed-form rule for
 * Ramazan and Kurban Bayramı that is reliable enough to compute — the official
 * Turkish dates are announced by the state, and an off-by-one here moves a
 * legal deadline. When the list runs out, `movableHolidaysKnownThrough` says so
 * and the caller can decide whether to trust the result.
 *
 * Dates below are the officially published Turkish public holidays.
 */
const MOVABLE_HOLIDAYS = new Set([
  // Ramazan Bayramı 2026
  "2026-03-19",
  "2026-03-20",
  "2026-03-21",
  // Kurban Bayramı 2026
  "2026-05-26",
  "2026-05-27",
  "2026-05-28",
  "2026-05-29",
  // Ramazan Bayramı 2027
  "2027-03-09",
  "2027-03-10",
  "2027-03-11",
  // Kurban Bayramı 2027
  "2027-05-16",
  "2027-05-17",
  "2027-05-18",
  "2027-05-19",
]);

/**
 * The last year the movable list covers.
 *
 * Exported so a health check can warn before the calendar runs out rather than
 * after — a deadline computed past this point silently ignores four to seven
 * holidays a year.
 */
export const MOVABLE_HOLIDAYS_KNOWN_THROUGH = 2027;

/** Extra dates a deployment wants treated as non-working, as `YYYY-MM-DD`. */
let extraHolidays = new Set<string>();

export function setExtraHolidays(dates: string[]): void {
  extraHolidays = new Set(dates);
}

/** The Istanbul-local calendar date of an instant, as `YYYY-MM-DD`. */
export function istanbulDate(at: Date): string {
  return new Date(at.getTime() + ISTANBUL_OFFSET_MS).toISOString().slice(0, 10);
}

function istanbulWeekday(at: Date): number {
  return new Date(at.getTime() + ISTANBUL_OFFSET_MS).getUTCDay();
}

export function isBusinessDay(at: Date): boolean {
  const weekday = istanbulWeekday(at);
  if (weekday === 0 || weekday === 6) return false;

  const date = istanbulDate(at);
  if (MOVABLE_HOLIDAYS.has(date) || extraHolidays.has(date)) return false;

  return !FIXED_HOLIDAYS.has(date.slice(5));
}

/**
 * True when the movable-holiday list no longer covers this date.
 *
 * A deadline past the list is still returned — refusing to compute one would
 * block consent capture entirely — but it is knowingly optimistic, and the
 * caller logs it.
 */
export function beyondKnownHolidays(at: Date): boolean {
  return Number(istanbulDate(at).slice(0, 4)) > MOVABLE_HOLIDAYS_KNOWN_THROUGH;
}

/**
 * The instant `count` business days after `from`.
 *
 * Counting starts from the **next** day: consent collected at 09:00 on Monday
 * is due at the end of Thursday, not Wednesday. The result lands at the end of
 * that business day in Istanbul, because a legal deadline is a day rather than
 * a moment, and taking the same clock time would quietly shorten the window for
 * anyone who submits a form in the evening.
 */
export function addBusinessDays(from: Date, count: number): Date {
  let cursor = new Date(from.getTime());
  let remaining = count;

  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1_000);
    if (isBusinessDay(cursor)) remaining -= 1;
  }

  return endOfIstanbulDay(cursor);
}

/** 23:59:59.999 Istanbul time on the given day, as a UTC instant. */
export function endOfIstanbulDay(at: Date): Date {
  const date = istanbulDate(at);
  // 23:59:59.999 local is 20:59:59.999Z at UTC+3.
  return new Date(`${date}T23:59:59.999+03:00`);
}

/** İYS's window for uploading a self-collected consent. */
export const IYS_UPLOAD_BUSINESS_DAYS = 3;

export function iysUploadDeadline(collectedAt: Date): Date {
  return addBusinessDays(collectedAt, IYS_UPLOAD_BUSINESS_DAYS);
}
