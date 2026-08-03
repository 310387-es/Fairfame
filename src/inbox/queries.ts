import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { Sentiment } from "../db/schema.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";

/**
 * Reading the Inbox (P1a-T9).
 *
 * A second reader alongside `listReviewsForLocation` in
 * `connectors/normalize.ts`, not a replacement for it. That one is a plain
 * projection of the canonical table and is what the ingestion tests assert
 * against — giving it joins and filters would make those tests depend on
 * analysis having run. This one serves the screen.
 *
 * One query, not three. A card shows the review, its analysis and its reply
 * state together, and fetching those separately would mean N+1 round trips or
 * three passes over the same hundred rows.
 */

export type ReplyState = "any" | "unanswered" | "answered";

export type InboxFilters = {
  /** Provider key, e.g. `google`. `null` means every source. */
  source?: string | null;
  sentiment?: Sentiment | null;
  /** A theme slug from `review_insights.topics`. */
  theme?: string | null;
  reply?: ReplyState;
  limit?: number;
};

export type InboxRow = {
  id: string;
  authorName: string | null;
  rating: number | null;
  text: string | null;
  language: string | null;
  postedAt: Date | null;
  source: string;
  url: string | null;
  rawPayload: unknown;
  sentiment: Sentiment | null;
  sentimentScore: number | null;
  topics: string[];
  reply: {
    id: string;
    text: string;
    status: "draft" | "approved" | "posted" | "failed";
    aiGenerated: boolean;
    edited: boolean;
    lastError: string | null;
  } | null;
};

/**
 * Reviews for one location, newest first, filtered.
 *
 * The reply join excludes `failed` for the same reason the reply service does:
 * a rejected attempt frees the review to be answered again, so a review with
 * only failed replies still counts as unanswered.
 */
export type InboxPage = {
  rows: InboxRow[];
  /**
   * True when the location holds more matching reviews than were returned.
   *
   * Without this the screen cannot tell "exactly 100 match" from "we stopped at
   * 100", and it printed the first as though it were a fact — a filter bar
   * saying 111 total beside a list claiming 100 matches is a number an owner
   * will not trust twice.
   */
  hasMore: boolean;
};

export async function listInbox(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  filters: InboxFilters = {},
): Promise<InboxPage> {
  const limit = filters.limit ?? 100;

  const rows = await tx
    .select({
      id: schema.reviews.id,
      authorName: schema.reviews.authorName,
      rating: schema.reviews.rating,
      text: schema.reviews.text,
      language: schema.reviews.language,
      postedAt: schema.reviews.postedAt,
      source: schema.reviews.source,
      url: schema.reviews.url,
      rawPayload: schema.reviews.rawPayload,
      sentiment: schema.reviewInsights.sentiment,
      sentimentScore: schema.reviewInsights.sentimentScore,
      topics: schema.reviewInsights.topics,
      replyId: schema.replies.id,
      replyText: schema.replies.text,
      replyStatus: schema.replies.status,
      replyAiGenerated: schema.replies.aiGenerated,
      replyEdited: schema.replies.edited,
      replyLastError: schema.replies.lastError,
    })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .leftJoin(
      schema.replies,
      and(eq(schema.replies.reviewId, schema.reviews.id), ne(schema.replies.status, "failed")),
    )
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.locationId, locationId),
        filters.source ? eq(schema.reviews.source, filters.source) : undefined,
        filters.sentiment ? eq(schema.reviewInsights.sentiment, filters.sentiment) : undefined,
        // `= any(topics)` rather than a LIKE: topics is a text[] with a GIN
        // index (migration 0008), and this is the operator that uses it.
        filters.theme ? sql`${filters.theme} = any(${schema.reviewInsights.topics})` : undefined,
        filters.reply === "unanswered"
          ? isNull(schema.replies.id)
          : filters.reply === "answered"
            ? sql`${schema.replies.id} is not null`
            : undefined,
      ),
    )
    .orderBy(sql`${schema.reviews.postedAt} desc nulls last`)
    // One more than asked for: the extra row is never rendered, it only answers
    // "is there more?" without a second COUNT over the same predicate.
    .limit(limit + 1);

  const hasMore = rows.length > limit;

  const mapped = rows.slice(0, limit).map((row) => ({
    id: row.id,
    authorName: row.authorName,
    rating: row.rating,
    text: row.text,
    language: row.language,
    postedAt: row.postedAt,
    source: row.source,
    url: row.url,
    rawPayload: row.rawPayload,
    sentiment: row.sentiment,
    sentimentScore: row.sentimentScore,
    topics: row.topics ?? [],
    reply: row.replyId
      ? {
          id: row.replyId,
          text: row.replyText ?? "",
          status: row.replyStatus ?? "draft",
          aiGenerated: row.replyAiGenerated ?? false,
          edited: row.replyEdited ?? false,
          lastError: row.replyLastError,
        }
      : null,
  }));

  return { rows: mapped, hasMore };
}

