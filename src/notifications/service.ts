import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { can } from "../lib/entitlements.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { recipientsForLocation, shouldNotify } from "./preferences.ts";
import { sendAfter } from "./quiet-hours.ts";

/**
 * Turning a new review into notifications (P1a-T5).
 *
 * The rule from PRD N1: a new review notifies, and a **negative** one — ≤3
 * stars *or* negative sentiment — is flagged urgent. Two signals rather than
 * one, because they arrive at different times and neither is sufficient alone.
 * A 1-star with no text has no sentiment; a 5-star that reads "great, if you
 * enjoy waiting an hour" has no bad rating.
 *
 * Notifications are therefore created from whatever is known *now* and
 * **upgraded later** if analysis disagrees. Waiting for analysis before
 * notifying would put an LLM on the critical path of an alert, which means a
 * capped plan or a provider outage silently turns notifications off.
 */

const log = childLogger({ module: "notifications/service" });

/** Stars at or below this count as negative regardless of what the model says. */
export const NEGATIVE_RATING_THRESHOLD = 3;

/**
 * The connection a review came from, joined by what identifies it (W1.3).
 *
 * `reviews` carries no `connection_id` — a review belongs to a location and a
 * source, and `unique(location_id, provider)` means that pair names at most one
 * connection, so the join cannot fan out and multiply a review.
 *
 * A LEFT join because plenty of reviews have no connection at all: a first-party
 * form submission, a seeded row, a test fixture. Those are handled explicitly in
 * `IS_NEWS` rather than silently dropped.
 */
export const reviewConnectionJoin = and(
  eq(schema.connections.organizationId, schema.reviews.organizationId),
  eq(schema.connections.locationId, schema.reviews.locationId),
  eq(schema.connections.provider, schema.reviews.source),
);

/**
 * Is this review something that *happened*, as opposed to history we have only
 * just been shown? (W1.3)
 *
 * **The bug.** Connecting Google to a fresh account produced 217 unread
 * notifications — every review the business had ever received, delivered as if
 * all of it had just occurred. The only bound was
 * `reviews.created_at > now() - interval '7 days'`, and `created_at` is when
 * *we* wrote the row: on a first sync every review in a decade of history is
 * seven minutes old. A bell that cries wolf 217 times on day one is a bell the
 * owner switches off, and then the one alert that mattered goes unread too.
 *
 * Two rules, and a review has to pass both:
 *
 *   1. **It did not arrive in the backfill.** Everything a connection's first
 *      sync pulls in is history by definition. `first_synced_at` is stamped once
 *      and never moved precisely so this stays askable — `last_synced_at` has
 *      moved on by the time the sweep runs.
 *   2. **It was posted after the business started watching.** A review written
 *      before the connection existed was never ours to be notified about.
 *
 * Rule 2 catches the audit's case on its own. Rule 1 is for the gap this product
 * opens deliberately: a Google connection is created `pending` and only syncs
 * once somebody maps it to a business location, which can be days later — so
 * reviews written in between are newer than the connection and would still land
 * in one heap.
 *
 * **A review with no connection is news.** That is a first-party form
 * submission, where somebody has this moment filled in a card at the counter.
 * Defaulting the other way would silence the one source whose arrivals are
 * unambiguously live.
 */
export const IS_NEWS: SQL = sql`(
  ${schema.connections.id} is null
  or (
    (${schema.connections.firstSyncedAt} is null
       or ${schema.reviews.createdAt} > ${schema.connections.firstSyncedAt})
    and coalesce(${schema.reviews.postedAt}, ${schema.reviews.createdAt})
          > ${schema.connections.createdAt}
  )
)`;

/** How much review text the feed entry carries. */
const EXCERPT_CHARS = 180;

export type ReviewFacts = {
  reviewId: string;
  locationId: string;
  rating: number | null;
  sentiment: "positive" | "neutral" | "negative" | null;
};

/**
 * Is this review one an owner needs to see today?
 *
 * Pure, and deliberately generous: a review is negative if *either* signal says
 * so. Requiring both would mean a 1-star review the model read as neutral
 * arrives as routine news.
 */
export function isNegative(facts: Pick<ReviewFacts, "rating" | "sentiment">): boolean {
  if (facts.sentiment === "negative") return true;
  return facts.rating !== null && facts.rating <= NEGATIVE_RATING_THRESHOLD;
}

