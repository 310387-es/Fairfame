import { and, desc, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import type { RangeWindow } from "./range.ts";

/**
 * The activity feed (Home live dashboard §4, widget 10).
 *
 * Built from the tables that hold the events themselves rather than from
 * `audit_logs`. The audit trail records *who did what to which row* for
 * compliance; a feed needs "a 5★ review arrived on Google", which means the
 * review's own rating and source. Reading the audit rows would mean joining
 * back to those tables anyway, and would silently miss everything that happens
 * without a user — ingestion, which is most of what a live feed is for.
 *
 * Its own query and its own Suspense boundary: it needs review text and reply
 * rows the shared facts do not carry, so it streams instead of holding up the
 * numbers.
 */

export type ActivityKind = "review" | "reply" | "request";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  at: Date;
  source: string;
  itemType: "review" | "comment" | "mention" | "dm";
  rating: number | null;
  /** Present on requests: how many went out in that campaign send. */
  count?: number;
  /**
   * Who this event is about (W4.3).
   *
   * The customer for an arrival, the team member for a reply, null for a
   * request — nobody sends a review request *personally*, it is a campaign, and
   * inventing an actor there would be the feed's first untrue line.
   *
   * The audit asks for "a real avatar timeline", and this is what makes it one:
   * without a name every entry was "new 5★ review on Google" and four of them
   * in a row read as a rendering bug rather than as four events.
   */
  actorName: string | null;
  /** Which branch, rendered only where more than one is in view. */
  locationId: string;
};

const FEED_LIMIT = 6;

export async function recentActivity(
  tx: TenantDatabase,
  organizationId: string,
  locationIds: string[],
  window: RangeWindow,
): Promise<ActivityItem[]> {
  const inRange = (column: Parameters<typeof gte>[0]) =>
    and(gte(column, window.start), lt(column, window.end));

  const arrivals = await tx
    .select({
      id: schema.reviews.id,
      at: schema.reviews.createdAt,
      source: schema.reviews.source,
      itemType: schema.reviews.itemType,
      rating: schema.reviews.rating,
      actorName: schema.reviews.authorName,
      locationId: schema.reviews.locationId,
    })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        inArray(schema.reviews.locationId, locationIds),
        // Ingestion time, not the platform's timestamp: the feed answers "what
        // happened here recently", and a three-week-old review that arrived in
        // this morning's sync *is* this morning's news.
        inRange(schema.reviews.createdAt),
      ),
    )
    .orderBy(desc(schema.reviews.createdAt))
    .limit(FEED_LIMIT);

  const replies = await tx
    .select({
      id: schema.replies.id,
      at: schema.replies.postedAt,
      source: schema.reviews.source,
      itemType: schema.reviews.itemType,
      rating: schema.reviews.rating,
      // Who on the team sent it. Left-joined because a reply can be authored by
      // nobody — the AI drafting path records the actor, but a row imported or
      // written by a job has none, and an inner join would silently drop those
      // replies from the feed entirely.
      actorName: schema.users.name,
      locationId: schema.reviews.locationId,
    })
    .from(schema.replies)
    .innerJoin(
      schema.reviews,
      and(
        eq(schema.reviews.id, schema.replies.reviewId),
        eq(schema.reviews.organizationId, schema.replies.organizationId),
      ),
    )
    .leftJoin(schema.users, eq(schema.users.id, schema.replies.authorUserId))
    .where(
      and(
        eq(schema.replies.organizationId, organizationId),
        inArray(schema.reviews.locationId, locationIds),
        isNotNull(schema.replies.postedAt),
        inRange(schema.replies.postedAt),
      ),
    )
    .orderBy(desc(schema.replies.postedAt))
    .limit(FEED_LIMIT);

  const requests = await tx
    .select({
      id: schema.reviewRequests.id,
      at: schema.reviewRequests.sentAt,
      channel: schema.reviewRequests.channel,
      locationId: schema.reviewRequests.locationId,
    })
    .from(schema.reviewRequests)
    .where(
      and(
        eq(schema.reviewRequests.organizationId, organizationId),
        inArray(schema.reviewRequests.locationId, locationIds),
        isNotNull(schema.reviewRequests.sentAt),
        inRange(schema.reviewRequests.sentAt),
      ),
    )
    .orderBy(desc(schema.reviewRequests.sentAt))
    .limit(FEED_LIMIT);

  const items: ActivityItem[] = [
    ...arrivals.map((row) => ({
      id: `review-${row.id}`,
      kind: "review" as const,
      at: new Date(row.at),
      source: row.source,
      itemType: row.itemType,
      rating: row.rating,
      actorName: row.actorName,
      locationId: row.locationId,
    })),
    ...replies.flatMap((row) =>
      row.at
        ? [
            {
              id: `reply-${row.id}`,
              kind: "reply" as const,
              at: new Date(row.at),
              source: row.source,
              itemType: row.itemType,
              rating: row.rating,
              actorName: row.actorName,
              locationId: row.locationId,
            },
          ]
        : [],
    ),
    ...requests.flatMap((row) =>
      row.at
        ? [
            {
              id: `request-${row.id}`,
              kind: "request" as const,
              at: new Date(row.at),
              source: row.channel,
              itemType: "review" as const,
              rating: null,
              // Nobody sends a review request personally — it is a campaign,
              // and naming an actor would be the feed's first untrue line.
              actorName: null,
              locationId: row.locationId,
            },
          ]
        : [],
    ),
  ];

  // Merged and re-cut, so the feed is the most recent six *events* rather than
  // six of each kind with the busiest one crowding the others out.
  return items.sort((left, right) => right.at.getTime() - left.at.getTime()).slice(0, FEED_LIMIT);
}
