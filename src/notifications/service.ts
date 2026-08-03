import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { recipientsForLocation, shouldNotify } from "./preferences.ts";

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

/** One notification per user per review; the key makes a re-run a no-op. */
export function dedupeKeyFor(type: "new_review", reviewId: string): string {
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
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        isNull(schema.notifications.id),
        // Reviews that predate the organization's interest are not news. The
        // window is generous; the sweep is a safety net, not an archive tour.
        sql`${schema.reviews.createdAt} > now() - interval '7 days'`,
      ),
    )
    .orderBy(schema.reviews.id, desc(schema.reviews.createdAt))
    .limit(limit);
}

function excerpt(text: string | null): string | null {
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