/**
 * One notification per user per review *per kind*; the key makes a re-run a
 * no-op.
 *
 * The type is part of the key, which is what lets a breach alert reach someone
 * who already read and dismissed the arrival of the same review. Two facts, two
 * alerts.
 */
export function dedupeKeyFor(type: "new_review" | "sla_breach", reviewId: string): string {
  return `${type}:${reviewId}`;
}

export type ReviewNotificationPayload = {
  reviewId: string;
  locationName: string;
  source: string;
  rating: number | null;
  authorName: string | null;
  excerpt: string | null;
  language: string | null;
};

export type NotifyResult = {
  created: number;
  upgraded: number;
  /** Reviews considered, whether or not anyone wanted to hear about them. */
  reviews: number;
};

type PendingReview = {
  id: string;
  locationId: string;
  locationName: string;
  source: string;
  rating: number | null;
  authorName: string | null;
  text: string | null;
  language: string | null;
  sentiment: "positive" | "neutral" | "negative" | null;
};

/**
 * Reviews nobody has been notified about yet.
 *
 * "Nobody" rather than "this user": a review that produced no notifications
 * because every member had them switched off must not be reconsidered on every
 * sweep forever. The `notified_at` marker that would fix that properly belongs
 * on `reviews`; until then the left join on notifications is the honest
 * approximation, and the cost is that turning notifications *on* does not
 * retroactively alert about old reviews — which is the behaviour most people
 * would expect anyway.
 */
async function pendingReviews(
  tx: TenantDatabase,
  organizationId: string,
  limit: number,
): Promise<PendingReview[]> {
  return tx
    .selectDistinctOn([schema.reviews.id], {
      id: schema.reviews.id,
      locationId: schema.reviews.locationId,
      locationName: schema.locations.name,
      source: schema.reviews.source,
      rating: schema.reviews.rating,
      authorName: schema.reviews.authorName,
      text: schema.reviews.text,
      language: schema.reviews.language,
      sentiment: schema.reviewInsights.sentiment,
    })
    .from(schema.reviews)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.reviews.locationId))
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .leftJoin(schema.notifications, eq(schema.notifications.reviewId, schema.reviews.id))
    .leftJoin(schema.connections, reviewConnectionJoin)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        isNull(schema.notifications.id),
        // Reviews that predate the organization's interest are not news. The
        // window is generous; the sweep is a safety net, not an archive tour.
        sql`${schema.reviews.createdAt} > now() - interval '7 days'`,
        // …and this is the rule that actually holds, because the window above
        // measures when *we* wrote the row and a backfill writes all of it now.
        IS_NEWS,
      ),
    )
    .orderBy(schema.reviews.id, desc(schema.reviews.createdAt))
    .limit(limit);
}

/** Exported for the assignment alert, which carries the same review payload. */
export function excerpt(text: string | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  return trimmed.length <= EXCERPT_CHARS ? trimmed : `${trimmed.slice(0, EXCERPT_CHARS - 1)}…`;
}

/**
 * Creates notifications for an organization's un-notified reviews.
 *
 * Returns counts rather than rows: the caller is a job, and the interesting
 * question is whether anything happened.
 */
