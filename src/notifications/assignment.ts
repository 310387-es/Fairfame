import { eq, inArray } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { recipientsForLocation, shouldNotify } from "./preferences.ts";
import { excerpt, type ReviewNotificationPayload } from "./service.ts";

/**
 * Telling someone that work has been handed to them (P2-T4 follow-up).
 *
 * Assignment shipped audit-logged and silent: the column was written, the audit
 * row recorded who did it, and the person receiving the work was told nothing.
 * They found out by opening the inbox and remembering the "Assigned to me"
 * filter. `docs/17` asked for assignment to be "audit-logged" and never said
 * notify, so this is an omission rather than a decision anybody made.
 *
 * Four rules, each of which is a decision worth being able to point at:
 *
 *   1. **Only the assignee is told.** Every other notification in the product
 *      goes to everyone subscribed to a location, because a new review is news
 *      about the business. An assignment is news about *one person's* workload.
 *   2. **Assigning to yourself notifies nobody.** You were there.
 *   3. **"Negative only" does not apply; "off" does.** Exactly the rule the SLA
 *      sweep already follows, and for the reason stated there: scope is about
 *      which *customers* are worth interrupting for, while this is about a
 *      commitment inside the team. Someone who turned notifications off
 *      entirely has made a decision about being interrupted at all, and that is
 *      still honoured.
 *   4. **Email follows the same preference as everything else.** No special
 *      case: someone who has email on gets one, someone who chose the digest
 *      has it deferred, someone who turned it off does not. The templates say
 *      "assigned to you" rather than "a new review came in", because a review
 *      that arrived last Tuesday and reached you this morning did not just
 *      arrive — see `reason: "assigned"` in src/messaging/templates.ts.
 *   5. **Never urgent.** Urgency in this product means "a customer is unhappy"
 *      or "a promise has lapsed". A handoff is neither, and borrowing the red
 *      badge for workflow would devalue it everywhere else.
 */

const log = childLogger({ module: "notifications/assignment" });

/**
 * Past this many reviews in one action, the alert becomes a single line.
 *
 * The same threshold and the same reasoning as the SLA rollup: five is a list
 * somebody reads, fifty is a wall they scroll past, and bulk assignment can
 * move fifty in one click. Unlike a breach rollup this one *is* a summary of
 * individually actionable items — which is why it names the count and sends the
 * reader to a filtered inbox rather than pretending to be one review.
 */
export const ASSIGNMENT_ROLLUP_THRESHOLD = 5;

/** What a bulk assignment carries instead of a single review. */
export type AssignmentRollupPayload = {
  count: number;
  locationName: string;
};

/**
 * Notifies the assignee about reviews just assigned to them.
 *
 * Takes the ids of reviews **already written**, so the notification cannot
 * describe an assignment that failed — and runs inside the caller's transaction
 * for the same reason: if the assignment rolls back, so does the alert.
 *
 * Never throws. A notification is a courtesy on top of the write that matters;
 * a failure here must not undo an assignment the user watched succeed.
 */
export async function notifyAssignment(
  tx: TenantDatabase,
  input: {
    organizationId: string;
    /** Who did the assigning. */
    actorUserId: string;
    /** Who received it. Null is an *un*assignment, which notifies nobody. */
    assigneeUserId: string | null;
    reviewIds: string[];
    now?: Date;
  },
): Promise<number> {
  const { organizationId, actorUserId, assigneeUserId, reviewIds, now = new Date() } = input;

  if (assigneeUserId === null || reviewIds.length === 0) return 0;
  // Rule 2: you do not need telling about a decision you just made.
  if (assigneeUserId === actorUserId) return 0;

  try {
    const reviews = await tx
      .select({
        id: schema.reviews.id,
        locationId: schema.reviews.locationId,
        locationName: schema.locations.name,
        source: schema.reviews.source,
        rating: schema.reviews.rating,
        authorName: schema.reviews.authorName,
        text: schema.reviews.text,
        language: schema.reviews.language,
      })
      .from(schema.reviews)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.reviews.locationId))
      .where(inArray(schema.reviews.id, reviewIds));

    if (reviews.length === 0) return 0;

    // Grouped by location because that is what a preference is resolved
    // against, and what a rollup can honestly name. A selection can span
    // branches; the number of distinct ones is small.
    const byLocation = new Map<string, typeof reviews>();
    for (const review of reviews) {
      byLocation.set(review.locationId, [...(byLocation.get(review.locationId) ?? []), review]);
    }

    const rows: (typeof schema.notifications.$inferInsert)[] = [];

    for (const [locationId, group] of byLocation) {
      const recipients = await recipientsForLocation(tx, organizationId, locationId);
      const assignee = recipients.find((recipient) => recipient.userId === assigneeUserId);

      // Not a member of this organization, or not visible from this location.
      // The assignment itself already validated scope; this is the notification
      // declining to invent a recipient.
      if (!assignee) continue;

      /**
       * `negative: true` is how rule 3 is expressed against the existing
       * decision function: it makes `all` and `negative_only` both say yes and
       * leaves `off` saying no. The SLA sweep does the same thing.
       */
      const decision = shouldNotify(assignee.preference, { negative: true });
      if (!decision.inApp && !decision.email && !decision.deferEmail) continue;

      // Same three-way mapping every other alert uses: send now, hold for the
      // digest, or record the entry and send nothing.
      const emailStatus = decision.email
        ? ("pending" as const)
        : decision.deferEmail
          ? ("deferred" as const)
          : ("skipped" as const);

      const rolledUp = group.length > ASSIGNMENT_ROLLUP_THRESHOLD;

      if (rolledUp) {
        rows.push({
          organizationId,
          userId: assigneeUserId,
          locationId,
          reviewId: null,
          type: "assignment_rollup",
          urgency: "normal",
          payload: {
            count: group.length,
            locationName: group[0]!.locationName,
          } satisfies AssignmentRollupPayload,
          // Unique per action. Two separate bulk assignments to the same person
          // at the same branch are two pieces of news, not a duplicate.
          dedupeKey: `assignment_rollup:${locationId}:${now.toISOString()}`,
          emailStatus,
          createdAt: now,
        });
        continue;
      }

      for (const review of group) {
        rows.push({
          organizationId,
          userId: assigneeUserId,
          locationId,
          reviewId: review.id,
          type: "review_assigned",
          urgency: "normal",
          payload: {
            reviewId: review.id,
            locationName: review.locationName,
            source: review.source,
            rating: review.rating,
            authorName: review.authorName,
            excerpt: excerpt(review.text),
            language: review.language,
          } satisfies ReviewNotificationPayload,
          /**
           * Keyed on the review *and* the assignee, not the review alone:
           * passing an item from one person to another is news for the second
           * person, and re-assigning it back later is news again. The timestamp
           * is what allows that second time — a bare `type:review:user` key
           * would silently swallow it.
           */
          dedupeKey: `review_assigned:${review.id}:${now.toISOString()}`,
          emailStatus,
          createdAt: now,
        });
      }
    }

    if (rows.length === 0) return 0;

    const inserted = await tx
      .insert(schema.notifications)
      .values(rows)
      .onConflictDoNothing({
        target: [schema.notifications.userId, schema.notifications.dedupeKey],
      })
      .returning({ id: schema.notifications.id });

    return inserted.length;
  } catch (error) {
    // Rule: the assignment already happened. Losing its alert is a degraded
    // outcome; failing the action the user watched succeed is a wrong one.
    log.warn({ err: error, organizationId, assigneeUserId }, "Assignment notification failed");
    return 0;
  }
}
