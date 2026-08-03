import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
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

/**
 * The list's order, in one place.
 *
 * `id` is the tiebreaker and it is load-bearing. Reviews arrive from a sync in
 * batches and the seed pairs them across sources, so identical `posted_at`
 * values are normal. Ordering on that alone is a *partial* order: Postgres may
 * return tied rows differently per query, `offset` pages then overlap, and the
 * page a given review sits on stops being a fact. The notification feed had the
 * same bug and it reached the browser as duplicate React keys.
 */
const INBOX_ORDER = sql`${schema.reviews.postedAt} desc nulls last, ${schema.reviews.id} desc`;

/**
 * `%` and `_` are LIKE wildcards, so a search for "50%" would otherwise match
 * every review. Escaped here and in `search/queries.ts` — the two must agree,
 * or the palette and the full list would disagree about what matched.
 */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Case- and diacritic-folded matching, identical to `search/queries.ts`. The
 * palette's preview and this full list must agree about what matched, and in
 * Turkish that means folding — see migration 0022.
 */
function foldedMatch(column: unknown, pattern: string) {
  return sql`lower(immutable_unaccent(${column})) like lower(immutable_unaccent(${pattern}))`;
}

export type InboxFilters = {
  /** Provider key, e.g. `google`. `null` means every source. */
  source?: string | null;
  sentiment?: Sentiment | null;
  /** A theme slug from `review_insights.topics`. */
  theme?: string | null;
  /**
   * Free text, from the command palette's "see all" link. Matched against the
   * review body and the author with the same trigram-indexed `ILIKE` the
   * palette itself uses, so the full list agrees with the preview.
   */
  query?: string | null;
  reply?: ReplyState;
  limit?: number;
  /** Rows to skip — the page offset. */
  offset?: number;
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

/**
 * The filter predicate, in one place.
 *
 * Shared by `listInbox` and `countInbox`. Written twice, the pager would sooner
 * or later count rows the list does not show — and a "page 4 of 7" that runs
 * out at page 3 is the kind of bug nobody reports, they just stop trusting the
 * numbers.
 */
function inboxPredicate(organizationId: string, locationId: string, filters: InboxFilters) {
  return and(
    eq(schema.reviews.organizationId, organizationId),
    eq(schema.reviews.locationId, locationId),
    filters.source ? eq(schema.reviews.source, filters.source) : undefined,
    filters.sentiment ? eq(schema.reviewInsights.sentiment, filters.sentiment) : undefined,
    // `= any(topics)` rather than a LIKE: topics is a text[] with a GIN index
    // (migration 0008), and this is the operator that uses it.
    filters.theme ? sql`${filters.theme} = any(${schema.reviewInsights.topics})` : undefined,
    filters.query
      ? or(
          foldedMatch(schema.reviews.text, likePattern(filters.query)),
          foldedMatch(schema.reviews.authorName, likePattern(filters.query)),
        )
      : undefined,
    filters.reply === "unanswered"
      ? isNull(schema.replies.id)
      : filters.reply === "answered"
        ? sql`${schema.replies.id} is not null`
        : undefined,
  );
}

/**
 * How many reviews match, ignoring the page.
 *
 * The list alone can say "there is more"; it cannot say "page 3 of 7". That
 * needs a real count, and the same joins — `reply` and `sentiment` filters live
 * on the joined tables, so counting `reviews` alone would over-report.
 */
export async function countInbox(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  filters: InboxFilters = {},
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`count(distinct ${schema.reviews.id})::int` })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .leftJoin(
      schema.replies,
      and(eq(schema.replies.reviewId, schema.reviews.id), ne(schema.replies.status, "failed")),
    )
    .where(inboxPredicate(organizationId, locationId, filters));

  return row?.total ?? 0;
}

/**
 * Which page of the filtered list a given review sits on.
 *
 * Notifications, search results and Home's queue all link to a specific
 * review. Before pagination the Inbox rendered a hundred rows and the anchor
 * usually happened to be among them; at twenty per page it usually is not, so
 * the link quietly landed on page one and the review was nowhere to be seen.
 *
 * Counting rows that sort *before* the target under the same predicate is the
 * only way to answer this that cannot disagree with the list itself — the
 * comparison below is the `ORDER BY` written as a predicate, `nulls last` and
 * all. `count(distinct)` because a review with both a draft and a posted reply
 * joins twice and would otherwise be counted twice.
 *
 * Returns `null` when the review is not in the filtered set at all, which is a
 * real answer: it means "your filters exclude it", not "it does not exist".
 */
export async function locateReview(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  reviewId: string,
  filters: InboxFilters = {},
  pageSize = 20,
): Promise<number | null> {
  const [target] = await tx
    .select({ id: schema.reviews.id, postedAt: schema.reviews.postedAt })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.locationId, locationId),
        eq(schema.reviews.id, reviewId),
      ),
    );

  if (!target) return null;

  const [row] = await tx
    .select({ before: sql<number>`count(distinct ${schema.reviews.id})::int` })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .leftJoin(
      schema.replies,
      and(eq(schema.replies.reviewId, schema.reviews.id), ne(schema.replies.status, "failed")),
    )
    .where(
      and(
        inboxPredicate(organizationId, locationId, filters),
        // `posted_at desc nulls last, id desc`, expressed as "sorts earlier".
        sql`(
          (${schema.reviews.postedAt} is not null and ${target.postedAt}::timestamptz is null)
          or (${schema.reviews.postedAt} > ${target.postedAt}::timestamptz)
          or (${schema.reviews.postedAt} = ${target.postedAt}::timestamptz
              and ${schema.reviews.id} > ${target.id}::uuid)
          or (${schema.reviews.postedAt} is null and ${target.postedAt}::timestamptz is null
              and ${schema.reviews.id} > ${target.id}::uuid)
        )`,
      ),
    );

  // The target itself must match the filters, or the page we compute is a page
  // it does not appear on.
  const [present] = await tx
    .select({ hit: sql<number>`count(distinct ${schema.reviews.id})::int` })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .leftJoin(
      schema.replies,
      and(eq(schema.replies.reviewId, schema.reviews.id), ne(schema.replies.status, "failed")),
    )
    .where(
      and(inboxPredicate(organizationId, locationId, filters), eq(schema.reviews.id, reviewId)),
    );

  if (!present?.hit) return null;

  return Math.floor((row?.before ?? 0) / pageSize) + 1;
}

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
    .where(inboxPredicate(organizationId, locationId, filters))
    .orderBy(INBOX_ORDER)
    // One more than asked for: the extra row answers "is there another page?"
    // without a second query.
    .limit(limit + 1)
    .offset(filters.offset ?? 0);

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