export async function notifyPendingReviews(options: {
  organizationId: string;
  limit?: number;
  now?: Date;
}): Promise<NotifyResult> {
  const { organizationId, limit = 200, now = new Date() } = options;
  const result: NotifyResult = { created: 0, upgraded: 0, reviews: 0 };

  await withTenant({ organizationId }, async (tx) => {
    const reviews = await pendingReviews(tx, organizationId, limit);
    result.reviews = reviews.length;
    if (reviews.length === 0) return;

    // Recipients depend only on the location, and a sync usually delivers many
    // reviews for one location, so resolve each location once.
    const recipientsByLocation = new Map<
      string,
      Awaited<ReturnType<typeof recipientsForLocation>>
    >();

    for (const review of reviews) {
      let recipients = recipientsByLocation.get(review.locationId);
      if (!recipients) {
        recipients = await recipientsForLocation(tx, organizationId, review.locationId);
        recipientsByLocation.set(review.locationId, recipients);
      }

      const negative = isNegative(review);
      const payload: ReviewNotificationPayload = {
        reviewId: review.id,
        locationName: review.locationName,
        source: review.source,
        rating: review.rating,
        authorName: review.authorName,
        excerpt: excerpt(review.text),
        language: review.language,
      };

      const rows = recipients.flatMap((recipient) => {
        const decision = shouldNotify(recipient.preference, { negative });
        if (!decision.inApp && !decision.email && !decision.deferEmail) return [];

        return [
          {
            organizationId,
            userId: recipient.userId,
            locationId: review.locationId,
            reviewId: review.id,
            type: "new_review" as const,
            urgency: negative ? ("urgent" as const) : ("normal" as const),
            payload,
            dedupeKey: dedupeKeyFor("new_review", review.id),
            // `pending` is a promise to try; the sender in ./email.ts turns it
            // into sent or failed. Anything else is a final state now.
            emailStatus: decision.email
              ? ("pending" as const)
              : decision.deferEmail
                ? ("deferred" as const)
                : ("skipped" as const),
            /*
              Quiet hours hold the email and never the feed row (W5-15).

              Computed here, at write time, rather than asked at send time: a
              person changing their quiet hours should not retroactively
              silence or release alerts that were already decided. And
              deliberately with no exception for `urgent` — a one-star review
              at 03:40 is not more actionable at 03:40, and a quiet window with
              an asterisk is one nobody trusts enough to switch on.
            */
            sendAfter: sendAfter(now, recipient.preference.quiet),
            createdAt: now,
          },
        ];
      });

      if (rows.length === 0) continue;

      const inserted = await tx
        .insert(schema.notifications)
        .values(rows)
        // A retried job must not produce a second alert for the same review.
        .onConflictDoNothing({
          target: [schema.notifications.userId, schema.notifications.dedupeKey],
        })
        .returning({ id: schema.notifications.id });

      result.created += inserted.length;
    }
  });

  if (result.created > 0) {
    log.info(
      { organizationId, created: result.created, reviews: result.reviews },
      "Notifications created",
    );
  }

  return result;
}

/**
 * Raises urgency on notifications whose review was later found negative.
 *
 * The other half of "notify now, correct later". Only *unread* notifications
 * are touched: re-flagging something the user already read would put it back at
 * the top of their feed for a fact they have already acted on.
 */
export async function upgradeUrgencyFromInsights(options: {
  organizationId: string;
  reviewIds?: string[];
}): Promise<number> {
  const { organizationId, reviewIds } = options;

  return withTenant({ organizationId }, async (tx) => {
    const negative = tx
      .select({ reviewId: schema.reviewInsights.reviewId })
      .from(schema.reviewInsights)
      .where(
        and(
          eq(schema.reviewInsights.organizationId, organizationId),
          eq(schema.reviewInsights.sentiment, "negative"),
        ),
      );

    const rows = await tx
      .update(schema.notifications)
      .set({ urgency: "urgent", updatedAt: new Date() })
      .where(
        and(
          eq(schema.notifications.organizationId, organizationId),
          eq(schema.notifications.urgency, "normal"),
          isNull(schema.notifications.readAt),
          reviewIds?.length
            ? sql`${schema.notifications.reviewId} = any(${sql.param(reviewIds)}::uuid[])`
            : undefined,
          sql`${schema.notifications.reviewId} in ${negative}`,
        ),
      )
      .returning({ id: schema.notifications.id });

    if (rows.length > 0) {
      log.info({ organizationId, upgraded: rows.length }, "Notifications escalated to urgent");
    }

    return rows.length;
  });
}

/**
 * Above this many lapsed deadlines at one location, the team gets one alert
 * saying how many rather than one alert each.
 *
 * The number is chosen for the *feed*, not for the database. Five urgent items
 * is a list somebody reads; fifty is a wall they scroll past, and the fiftieth
 * is no more likely to be acted on than the first. The rollup is not a summary
 * of the alerts — it replaces them, and it is the honest thing to send when the
 * real message is "you are behind", not "look at this review".
 *
 * This is also what the *first* sweep against an existing installation hits:
 * every deadline that has ever lapsed becomes news at once. One line about a
 * backlog is the right first thing to say about a backlog.
 */
export const SLA_ROLLUP_THRESHOLD = 5;

type NotificationInsert = typeof schema.notifications.$inferInsert;

