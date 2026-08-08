import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/client.ts";
import type { ReviewStatus, Sentiment } from "../db/schema.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { addOpenHours, parseBusinessHours, type WeekSchedule } from "../locations/opening-hours.ts";
import { answeredAt, liveReplyJoin } from "./answered.ts";

/**
 * The derived half of inbox triage (P2-T1).
 *
 * Two numbers are written onto every review that nobody types by hand: how
 * urgently it wants attention (`priority`) and when a response is due
 * (`sla_due_at`). Both are defined exactly once, here, because the alternative
 * is a formula that lives in an ingest path, a SQL backfill and a sort clause
 * and means something slightly different in each.
 *
 * Deliberately free of business-hours arithmetic. `src/lib/business-days.ts`
 * exists for İYS, whose deadline is defined in *business* days by law; an SLA is
 * a promise a business makes to a customer who is waiting in wall-clock time,
 * and quietly pausing it over a weekend would make "we answer within 4 hours"
 * mean something the customer never agreed to.
 */

// ---------------------------------------------------------------------------
// SLA target
// ---------------------------------------------------------------------------

/**
 * The fallback response target, in hours.
 *
 * One working day. It has to be a real number rather than "no SLA" because an
 * inbox with no deadline has no overdue state, and the overdue filter is the
 * one an owner opens the screen for.
 */
export const DEFAULT_SLA_HOURS = 24;

const slaHoursSchema = z.number().int().min(1).max(8760);

/** The slice of `organizations.settings` this module owns. */
const orgInboxSettingsSchema = z
  .object({
    inbox: z.object({ slaHours: slaHoursSchema }).partial(),
  })
  .partial();

/**
 * Tolerant parse: `settings` is an untyped jsonb column, and a malformed blob
 * must cost the organization its custom target, not its inbox.
 */
export function readOrgSlaHours(settings: unknown): number | null {
  const parsed = orgInboxSettingsSchema.safeParse(settings ?? {});
  return parsed.success ? (parsed.data.inbox?.slaHours ?? null) : null;
}

/**
 * Location target → organization target → default. One order, one place.
 *
 * Most specific wins, which is the same rule `notification_preferences` uses for
 * a per-location override. A location that has never been configured inherits
 * rather than opting out.
 */
export function resolveSlaHours(locationHours: number | null, orgSettings: unknown): number {
  if (locationHours !== null && slaHoursSchema.safeParse(locationHours).success) {
    return locationHours;
  }
  return readOrgSlaHours(orgSettings) ?? DEFAULT_SLA_HOURS;
}

/**
 * When a response is due.
 *
 * Null when the item has no posted timestamp — a deadline measured from
 * "unknown" is not a deadline — and null when the target is unknown, rather than
 * defaulting to zero and marking the item breached the instant it arrives.
 */
export function slaDueAt(
  postedAt: Date | null | undefined,
  hours: number | undefined,
  /**
   * The branch's opening hours (W5-8). Absent means the clock runs constantly,
   * which is exactly what this function did before the calendar existed — so a
   * location that has never configured hours keeps every deadline it had.
   */
  schedule?: WeekSchedule | null,
): Date | null {
  if (!postedAt || hours === undefined) return null;

  if (schedule) {
    /*
      Four hours *we were open for*, not four hours on a wall clock.

      A one-star review at 19:00 on Friday against a four-hour target used to be
      overdue at 23:00 on Friday — while the branch was shut. `addOpenHours`
      makes it 13:00 on Monday, which is a deadline somebody can meet.

      Null back means the target cannot be burned inside a fortnight of opening,
      which describes a schedule/target pair that does not describe the
      business. Falling through to the plain clock is better than no deadline:
      the overdue filter is the reason the column exists.
    */
    const open = addOpenHours(postedAt, hours, schedule);
    if (open) return open;
  }

  return new Date(postedAt.getTime() + hours * 60 * 60 * 1000);
}

/**
 * The SLA target for each of the given locations, resolved once per batch.
 *
 * A per-review lookup would issue one query per row on an ingest of a hundred;
 * a hard-coded default would make the per-location column decorative.
 */
export type SlaTarget = {
  hours: number;
  /** Null when this branch has no opening hours — the round-the-clock case. */
  schedule: WeekSchedule | null;
};

