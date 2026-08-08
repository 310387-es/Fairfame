import { z } from "zod";

/**
 * When a branch is open, and what that does to a response deadline (W5-8).
 *
 * > **Business hours + SLA calendar** (SLA counts weekends today).
 *
 * The complaint is exact. `slaDueAt` was `postedAt + hours`, so a one-star
 * review arriving at 19:00 on Friday with a four-hour target was **overdue at
 * 23:00 on Friday** — a business closed for the weekend woke on Monday to a
 * queue of breaches it could not have prevented, and the overdue filter, which
 * is the one an owner opens the screen for, filled with noise.
 *
 * What this module does is turn "four hours" into "four hours **we were open
 * for**". A branch open 09:00–18:00 that gets that review at 19:00 on Friday is
 * due at 13:00 on Monday, which is a deadline somebody can actually meet.
 *
 * ## Three decisions worth stating
 *
 *   - **No hours means no change.** A location that has never set any keeps the
 *     old round-the-clock clock exactly. This is a feature businesses opt into,
 *     not a silent reinterpretation of every deadline already on screen.
 *   - **The schedule is the truth; national holidays are not applied.**
 *     `src/compliance/business-days.ts` knows Turkish public holidays and is
 *     right to, because an İYS deadline is a *legal* one. A café is open on 29
 *     October. Applying that calendar here would tell a business it had two
 *     extra days to answer a complaint on the busiest day of its year.
 *   - **Europe/Istanbul**, like `business-days.ts`, and for the same reason:
 *     the launch market is Türkiye, which has been on permanent UTC+3 since
 *     2016. `CLAUDE.md` records that no per-organization timezone exists yet
 *     and that adding one is a change to `src/reports/period.ts` as well. When
 *     it lands, `ZONE_OFFSET_MS` here is one of the two places it replaces.
 */

/** Türkiye has been on permanent UTC+3 since 2016 — see the module comment. */
const ZONE_OFFSET_MS = 3 * 60 * 60 * 1_000;

const MINUTE_MS = 60 * 1_000;
const DAY_MINUTES = 24 * 60;

/**
 * One day's opening, as minutes from local midnight.
 *
 * Minutes rather than `"09:00"` strings once parsed, because every operation
 * here is arithmetic and a module that keeps re-parsing its own storage format
 * is a module with two representations to get wrong.
 *
 * `close` may exceed `DAY_MINUTES` — a bar open until 02:00 stores 1560. That
 * is the whole reason this is not a pair of clock times.
 */
export type DayWindow = { open: number; close: number };

/**
 * A week, indexed the way `Date.getUTCDay()` indexes it: 0 is Sunday.
 *
 * Deliberately *not* Monday-first, unlike `weekWindow`. This array is only ever
 * looked up by a value that came out of `getUTCDay`, and a second convention
 * one file away from the lookup is how an off-by-one hides for a year.
 */
export type WeekSchedule = (DayWindow | null)[];

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const daySchema = z
  .object({ open: z.string().regex(TIME), close: z.string().regex(TIME) })
  .nullable();

/** What is stored: seven `{ open, close }` pairs or nulls, Sunday first. */
export const businessHoursSchema = z.array(daySchema).length(7);

export type StoredBusinessHours = z.infer<typeof businessHoursSchema>;

