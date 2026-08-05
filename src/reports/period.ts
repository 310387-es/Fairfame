/**
 * Which period a scheduled report covers (P3-T5).
 *
 * Pure, and the module the whole feature's idempotency rests on. The sweep does
 * not ask "has enough time passed since the last send" — it asks "which
 * complete period are we in the aftermath of", and the ledger is keyed by that
 * answer. So a sweep that runs every hour, or misses a day and catches up, or
 * runs twice in the same minute, all produce the same one report.
 *
 * **Always the last *complete* period.** A weekly report sent on Monday covers
 * the week that just ended, not the one that has barely started. The tempting
 * alternative — "the last seven days from now" — makes two people's Monday
 * reports cover different windows depending on when the sweep happened to fire,
 * and makes the same report un-reproducible a day later.
 *
 * UTC throughout, matching `digest/metrics.ts` and `dashboard/range.ts`. Not
 * because UTC is where anyone lives, but because a chain's branches must share
 * one definition of "last week" or their numbers cannot be compared — and
 * because a period boundary that moves with daylight saving is a boundary that
 * silently sends twice or not at all one weekend a year.
 */

export type Cadence = "weekly" | "monthly";

export type ReportPeriod = {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
  /** The equal-length period before it — what every delta compares against. */
  previous: { start: Date; end: Date };
};

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Midnight UTC on the Monday of the week containing `at`. */
function startOfWeek(at: Date): Date {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  // `getUTCDay()` is 0 for Sunday; ISO weeks start on Monday, which the digest
  // and the Turkish working week both assume.
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  return new Date(day - weekday * DAY_MS);
}

/** Midnight UTC on the first of the month containing `at`. */
function startOfMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

function addMonths(at: Date, months: number): Date {
  // `Date.UTC` normalises overflow, so month 12 becomes January of the next
  // year and there is no special case for December.
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + months, 1));
}

/**
 * The most recent complete period as of `now`.
 *
 * Month arithmetic is done in calendar months rather than in days: a "monthly"
 * report that covered 30 days would drift a day earlier every February and
 * eventually cover most of two months.
 */
export function completedPeriod(cadence: Cadence, now: Date): ReportPeriod {
  if (cadence === "weekly") {
    const thisWeek = startOfWeek(now);
    const start = new Date(thisWeek.getTime() - 7 * DAY_MS);

    return {
      start,
      end: thisWeek,
      previous: { start: new Date(start.getTime() - 7 * DAY_MS), end: start },
    };
  }

  const thisMonth = startOfMonth(now);
  const start = addMonths(thisMonth, -1);

  return {
    start,
    end: thisMonth,
    previous: { start: addMonths(thisMonth, -2), end: start },
  };
}

/**
 * When the report for a given period becomes sendable.
 *
 * The moment the period ends, which is also the moment the ledger key exists.
 * Separated from `completedPeriod` because the two answer different questions —
 * "what would I send now" and "was this due" — and a caller that conflated them
 * would re-send whenever the clock was ambiguous.
 */
export function isPeriodDue(period: ReportPeriod, now: Date): boolean {
  return now.getTime() >= period.end.getTime();
}