export async function slaHoursByLocation(
  tx: TenantDatabase,
  organizationId: string,
  locationIds: string[],
): Promise<Map<string, SlaTarget>> {
  const unique = [...new Set(locationIds)];
  if (unique.length === 0) return new Map();

  const [org] = await tx
    .select({ settings: schema.organizations.settings })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  const rows = await tx
    .select({
      id: schema.locations.id,
      slaHours: schema.locations.slaHours,
      businessHours: schema.locations.businessHours,
    })
    .from(schema.locations)
    .where(
      and(
        eq(schema.locations.organizationId, organizationId),
        inArray(schema.locations.id, unique),
      ),
    );

  const resolved = new Map<string, SlaTarget>();
  for (const row of rows) {
    resolved.set(row.id, {
      hours: resolveSlaHours(row.slaHours, org?.settings),
      schedule: parseBusinessHours(row.businessHours),
    });
  }

  // A location the tenant cannot see is not silently given a deadline of its
  // own — it gets none, and the insert that referenced it will fail on the
  // foreign key, which is the honest failure.
  return resolved;
}

/**
 * How close a deadline has to be before it is worth saying so.
 *
 * A quarter of the window rather than a fixed number of hours, so it means the
 * same thing at a four-hour target and a two-day one: "you are running out of
 * time", not "there are three hours left", which is comfortable in one case and
 * an emergency in the other.
 */
const DUE_SOON_FRACTION = 0.25;

/**
 * Where a review stands against its deadline (P2-T4).
 *
 * Six states, because the honest answers really are six. `none` is not a
 * failure — an item with no posted time never had a deadline — and it is kept
 * separate from `ok` so the UI can say nothing at all rather than imply a
 * promise that was never made.
 *
 * `met` and `missed` are about a response that has *already happened*, and they
 * are terminal: once someone has answered, whether they were late is a fact
 * about the past and it stops changing as the clock runs on.
 */
export type SlaState = "none" | "met" | "missed" | "ok" | "due_soon" | "overdue";