function minutesOf(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/**
 * Reads the stored blob into something arithmetic can use.
 *
 * **Tolerant, and null on anything unrecognised.** `business_hours` is jsonb,
 * so a malformed value must cost the branch its calendar rather than its
 * inbox — the same rule `readOrgSlaHours` follows for the SLA target and
 * `parseBranding` follows for a colour. Null here means "no hours configured",
 * which is exactly the unchanged behaviour.
 */
export function parseBusinessHours(value: unknown): WeekSchedule | null {
  const parsed = businessHoursSchema.safeParse(value ?? null);
  if (!parsed.success) return null;

  const week = parsed.data.map((day) => {
    if (!day) return null;
    const open = minutesOf(day.open);
    // Midnight close means the end of the day, not the start of it. Stored as
    // "00:00" because that is what a time input produces, and a branch closing
    // at 00:00 with `close === 0` would have a negative-length day.
    const rawClose = minutesOf(day.close);
    const close = rawClose <= open ? rawClose + DAY_MINUTES : rawClose;
    return { open, close };
  });

  // Seven closed days is not a schedule, it is a mistake — and treating it as
  // one would mean a deadline that never arrives. Null falls back to the clock.
  return week.some((day) => day !== null) ? week : null;
}

/** Local minutes-since-midnight and weekday for an instant. */
function localParts(at: Date): { day: number; minutes: number; midnightUtc: number } {
  const local = new Date(at.getTime() + ZONE_OFFSET_MS);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const midnightUtc =
    at.getTime() - minutes * MINUTE_MS - local.getUTCSeconds() * 1_000 - local.getUTCMilliseconds();

  return { day: local.getUTCDay(), minutes, midnightUtc };
}

/**
 * How much open time a branch has between two instants.
 *
 * Used to age a review against its target — "how much of our four hours have we
 * actually burned" — rather than only to compute a due date.
 */
export function openMinutesBetween(from: Date, to: Date, schedule: WeekSchedule): number {
  if (to.getTime() <= from.getTime()) return 0;

  let total = 0;
  const { day: startDay, midnightUtc } = localParts(from);
  const span = to.getTime() - from.getTime();
  // One extra day so a window that runs past midnight is not cut off.
  const days = Math.ceil(span / (DAY_MINUTES * MINUTE_MS)) + 2;

  for (let offset = 0; offset < days; offset += 1) {
    const window = schedule[(startDay + offset) % 7];
    if (!window) continue;

    const dayStart = midnightUtc + offset * DAY_MINUTES * MINUTE_MS;
    const openAt = dayStart + window.open * MINUTE_MS;
    const closeAt = dayStart + window.close * MINUTE_MS;

    const overlapStart = Math.max(openAt, from.getTime());
    const overlapEnd = Math.min(closeAt, to.getTime());
    if (overlapEnd > overlapStart) total += (overlapEnd - overlapStart) / MINUTE_MS;
  }

  return total;
}

/**
 * How far ahead this branch's deadline actually falls.
 *
 * Returns null when the schedule cannot produce an answer inside a fortnight,
 * which in practice means a branch open only an hour a week with a long target.
 * The caller falls back to the plain clock rather than inventing a date.
 */
export function addOpenHours(from: Date, hours: number, schedule: WeekSchedule): Date | null {
  let remaining = hours * 60;
  if (remaining <= 0) return from;

  const { day: startDay, midnightUtc } = localParts(from);

  // Fourteen days, then give up. A branch that cannot burn its target in a
  // fortnight of opening has a target that does not describe it.
  for (let offset = 0; offset < 14; offset += 1) {
    const window = schedule[(startDay + offset) % 7];
    if (!window) continue;

    const dayStart = midnightUtc + offset * DAY_MINUTES * MINUTE_MS;
    const openAt = Math.max(dayStart + window.open * MINUTE_MS, from.getTime());
    const closeAt = dayStart + window.close * MINUTE_MS;
    if (closeAt <= openAt) continue;

    const available = (closeAt - openAt) / MINUTE_MS;
    if (available >= remaining) return new Date(openAt + remaining * MINUTE_MS);
    remaining -= available;
  }

  return null;
}

/** Whether the branch is open at this instant. For "we are closed" copy. */
export function isOpenAt(at: Date, schedule: WeekSchedule): boolean {
  const { day, minutes } = localParts(at);
  const today = schedule[day];
  if (today && minutes >= today.open && minutes < today.close) return true;

  // Yesterday's window may still be running — a bar open until 02:00.
  const yesterday = schedule[(day + 6) % 7];
  return yesterday !== null && yesterday !== undefined
    ? minutes + DAY_MINUTES >= yesterday.open && minutes + DAY_MINUTES < yesterday.close
    : false;
}