/** What a rollup alert carries instead of a review. */
export type SlaRollupPayload = {
  count: number;
  locationName: string;
};

/**
 * How much of a backlog the very first sweep may report.
 *
 * Generous, because it happens once per organization and produces a single
 * rollup however many rows it covers. Still bounded: an import of a hundred
 * thousand reviews should not become one transaction that rewrites all of them.
 * Anything past this stays unstamped and is picked up by the next sweep, which
 * is also still a "first" sweep until something has actually been reported.
 */
const FIRST_SWEEP_LIMIT = 5_000;

/**
 * Has this organization ever been told about a lapsed deadline?
 *
 * The stamp is the record, so its absence is the whole answer. This is what
 * distinguishes "the backlog you inherited on day one" from "the deadline that
 * lapsed last Tuesday while the product was already running".
 */
async function hasReportedBefore(tx: TenantDatabase, organizationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.reviews.id })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        sql`${schema.reviews.slaAlertedAt} is not null`,
      ),
    )
    .limit(1);

  return row !== undefined;
}

/**
 * Claims the lapsed, unanswered deadlines nobody has been told about yet.
 *
 * An `UPDATE ... RETURNING` over a `SELECT ... FOR UPDATE SKIP LOCKED`, not a
 * read followed by a write. Two things fall out of that:
 *
 *   - **Reporting is recorded on the review**, so a rollup covering twenty of
 *     them leaves nothing that looks unreported. The old shape — "is there a
 *     notification row naming this review?" — cannot express that, which is
 *     what made a rollup impossible before.
 *   - **Two workers sweeping at once cannot both claim the same row.** Without
 *     the lock, each would read the same backlog and each would announce it.
 *
 * The conditions are the same four as before: the deadline has actually passed,
 * nobody answered, the item is still open or in progress, and the lapse is
 * recent enough to be news.
 */
async function claimBreaches(
  tx: TenantDatabase,
  organizationId: string,
  now: Date,
  limit: number,
  /**
   * The seven-day window is skipped on an organization's **first** sweep.
   *
   * The window exists so a routine sweep does not keep dredging up ancient
   * history. On the first one there is no history to dredge — there is a
   * backlog, and the first thing a team hears about their backlog should be
   * true. It costs one extra rollup and says "124 overdue" instead of "52".
   */
  windowed: boolean,
) {
  const claimed = await tx.execute<{
    id: string;
    location_id: string;
    location_name: string;
    source: string;
    rating: number | null;
    author_name: string | null;
    text: string | null;
    language: string | null;
  }>(sql`
    update ${schema.reviews} as r
    set sla_alerted_at = ${now}
    from (
      select inner_r.id
      from ${schema.reviews} as inner_r
      where inner_r.organization_id = ${organizationId}::uuid
        and inner_r.sla_alerted_at is null
        and inner_r.first_response_at is null
        -- And nobody answered it on the platform either (W1.2). Without this
        -- the sweep emails a manager about reviews their own owner replied to
        -- in Google — the worst form of the fake-overdue bug, because it leaves
        -- the product to argue with somebody who knows they answered.
        and inner_r.owner_replied_at is null
        and inner_r.sla_due_at is not null
        and inner_r.sla_due_at < ${now}
        and inner_r.status in ('open', 'in_progress')
        and ${windowed ? sql`inner_r.sla_due_at > ${now}::timestamptz - interval '7 days'` : sql`true`}
      order by inner_r.sla_due_at asc
      limit ${limit}
      for update skip locked
    ) as due, ${schema.locations} as l
    -- Both joins live in WHERE: an UPDATE ... FROM may not reference its own
    -- target table from inside a join condition in the FROM clause.
    where r.id = due.id and l.id = r.location_id
    returning
      r.id,
      r.location_id,
      l.name as location_name,
      r.source,
      r.rating,
      r.author_name,
      r.text,
      r.language
  `);

  return claimed.rows;
}

/**
 * Alerts the team about reviews that have gone past their deadline unanswered.
 *
 * Per item while the number is small enough to act on, and **one rollup per
 * location** once it is not. Always urgent, and deliberately not subject to the
 * "negative only" preference: that setting is about which *customers* are worth
 * interrupting for, while this is about a promise the team itself made. Someone
 * who turned notifications off entirely is still respected — that is a decision
 * about being interrupted at all.
 */