export function slaState(
  review: {
    slaDueAt: Date | null;
    firstResponseAt: Date | null;
    /**
     * When the business answered on the platform itself (W1.2). Without it,
     * every review an owner had already answered in Google read as overdue
     * forever — the single largest source of the audit's fake overdue count.
     */
    ownerRepliedAt: Date | null;
    status: ReviewStatus;
    postedAt?: Date | null;
  },
  now: Date = new Date(),
): SlaState {
  if (!review.slaDueAt) return "none";

  // An answer is an answer whoever gave it. `answeredAt` prefers the response
  // *we* measured and falls back to the platform's timestamp, which is why this
  // can still say honestly whether the deadline was met.
  const answered = answeredAt(review);
  if (answered) {
    return answered <= review.slaDueAt ? "met" : "missed";
  }

  // Resolved without a reply — someone phoned the customer, or it was spam.
  // There is no response time to judge, and colouring it red for the rest of
  // time would be a permanent reproach for work that was actually done.
  if (review.status === "done" || review.status === "ignored") return "none";

  if (now > review.slaDueAt) return "overdue";

  const window = review.slaDueAt.getTime() - (review.postedAt?.getTime() ?? 0);
  const remaining = review.slaDueAt.getTime() - now.getTime();

  // Without a posted time the window is meaningless, so fall back to the
  // default target rather than comparing against an epoch-sized number.
  const reference = review.postedAt ? window : DEFAULT_SLA_HOURS * 3_600_000;

  return remaining <= reference * DUE_SOON_FRACTION ? "due_soon" : "ok";
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/**
 * What the score is made of, and what it is deliberately not.
 *
 * The build plan describes priority as "negative + unanswered + recency". The
 * first two are here; **recency is not**, and that is a decision rather than an
 * omission. A stored number that decays with age is wrong the hour after it is
 * written, and keeping it right would mean rewriting every open row on a timer —
 * a background job whose only output is churn. Age is already a column, so it
 * belongs in the ORDER BY: `priority desc, posted_at desc` ranks a fresh
 * one-star above a fortnight-old one without either value ever going stale.
 *
 * `status` is absent for a different reason: the inbox filters on it. Folding
 * "this is done" into the urgency score would mean a resolved item still sorts
 * near the top of any view that includes it, which is precisely the view — "show
 * me everything" — where you want the ranking to still mean something.
 */
export type PriorityInput = {
  /** 1–5, or null for a comment, mention or DM that has no rating to give. */
  rating: number | null;
  /** Null until the analysis pass has run. */
  sentiment: Sentiment | null;
  /** True when a live (non-failed) reply exists. */
  answered: boolean;
};

/** Severity implied by the star rating alone. */
const RATING_SEVERITY: Record<number, number> = { 1: 75, 2: 65, 3: 40, 4: 15, 5: 5 };

/** Severity implied by the analysis alone. */
const SENTIMENT_SEVERITY: Record<Sentiment, number> = { negative: 70, neutral: 35, positive: 10 };

/**
 * Neither a rating nor an analysis: an unanalyzed comment or DM. Mid-scale, so
 * it neither jumps the queue nor sinks below a five-star review nobody needs to
 * read.
 */
const UNKNOWN_SEVERITY = 30;

/** Waiting for an answer is the whole point of a triage queue. */
const UNANSWERED_BONUS = 25;

/**
 * Answered items sink but do not vanish: a one-star that was replied to is
 * still the most interesting thing in an "all items" view.
 */
const ANSWERED_PENALTY = 30;

/**
 * Triage severity, 0–100.
 *
 * Where a rating and an analysis disagree — a one-star the model read as
 * positive, which happens with sarcasm and with mis-clicked stars — the higher
 * of the two wins. Triage should err toward a human looking at it; the cost of
 * being wrong in that direction is thirty seconds, and in the other direction it
 * is a furious customer nobody answered.
 */
export function computePriority(input: PriorityInput): number {
  const fromRating = input.rating === null ? null : (RATING_SEVERITY[input.rating] ?? null);
  const fromSentiment = input.sentiment === null ? null : SENTIMENT_SEVERITY[input.sentiment];

  const severity =
    fromRating === null && fromSentiment === null
      ? UNKNOWN_SEVERITY
      : Math.max(fromRating ?? 0, fromSentiment ?? 0);

  const score = severity + (input.answered ? -ANSWERED_PENALTY : UNANSWERED_BONUS);

  return Math.min(100, Math.max(0, score));
}

/**
 * Recomputes `priority` for the given reviews from what the database currently
 * holds.
 *
 * Called wherever an input can change: after ingest, after analysis, and (P2-T4)
 * after a reply is written or withdrawn. Reading the state back rather than
 * threading it through each caller is what keeps the three paths from disagreeing
 * — the ingest path does not know the sentiment, the analysis path does not know
 * the reply state, and neither of them is wrong afterwards.
 *
 * Returns the number of rows actually changed.
 */
export async function refreshPriority(
  tx: TenantDatabase,
  organizationId: string,
  reviewIds: string[],
): Promise<number> {
  const unique = [...new Set(reviewIds)];
  if (unique.length === 0) return 0;

  const rows = await tx
    .select({
      id: schema.reviews.id,
      rating: schema.reviews.rating,
      priority: schema.reviews.priority,
      sentiment: schema.reviewInsights.sentiment,
      replyId: schema.replies.id,
      ownerRepliedAt: schema.reviews.ownerRepliedAt,
    })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    // The same join every "is it answered" question uses: a rejected attempt
    // leaves the review unanswered, so it must not sink in the queue.
    .leftJoin(schema.replies, liveReplyJoin)
    .where(
      and(eq(schema.reviews.organizationId, organizationId), inArray(schema.reviews.id, unique)),
    );

  const changed = rows
    .map((row) => ({
      id: row.id,
      priority: computePriority({
        rating: row.rating,
        sentiment: row.sentiment,
        // A reply the owner left on Google answers the customer just as well as
        // one we posted, so it must sink the review the same way (W1.2).
        answered: row.replyId !== null || row.ownerRepliedAt !== null,
      }),
      previous: row.priority,
    }))
    .filter((row) => row.priority !== row.previous);

  if (changed.length === 0) return 0;

  // One statement rather than one per review. `updated_at` is left alone on
  // purpose: it means "the review changed", and a re-scored derived column is
  // not a change to what the customer wrote.
  const values = sql.join(
    changed.map((row) => sql`(${row.id}::uuid, ${row.priority}::int)`),
    sql`, `,
  );

  await tx.execute(sql`
    update ${schema.reviews} as r
    set priority = v.priority
    from (values ${values}) as v(id, priority)
    where r.id = v.id and r.organization_id = ${organizationId}::uuid
  `);

  return changed.length;
}

/**
 * Recomputes the response deadline for a branch's open reviews (W5-8).
 *
 * Needed because `refreshPriority` deliberately does not touch `sla_due_at` —
 * priority is derived from the review, and the deadline is derived from a
 * *setting*. When somebody sets their opening hours, every deadline in the
 * queue was computed against a clock that no longer applies, and an overdue
 * filter that keeps showing Saturday breaches is the exact complaint W5-8 is
 * about.
 *
 * Scoped to one location and to reviews that are still open: a closed review's
 * deadline is history, and rewriting it would change what the SLA report says
 * happened.
 */
export async function refreshSlaDueAt(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
): Promise<number> {
  const targets = await slaHoursByLocation(tx, organizationId, [locationId]);
  const target = targets.get(locationId);
  if (!target) return 0;

  const rows = await tx
    .select({ id: schema.reviews.id, postedAt: schema.reviews.postedAt })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.locationId, locationId),
        sql`${schema.reviews.status} <> 'done'`,
      ),
    );

  let updated = 0;
  for (const row of rows) {
    const due = slaDueAt(row.postedAt, target.hours, target.schedule);
    if (!due) continue;

    await tx.update(schema.reviews).set({ slaDueAt: due }).where(eq(schema.reviews.id, row.id));
    updated += 1;
  }

  return updated;
}