export type FacetCounts = {
  sources: { value: string; count: number }[];
  sentiments: { value: Sentiment; count: number }[];
  themes: { value: string; count: number }[];
  unanswered: number;
  total: number;
};

/**
 * What the filter bar offers, and how many rows each option would show.
 *
 * Counts matter more than they look. A filter list without them is a set of
 * guesses — an owner clicks "negative" hoping something is there. With counts,
 * the bar itself is a summary of the location, and a zero-count option can be
 * left out rather than leading to an empty screen.
 *
 * Deliberately **unfiltered**: these are the counts across the location, not
 * within the current selection. Facets that shrink as you filter make it
 * impossible to widen a search without clearing everything first.
 */
export async function inboxFacets(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
): Promise<FacetCounts> {
  const scope = and(
    eq(schema.reviews.organizationId, organizationId),
    eq(schema.reviews.locationId, locationId),
  );

  // Sequential, not `Promise.all`. These all run on the *same* transaction
  // client, which cannot execute two statements at once: node-postgres
  // serializes them and warns that concurrent `client.query()` is deprecated
  // and removed in pg@9. Awaiting in turn is what actually happens anyway.
  const sources = await tx
    .select({ value: schema.reviews.source, count: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.reviews)
    .where(scope)
    .groupBy(schema.reviews.source)
    .orderBy(desc(sql`count(*)`));

  const sentiments = await tx
    .select({
      value: schema.reviewInsights.sentiment,
      count: sql<number>`count(*)::int`.mapWith(Number),
    })
    .from(schema.reviews)
    .innerJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .where(scope)
    .groupBy(schema.reviewInsights.sentiment);

  const themes = await tx
    .select({ value: sql<string>`topic`, count: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.reviews)
    .innerJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .innerJoin(sql`unnest(${schema.reviewInsights.topics}) as topic`, sql`true`)
    .where(scope)
    .groupBy(sql`topic`)
    .orderBy(desc(sql`count(*)`), asc(sql`topic`))
    // The bar is a filter, not the themes report — that is Home's job.
    .limit(12);

  const totals = await tx
    .select({
      total: sql<number>`count(*)::int`.mapWith(Number),
      unanswered: sql<number>`count(*) filter (where ${schema.replies.id} is null)::int`.mapWith(
        Number,
      ),
    })
    .from(schema.reviews)
    .leftJoin(
      schema.replies,
      and(eq(schema.replies.reviewId, schema.reviews.id), ne(schema.replies.status, "failed")),
    )
    .where(scope);

  const order: Sentiment[] = ["negative", "neutral", "positive"];

  return {
    sources,
    // Negative first: the filter an owner reaches for is not the happy one.
    sentiments: sentiments
      .filter((row): row is { value: Sentiment; count: number } => row.value !== null)
      .sort((left, right) => order.indexOf(left.value) - order.indexOf(right.value)),
    themes,
    unanswered: totals[0]?.unanswered ?? 0,
    total: totals[0]?.total ?? 0,
  };
}