export async function notifySlaBreaches(options: {
  organizationId: string;
  limit?: number;
  now?: Date;
}): Promise<NotifyResult> {
  const { organizationId, limit = 200, now = new Date() } = options;
  const result: NotifyResult = { created: 0, upgraded: 0, reviews: 0 };

  await withTenant({ organizationId }, async (tx) => {
    // Deadlines are still *stamped* on ingest for every plan — see the note in
    // `slaHoursByLocation`. What a plan buys is being told about them, so the
    // gate is here and not at the point the data is written: an organization
    // that upgrades finds its real history waiting rather than starting at zero.
    if (!(await can({ organizationId, tx }, "sla_tracking"))) return;

    const reported = await hasReportedBefore(tx, organizationId);
    const claimed = await claimBreaches(
      tx,
      organizationId,
      now,
      reported ? limit : FIRST_SWEEP_LIMIT,
      reported,
    );
    result.reviews = claimed.length;
    if (claimed.length === 0) return;

    // Grouped by location, because that is both who the recipients are and what
    // a rollup can honestly name: "23 overdue at Kadıköy" is actionable in a way
    // that "23 overdue somewhere" is not.
    const byLocation = new Map<string, typeof claimed>();
    for (const review of claimed) {
      byLocation.set(review.location_id, [...(byLocation.get(review.location_id) ?? []), review]);
    }

    for (const [locationId, reviews] of byLocation) {
      const recipients = await recipientsForLocation(tx, organizationId, locationId);
      const rolledUp = reviews.length > SLA_ROLLUP_THRESHOLD;

      // The callback is annotated, not just the result: `flatMap` infers its
      // element type from the first `return` it sees, and the two branches below
      // build genuinely different rows — a rollup names no review.
      const rows = recipients.flatMap((recipient): NotificationInsert[] => {
        const decision = shouldNotify(recipient.preference, { negative: true });
        if (!decision.inApp && !decision.email && !decision.deferEmail) return [];

        const emailStatus = decision.email
          ? ("pending" as const)
          : decision.deferEmail
            ? ("deferred" as const)
            : ("skipped" as const);

        // Same rule as an arrival alert, including for a breach: see the note
        // on the other insert. A rule with an exception is one nobody switches
        // on, and 03:40 does not make an overdue review more answerable.
        const holdUntil = sendAfter(now, recipient.preference.quiet);

        if (rolledUp) {
          const payload: SlaRollupPayload = {
            count: reviews.length,
            locationName: reviews[0]!.location_name,
          };

          return [
            {
              organizationId,
              userId: recipient.userId,
              locationId,
              // No single review to point at — the alert is about the pile.
              reviewId: null,
              type: "sla_rollup" as const,
              urgency: "urgent" as const,
              payload,
              // Unique per sweep. Idempotency comes from `sla_alerted_at`, not
              // from this key: the rows are claimed, so a second sweep finds
              // nothing to roll up rather than colliding on a key.
              dedupeKey: `sla_rollup:${locationId}:${now.toISOString()}`,
              emailStatus,
              sendAfter: holdUntil,
              createdAt: now,
            },
          ];
        }

        return reviews.map((review) => ({
          organizationId,
          userId: recipient.userId,
          locationId,
          reviewId: review.id,
          type: "sla_breach" as const,
          urgency: "urgent" as const,
          payload: {
            reviewId: review.id,
            locationName: review.location_name,
            source: review.source,
            rating: review.rating,
            authorName: review.author_name,
            excerpt: excerpt(review.text),
            language: review.language,
          } satisfies ReviewNotificationPayload,
          dedupeKey: dedupeKeyFor("sla_breach", review.id),
          sendAfter: holdUntil,
          emailStatus,
          createdAt: now,
        }));
      });

      if (rows.length === 0) continue;

      const inserted = await tx
        .insert(schema.notifications)
        .values(rows)
        .onConflictDoNothing({
          target: [schema.notifications.userId, schema.notifications.dedupeKey],
        })
        .returning({ id: schema.notifications.id });

      result.created += inserted.length;
    }
  });

  if (result.created > 0) {
    log.info(
      { organizationId, created: result.created, reviews: result.reviews },
      "SLA breach notifications created",
    );
  }

  return result;
}
