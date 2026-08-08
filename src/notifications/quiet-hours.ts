/**
 * Quiet hours (W5-15, item 15 on the Wave 5 backlog).
 *
 * The product's own audit note for it is one line: *notification quiet hours*.
 * What it means in practice is that an owner who has switched on instant email
 * gets a phone that buzzes at 03:40 because somebody in another timezone left a
 * review — and the response is to turn instant email off entirely, which loses
 * the feature rather than the interruption.
 *
 * ## Three decisions
 *
 *   - **It holds the email, never the in-app row.** Quiet hours are about a
 *     phone at night, not about hiding what happened. The feed entry is written
 *     immediately, so somebody who wakes up and opens the app sees everything;
 *     what waited is the notification that would have woken them.
 *   - **Urgent does not pierce it, deliberately.** A one-star review at 03:40 is
 *     not more actionable at 03:40, and a quiet window with an exception is a
 *     quiet window nobody trusts enough to rely on. The rule people will
 *     actually use is the one with no asterisk.
 *   - **A window may wrap midnight**, because the useful one does: 22:00–08:00
 *     is what somebody means by "at night" and `from < to` would refuse it.
 *
 * Db-free, so the settings form and the sender share one definition. Minutes
 * since local midnight rather than clock strings, for the reason
 * `opening-hours.ts` gives: every operation here is arithmetic.
 *
 * Europe/Istanbul, like `business-days.ts` and `opening-hours.ts`. `CLAUDE.md`
 * records that no per-user timezone exists yet; when one lands this is the
 * third place it replaces.
 */

/** Türkiye has been on permanent UTC+3 since 2016. */
const ZONE_OFFSET_MS = 3 * 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;
const DAY_MINUTES = 24 * 60;

export type QuietWindow = {
  /** Minutes since local midnight. */
  from: number;
  to: number;
};

/** Reads the stored pair. Either half missing means no quiet hours. */
export function quietWindowOf(
  from: number | null | undefined,
  to: number | null | undefined,
): QuietWindow | null {
  if (typeof from !== "number" || typeof to !== "number") return null;
  if (from < 0 || from >= DAY_MINUTES || to < 0 || to >= DAY_MINUTES) return null;
  // Equal bounds is a zero-length window, not a 24-hour one. Reading it as
  // "silence everything for ever" is the failure mode that loses a customer's
  // alerts without anybody choosing that.
  if (from === to) return null;
  return { from, to };
}

function localMinutes(at: Date): number {
  const local = new Date(at.getTime() + ZONE_OFFSET_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** Whether this instant falls inside the window. Wraps midnight. */
export function isQuietAt(at: Date, window: QuietWindow): boolean {
  const minutes = localMinutes(at);
  return window.from < window.to
    ? minutes >= window.from && minutes < window.to
    : minutes >= window.from || minutes < window.to;
}

/**
 * When an email created now may actually go out.
 *
 * Null means "now" — either there is no quiet window or this moment is outside
 * it. Otherwise the next end of the window, which is today's `to` if it is
 * still ahead and tomorrow's if the window wrapped past midnight.
 *
 * Returning null rather than `new Date()` is deliberate: the column it feeds is
 * nullable and null means "no delay was ever asked for", which is a different
 * fact from "the delay expired a millisecond ago" and reads that way in a query.
 */
export function sendAfter(at: Date, window: QuietWindow | null): Date | null {
  if (!window || !isQuietAt(at, window)) return null;

  const minutes = localMinutes(at);
  const untilEnd = minutes < window.to ? window.to - minutes : DAY_MINUTES - minutes + window.to;

  // Truncated to the minute so two notifications inside the same quiet window
  // are released together rather than seconds apart.
  const seconds = new Date(at.getTime() + ZONE_OFFSET_MS).getUTCSeconds();
  return new Date(at.getTime() + untilEnd * MINUTE_MS - seconds * 1_000);
}

/** `HH:MM` ↔ minutes, for the form. */
export function clockToMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesToClock(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
