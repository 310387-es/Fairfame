import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import type { ReviewNotificationPayload } from "./service.ts";

/**
 * Reading the in-app feed (P1a-T5).
 *
 * **Every function here takes a `userId` and filters on it.** RLS enforces the
 * tenant boundary and nothing else — Postgres knows which organization the
 * transaction belongs to, not which person is looking — so one member reading
 * another's feed is prevented here or not at all. That is why the user id is a
 * required parameter rather than something read from a context object: a
 * missing filter should be a type error, not a quiet disclosure.
 */

export type FeedItem = {
  id: string;
  type: "new_review";
  urgency: "normal" | "urgent";
  payload: ReviewNotificationPayload;
  reviewId: string | null;
  locationId: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export type FeedOptions = {
  limit?: number;
  /** Only unread — what the bell opens to. */
  unreadOnly?: boolean;
};

/**
 * A user's notifications, urgent first within the same day.
 *
 * Ordering is `urgency desc, created_at desc` rather than pure recency, which
 * is the "negatives are prioritized" half of the Definition of Done: a 1-star
 * from this morning must not be pushed below three 5-stars from this afternoon.
 */
export async function listFeed(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
  options: FeedOptions = {},
): Promise<FeedItem[]> {
  const rows = await tx
    .select({
      id: schema.notifications.id,
      type: schema.notifications.type,
      urgency: schema.notifications.urgency,
      payload: schema.notifications.payload,
      reviewId: schema.notifications.reviewId,
      locationId: schema.notifications.locationId,
      readAt: schema.notifications.readAt,
      createdAt: schema.notifications.createdAt,
    })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.organizationId, organizationId),
        eq(schema.notifications.userId, userId),
        options.unreadOnly ? isNull(schema.notifications.readAt) : undefined,
      ),
    )
    // `urgent` sorts before `normal` alphabetically only by accident, so order
    // on the comparison rather than on the enum's text.
    .orderBy(
      sql`(${schema.notifications.urgency} = 'urgent') desc`,
      desc(schema.notifications.createdAt),
    )
    .limit(options.limit ?? 50);

  return rows.map((row) => ({
    ...row,
    payload: row.payload as ReviewNotificationPayload,
  }));
}

export type UnreadCounts = { total: number; urgent: number };

/** The badge. One query, because it renders on every page. */
export async function unreadCounts(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
): Promise<UnreadCounts> {
  const [row] = await tx
    .select({
      total: sql<number>`count(*)::int`.mapWith(Number),
      urgent:
        sql<number>`count(*) filter (where ${schema.notifications.urgency} = 'urgent')::int`.mapWith(
          Number,
        ),
    })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.organizationId, organizationId),
        eq(schema.notifications.userId, userId),
        isNull(schema.notifications.readAt),
      ),
    );

  return { total: row?.total ?? 0, urgent: row?.urgent ?? 0 };
}

/** Marks specific notifications read. Silently ignores ids the user does not own. */
export async function markRead(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
  ids: string[],
  now = new Date(),
): Promise<number> {
  if (ids.length === 0) return 0;

  const rows = await tx
    .update(schema.notifications)
    .set({ readAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.notifications.organizationId, organizationId),
        eq(schema.notifications.userId, userId),
        inArray(schema.notifications.id, ids),
        isNull(schema.notifications.readAt),
      ),
    )
    .returning({ id: schema.notifications.id });

  return rows.length;
}

/** Marks everything read for one user. */
export async function markAllRead(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
  now = new Date(),
): Promise<number> {
  const rows = await tx
    .update(schema.notifications)
    .set({ readAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.notifications.organizationId, organizationId),
        eq(schema.notifications.userId, userId),
        isNull(schema.notifications.readAt),
      ),
    )
    .returning({ id: schema.notifications.id });

  return rows.length;
}
