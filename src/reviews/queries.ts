import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/client.ts";
import type { ReviewStatus, Sentiment } from "../db/schema.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { ANSWERED, DRAFTED, liveReplyJoin, UNANSWERED } from "./answered.ts";
import { PUBLIC_FEEDBACK } from "./item-kind.ts";
import {
  ASSIGNEE_ME,
  ASSIGNEE_NOBODY,
  type InboxFilterState,
  type InboxSort,
  type ReplyState,
} from "./filters.ts";

/**
 * Reading the Inbox (P1a-T9, extended for team triage in P2-T2).
 *
 * A second reader alongside `listReviewsForLocation` in
 * `connectors/normalize.ts`, not a replacement for it. That one is a plain
 * projection of the canonical table and is what the ingestion tests assert
 * against — giving it joins and filters would make those tests depend on
 * analysis having run. This one serves the screen.
 *
 * One query, not three. A card shows the review, its analysis, its reply state
 * and now its triage state together, and fetching those separately would mean
 * N+1 round trips or four passes over the same hundred rows.
 *
 * Every filter, the count, the page locator and the facet counts share one
 * predicate. Written twice, the pager would sooner or later count rows the list
 * does not show — and a "page 4 of 7" that runs out at page 3 is the kind of bug
 * nobody reports, they just stop trusting the numbers.
 */

export type { ReplyState };

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

/**
 * How many words a search may contain before the rest are ignored.
 *
 * Each term adds two folded LIKEs to the predicate, so this is a bound on how
 * expensive one pasted paragraph can make a query. Six is far past what anyone
 * types deliberately.
 */
const MAX_SEARCH_TERMS = 6;

/**
 * Searching the text of reviews, across words.
 *
 * Every word must appear somewhere in the review body or the author's name, in
 * any order — so "yavaş servis" finds "servis çok yavaştı", which the single
 * `LIKE '%yavaş servis%'` this replaced could not. That is the thing people
 * actually mean by searching a review's full text.
 *
 * Still substring matching rather than `to_tsquery`, for the reason
 * `search/queries.ts` sets out at length: Postgres ships no Turkish stemmer, and
 * lexeme matching in an agglutinative language turns "bekleme" and "beklemede"
 * into unrelated words while refusing the fragments people type. Matching per
 * word keeps the trigram indexes from migration 0021 doing the work.
 *
 * It is also deliberately a superset of what the command palette previews: the
 * palette matches the typed string as one phrase, and every phrase match
 * contains all of its words. "See all results" therefore never shows *fewer*
 * rows than the preview did, which is the direction that would look broken.
 */
function searchPredicate(query: string): SQL | undefined {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .slice(0, MAX_SEARCH_TERMS);

  if (terms.length === 0) return undefined;

  return and(
    ...terms.map((term) =>
      or(
        foldedMatch(schema.reviews.text, likePattern(term)),
        foldedMatch(schema.reviews.authorName, likePattern(term)),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Ordering, and the two things derived from it
// ---------------------------------------------------------------------------

/**
 * A column in the sort, and whether it can be null.
 *
 * The list's order is expressed once, as data, because three separate things
 * have to agree with it exactly: the ORDER BY, the keyset cursor ("give me what
 * comes after this row") and `locateReview` ("which page does this row sit
 * on"). Writing the comparison out by hand in each place is how a keyset pager
 * silently skips a row — it looks right, and only a reader who scrolls past the
 * seam ever notices.
 *
 * Everything sorts `desc nulls last`. `id` is the final tiebreaker and it is
 * load-bearing: reviews arrive from a sync in batches and the seed pairs them
 * across sources, so identical `posted_at` values are normal. Ordering on that
 * alone is a *partial* order — Postgres may return tied rows differently per
 * query, pages then overlap, and the page a given review sits on stops being a
 * fact. The notification feed had the same bug and it reached the browser as
 * duplicate React keys.
 */
type SortKey = {
  column: AnyColumn;
  nullable: boolean;
  /** This key's value for a given cursor position. */
  valueOf: (cursor: InboxCursor) => unknown;
  /** The cast the bound value needs, since a cursor arrives as JSON. */
  cast: string;
};

const POSTED_AT_KEY: SortKey = {
  column: schema.reviews.postedAt,
  nullable: true,
  valueOf: (cursor) => cursor.postedAt,
  cast: "timestamptz",
};

const PRIORITY_KEY: SortKey = {
  column: schema.reviews.priority,
  nullable: true,
  valueOf: (cursor) => cursor.priority,
  cast: "int",
};

const ID_KEY: SortKey = {
  column: schema.reviews.id,
  nullable: false,
  valueOf: (cursor) => cursor.id,
  cast: "uuid",
};

/**
 * `priority` puts the triage queue in front: the angriest unanswered thing
 * first, ties broken by recency. Recency is the second key rather than part of
 * the score for the reason set out in `./workflow.ts` — a stored number that
 * decays with age is wrong an hour after it is written.
 */
function sortKeys(sort: InboxSort): SortKey[] {
  return sort === "priority" ? [PRIORITY_KEY, POSTED_AT_KEY, ID_KEY] : [POSTED_AT_KEY, ID_KEY];
}

function orderClause(sort: InboxSort): SQL {
  return sql.join(
    sortKeys(sort).map((key) => sql`${key.column} desc nulls last`),
    sql`, `,
  );
}

/** The cursor's value for a key, bound and cast so Postgres compares like with like. */
function boundValue(key: SortKey, cursor: InboxCursor): SQL {
  return sql`${key.valueOf(cursor)}::${sql.raw(key.cast)}`;
}

/** "This key is equal to the cursor's." `is not distinct from` handles null = null. */
function equalTo(key: SortKey, cursor: InboxCursor): SQL {
  const value = boundValue(key, cursor);
  return key.nullable
    ? sql`(${key.column} is not distinct from ${value})`
    : sql`(${key.column} = ${value})`;
}

/** "This key sorts later than the cursor's", under `desc nulls last`. */
function sortsAfter(key: SortKey, cursor: InboxCursor): SQL {
  const value = boundValue(key, cursor);
  if (!key.nullable) return sql`(${key.column} < ${value})`;

  return sql`(
    (${key.column} is null and ${value} is not null)
    or (${key.column} is not null and ${value} is not null and ${key.column} < ${value})
  )`;
}

/** The mirror image: "this key sorts earlier than the cursor's". */
function sortsBefore(key: SortKey, cursor: InboxCursor): SQL {
  const value = boundValue(key, cursor);
  if (!key.nullable) return sql`(${key.column} > ${value})`;

  return sql`(
    (${key.column} is not null and ${value} is null)
    or (${key.column} is not null and ${value} is not null and ${key.column} > ${value})
  )`;
}

/**
 * The ORDER BY, rewritten as a predicate.
 *
 * Lexicographic: a row sorts after the cursor when its first key is later, or
 * its first key ties and its second is later, and so on. This is the one place
 * that comparison exists.
 */
function comparedToCursor(sort: InboxSort, cursor: InboxCursor, side: "after" | "before"): SQL {
  const keys = sortKeys(sort);
  const branches: SQL[] = [];

  for (let index = 0; index < keys.length; index += 1) {
    const parts = keys.slice(0, index).map((key) => equalTo(key, cursor));
    const key = keys[index]!;
    parts.push(side === "after" ? sortsAfter(key, cursor) : sortsBefore(key, cursor));
    branches.push(sql`(${sql.join(parts, sql` and `)})`);
  }

  return sql`(${sql.join(branches, sql` or `)})`;
}

// ---------------------------------------------------------------------------
// The keyset cursor
// ---------------------------------------------------------------------------

/**
 * Where the last page stopped.
 *
 * Carries every sort key rather than only the ones the current sort uses, so a
 * cursor stays decodable if the reader switches order mid-scroll — the list
 * restarts in that case, which is correct, but it should not throw.
 */
export type InboxCursor = {
  postedAt: string | null;
  priority: number | null;
  id: string;
};

const cursorSchema = z.object({
  postedAt: z.string().datetime().nullable(),
  priority: z.number().int().nullable(),
  id: z.uuid(),
});

/**
 * Opaque to the caller on purpose. It is a position in a result set, not an
 * API — encoding it as base64url keeps it out of the way in a URL and stops
 * anyone building a feature on its internals.
 */
export function encodeCursor(cursor: InboxCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * A cursor arrives from a URL, so it is untrusted input: parsed with Zod and
 * discarded whole if it does not fit. A bad cursor means "start from the top",
 * which is a recoverable experience; an exception is not.
 */
export function decodeCursor(raw: string | null | undefined): InboxCursor | null {
  if (!raw) return null;

  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function cursorFor(row: { id: string; postedAt: Date | null; priority: number | null }): string {
  return encodeCursor({
    postedAt: row.postedAt?.toISOString() ?? null,
    priority: row.priority,
    id: row.id,
  });
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type InboxFilters = {
  /** Provider key, e.g. `google`. `null` means every source. */
  source?: string | null;
  sentiment?: Sentiment | null;
  /** A theme slug from `review_insights.topics`. */
  theme?: string | null;
  /** A canonical theme key (W3.2) — see `src/reviews/taxonomy.ts`. */
  canonical?: string | null;
  /** Free text, matched word by word against the review body and the author. */
  query?: string | null;
  reply?: ReplyState | "any" | null;
  /** Empty or absent means every status. */
  status?: ReviewStatus[] | null;
  /** Star values. Empty or absent means any rating, including none at all. */
  rating?: number[] | null;
  /** A user id, `unassigned`, or absent for "anyone". */
  assignee?: string | null;
  /** Past its deadline and not yet resolved. */
  overdue?: boolean;
  /** Inclusive lower bound on `posted_at`. */
  postedFrom?: Date | null;
  /** Exclusive upper bound on `posted_at` — callers pass the start of the next day. */
  postedTo?: Date | null;
  /**
   * Exactly these review ids (W2.1).
   *
   * The one filter that names rows rather than describing them. Callers pass a
   * list already parsed by `src/reviews/filters.ts`, which caps and shape-checks
   * it — this layer trusts that, the same way it trusts `rating` to be 1–5.
   */
  reviews?: string[] | null;
  sort?: InboxSort;
  limit?: number;
  /** Rows to skip — the page offset. Ignored when a cursor is supplied. */
  offset?: number;
  /** Keyset position; takes precedence over `offset`. */
  cursor?: InboxCursor | null;
};

/**
 * Turns the URL's filter state into query filters.
 *
 * Two things are resolved here and nowhere else: `me` becomes the reader's own
 * id, and a pair of `YYYY-MM-DD` days becomes a half-open instant range. Both
 * need context the URL does not carry — who is asking, and that "to 3 August"
 * means the whole of that day, not midnight at the start of it.
 */
export function toInboxFilters(
  state: InboxFilterState,
  context: { userId?: string | null } = {},
): InboxFilters {
  const assignee =
    state.assignee === ASSIGNEE_ME
      ? // A reader with no user id (a job, a test) matches nobody rather than
        // everybody: "assigned to me" with no me is an empty list, not the inbox.
        (context.userId ?? "")
      : state.assignee;

  const dayStart = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

  return {
    source: state.source,
    sentiment: state.sentiment,
    theme: state.theme,
    canonical: state.canonical,
    query: state.query,
    reply: state.reply,
    status: state.status,
    rating: state.rating,
    assignee,
    overdue: state.overdue,
    postedFrom: state.from ? dayStart(state.from) : null,
    postedTo: state.to ? new Date(dayStart(state.to).getTime() + 24 * 60 * 60 * 1000) : null,
    reviews: state.reviews,
    sort: state.sort,
  };
}

/**
 * The filter predicate, in one place.
 *
 * Shared by every read below. `undefined` entries are dropped by `and()`, so an
 * absent filter costs nothing in the generated SQL.
 */
function inboxPredicate(organizationId: string, locationId: string, filters: InboxFilters) {
  const assignee = filters.assignee;

  return and(
    eq(schema.reviews.organizationId, organizationId),
    eq(schema.reviews.locationId, locationId),
    /**
     * A direct message is not a review, and this is the review queue (A22-C1).
     *
     * They sat here counted as reviews on the one screen whose header is a
     * count of them, in a queue where answering one is deliberately not built —
     * so the row was work nobody could do, inflating the number beside it. They
     * are read on `/conversations` now, which is where a letter belongs; the
     * one thing that must never happen is their disappearing, and
     * `src/reviews/direct-messages.ts` is what stops that.
     */
    PUBLIC_FEEDBACK,
    filters.source ? eq(schema.reviews.source, filters.source) : undefined,
    filters.sentiment ? eq(schema.reviewInsights.sentiment, filters.sentiment) : undefined,
    // A theme is either something the model found or something a colleague put
    // there by hand (P2-T6), and the filter has to mean both — otherwise bulk
    // tagging forty reviews "iade" produces a theme that matches nothing.
    //
    // `= any(topics)` rather than a LIKE for the first half: topics is a text[]
    // with a GIN index (migration 0008), and this is the operator that uses it.
    filters.theme
      ? or(
          sql`${filters.theme} = any(${schema.reviewInsights.topics})`,
          sql`exists (
            select 1
            from ${schema.reviewTags} rt
            join ${schema.tags} t on t.id = rt.tag_id
            where rt.review_id = ${schema.reviews.id} and t.slug = ${filters.theme}
          )`,
        )
      : undefined,
    // The canonical theme, which is a different question from the tag above:
    // one key, one meaning, whatever language the customer wrote in (W3.2).
    // `= any(themes)` uses the GIN index from migration 0047.
    filters.canonical
      ? sql`${filters.canonical} = any(${schema.reviewInsights.themes})`
      : undefined,
    filters.query ? searchPredicate(filters.query) : undefined,
    filters.status && filters.status.length > 0
      ? inArray(schema.reviews.status, filters.status)
      : undefined,
    filters.rating && filters.rating.length > 0
      ? inArray(schema.reviews.rating, filters.rating)
      : undefined,
    assignee === ASSIGNEE_NOBODY
      ? isNull(schema.reviews.assigneeUserId)
      : assignee
        ? eq(schema.reviews.assigneeUserId, assignee)
        : // An empty string is what `me` resolves to when nobody is asking. It
          // is not a user id, so it must match nothing rather than everything.
          assignee === ""
          ? sql`false`
          : undefined,
    /**
     * Exactly these reviews (W2.1).
     *
     * Applied like any other clause rather than short-circuiting the rest, so a
     * pinned link still honours whatever else is in the URL — an owner who
     * follows "show me those three" and then clicks "needs a reply" gets the
     * subset, not a silently ignored filter. Parsing has already capped and
     * shape-checked the list, so `inArray` is safe to hand straight over.
     */
    filters.reviews && filters.reviews.length > 0
      ? inArray(schema.reviews.id, filters.reviews)
      : undefined,
    // Only an unresolved item can breach: a review closed last month is not
    // "overdue", it is finished.
    filters.overdue
      ? and(
          isNotNull(schema.reviews.slaDueAt),
          lt(schema.reviews.slaDueAt, sql`now()`),
          inArray(schema.reviews.status, ["open", "in_progress"]),
          // Answered — even answered *late* — is not overdue. Nobody is waiting
          // any more, and the card already says "answered late" rather than
          // "overdue": a filter that disagreed with the badge on the row it just
          // returned is the kind of contradiction that costs a reader their
          // trust in both. `slaState()` treats a first response as terminal, and
          // this is the same rule written as SQL.
          //
          // `owner_replied_at` joined it in W1.2. It was the omission that made
          // the chip claim 78 overdue reviews the owner had already answered on
          // Google — the badge said "answered", the filter said "overdue", and
          // both were reading different columns.
          isNull(schema.reviews.firstResponseAt),
          isNull(schema.reviews.ownerRepliedAt),
        )
      : undefined,
    filters.postedFrom ? sql`${schema.reviews.postedAt} >= ${filters.postedFrom}` : undefined,
    filters.postedTo ? sql`${schema.reviews.postedAt} < ${filters.postedTo}` : undefined,
    // One definition, shared with the chips and with `slaState` — see
    // `src/reviews/answered.ts`. A reply the owner left on the platform counts;
    // a draft nobody has posted does not (A22-A4), and `drafted` is the way to
    // look at exactly those without taking them out of the queue.
    filters.reply === "unanswered"
      ? UNANSWERED
      : filters.reply === "answered"
        ? ANSWERED
        : filters.reply === "drafted"
          ? DRAFTED
          : undefined,
  );
}

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
  /**
   * The earlier review this one duplicates, across sources (W5-7).
   *
   * Carried so the row can say "the same person also wrote this on Google"
   * rather than being quietly hidden — nothing is removed from the queue, and
   * no count changes. See `src/reviews/duplicates.ts`.
   */
  duplicateOfId: string | null;
  sentiment: Sentiment | null;
  sentimentScore: number | null;
  /** Free-text tags, in the language the customer wrote. Not a label. */
  topics: string[];
  /**
   * Canonical themes (W3.2). Frequently empty — the column landed with no
   * backfill — which is why a reader prefers these and falls back to `topics`.
   */
  themes: string[];
  /** Team triage state (P2-T1). */
  status: ReviewStatus;
  priority: number | null;
  slaDueAt: Date | null;
  firstResponseAt: Date | null;
  /** When the business answered on the platform itself (W1.2). */
  ownerRepliedAt: Date | null;
  assignee: { id: string; name: string | null } | null;
  reply: {
    id: string;
    text: string;
    status: "draft" | "approved" | "posted" | "failed";
    aiGenerated: boolean;
    edited: boolean;
    lastError: string | null;
  } | null;
};

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
  /**
   * Where to resume. Null when there is nothing after this page.
   *
   * This is what infinite scroll pages on: an offset re-reads rows by position,
   * so a review ingested while someone is scrolling shifts everything down by
   * one and the reader sees the same card twice. A cursor names a *row*, so new
   * arrivals land above it and nothing is repeated or skipped.
   */
  nextCursor: string | null;
};

/**
 * How many reviews match, ignoring the page.
 *
 * The list alone can say "there is more"; it cannot say "page 3 of 7". That
 * needs a real count, and the same joins — `reply`, `sentiment` and `theme`
 * filters live on joined tables, so counting `reviews` alone would over-report.
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
    .leftJoin(schema.replies, liveReplyJoin)
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
 * comparison is the ORDER BY written as a predicate, and it now follows
 * whichever sort the reader has chosen rather than assuming "newest first".
 * `count(distinct)` because a review with both a draft and a posted reply joins
 * twice and would otherwise be counted twice.
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
    .select({
      id: schema.reviews.id,
      postedAt: schema.reviews.postedAt,
      priority: schema.reviews.priority,
    })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.locationId, locationId),
        eq(schema.reviews.id, reviewId),
      ),
    );

  if (!target) return null;

  const position: InboxCursor = {
    id: target.id,
    postedAt: target.postedAt?.toISOString() ?? null,
    priority: target.priority,
  };

  const [row] = await tx
    .select({ before: sql<number>`count(distinct ${schema.reviews.id})::int` })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .leftJoin(schema.replies, liveReplyJoin)
    .where(
      and(
        inboxPredicate(organizationId, locationId, filters),
        comparedToCursor(filters.sort ?? "recent", position, "before"),
      ),
    );

  // The target itself must match the filters, or the page we compute is a page
  // it does not appear on.
  const [present] = await tx
    .select({ hit: sql<number>`count(distinct ${schema.reviews.id})::int` })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .leftJoin(schema.replies, liveReplyJoin)
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
  const sort = filters.sort ?? "recent";

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
      duplicateOfId: schema.reviews.duplicateOfId,
      status: schema.reviews.status,
      priority: schema.reviews.priority,
      slaDueAt: schema.reviews.slaDueAt,
      firstResponseAt: schema.reviews.firstResponseAt,
      ownerRepliedAt: schema.reviews.ownerRepliedAt,
      assigneeUserId: schema.reviews.assigneeUserId,
      assigneeName: schema.users.name,
      sentiment: schema.reviewInsights.sentiment,
      sentimentScore: schema.reviewInsights.sentimentScore,
      topics: schema.reviewInsights.topics,
      themes: schema.reviewInsights.themes,
      replyId: schema.replies.id,
      replyText: schema.replies.text,
      replyStatus: schema.replies.status,
      replyAiGenerated: schema.replies.aiGenerated,
      replyEdited: schema.replies.edited,
      replyLastError: schema.replies.lastError,
    })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .leftJoin(schema.replies, liveReplyJoin)
    // The assignee's name, for the card. The id being joined on came from a row
    // this tenant already owns, so the join cannot reach a stranger.
    .leftJoin(schema.users, eq(schema.users.id, schema.reviews.assigneeUserId))
    .where(
      and(
        inboxPredicate(organizationId, locationId, filters),
        filters.cursor ? comparedToCursor(sort, filters.cursor, "after") : undefined,
      ),
    )
    .orderBy(orderClause(sort))
    // One more than asked for: the extra row answers "is there another page?"
    // without a second query.
    .limit(limit + 1)
    // A cursor already says where to start; adding an offset on top of it would
    // skip a page's worth of rows on top of the ones already read.
    .offset(filters.cursor ? 0 : (filters.offset ?? 0));

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);

  const mapped = page.map((row) => ({
    id: row.id,
    authorName: row.authorName,
    rating: row.rating,
    text: row.text,
    language: row.language,
    postedAt: row.postedAt,
    source: row.source,
    url: row.url,
    rawPayload: row.rawPayload,
    duplicateOfId: row.duplicateOfId,
    status: row.status,
    priority: row.priority,
    slaDueAt: row.slaDueAt,
    firstResponseAt: row.firstResponseAt,
    ownerRepliedAt: row.ownerRepliedAt,
    assignee: row.assigneeUserId ? { id: row.assigneeUserId, name: row.assigneeName } : null,
    sentiment: row.sentiment,
    sentimentScore: row.sentimentScore,
    topics: row.topics ?? [],
    themes: row.themes ?? [],
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

  return {
    rows: mapped,
    hasMore,
    nextCursor: hasMore && last ? cursorFor(last) : null,
  };
}

export type FacetCounts = {
  sources: { value: string; count: number }[];
  sentiments: { value: Sentiment; count: number }[];
  themes: { value: string; count: number }[];
  /**
   * Canonical themes (W3.2) — keys, not labels, translated at render time.
   *
   * Its own facet rather than merged into `themes`: those are free-text tags in
   * the customer's language, and showing `wait_time` beside `bekleme süresi` as
   * though they were siblings is the confusion this replaces.
   */
  canonicalThemes: { value: string; count: number }[];
  /**
   * Analysed reviews, and how many of them carry canonical themes.
   *
   * Lets a surface tell "no theme fits these reviews" from "these reviews
   * predate the taxonomy" — a distinction the counts alone cannot make, and
   * the same one W1.6 had to draw for the digest's "0 reviews on".
   */
  themeCoverage: { analysed: number; withThemes: number };
  statuses: { value: ReviewStatus; count: number }[];
  unanswered: number;
  /**
   * Of the unanswered, how many already have something written (A22-A4).
   *
   * A **subset of `unanswered`**, never a number to add to it — the customer
   * has not heard back either way. It is the difference between "nobody has
   * looked at these" and "somebody has, and nobody sent it".
   */
  drafted: number;
  /** Past its deadline and still open or in progress. */
  overdue: number;
  /** Assigned to the reader. Zero when there is no reader. */
  mine: number;
  unassigned: number;
  total: number;
};

const STATUS_ORDER: ReviewStatus[] = ["open", "in_progress", "done", "ignored"];

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
  options: { userId?: string | null } = {},
): Promise<FacetCounts> {
  const scope = and(
    eq(schema.reviews.organizationId, organizationId),
    eq(schema.reviews.locationId, locationId),
    // The same rule the list applies, or a chip would promise a number the list
    // then contradicts (A22-C1).
    PUBLIC_FEEDBACK,
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

  // Both halves of what a theme can be, in one list. `union` rather than
  // `union all` so a review the model tagged "servis" *and* a colleague tagged
  // "servis" counts once — otherwise agreement between the two would look like
  // twice the evidence.
  const themeRows = await tx.execute<{ value: string; count: number }>(sql`
    select topic as value, count(*)::int as count
    from (
      select r.id, t as topic
      from ${schema.reviews} r
      join ${schema.reviewInsights} i on i.review_id = r.id
      cross join lateral unnest(i.topics) as t
      where r.organization_id = ${organizationId}::uuid and r.location_id = ${locationId}::uuid
      union
      select r.id, tg.slug as topic
      from ${schema.reviews} r
      join ${schema.reviewTags} rt on rt.review_id = r.id
      join ${schema.tags} tg on tg.id = rt.tag_id
      where r.organization_id = ${organizationId}::uuid and r.location_id = ${locationId}::uuid
    ) as tagged
    group by topic
    order by count(*) desc, topic asc
    -- The bar is a filter, not the themes report — that is Home's job.
    limit 12
  `);

  const themes = themeRows.rows.map((row) => ({ value: row.value, count: Number(row.count) }));

  const canonicalRows = await tx.execute<{ value: string; count: number }>(sql`
    select theme as value, count(*)::int as count
    from ${schema.reviews} r
    join ${schema.reviewInsights} i on i.review_id = r.id
    cross join lateral unnest(i.themes) as theme
    where r.organization_id = ${organizationId}::uuid and r.location_id = ${locationId}::uuid
    group by theme
    order by count(*) desc, theme asc
  `);

  const canonicalThemes = canonicalRows.rows.map((row) => ({
    value: row.value,
    count: Number(row.count),
  }));

  /**
   * How much of this location has been analysed under the taxonomy (W3.2).
   *
   * The counts above are only as complete as the column behind them, and
   * `review_insights.themes` was added with **no backfill** — every row
   * analysed by `analyze_review@2` has null, not an empty array. An account
   * part-way through re-analysis therefore produces a Themes row drawn from
   * five reviews sitting beside a Tags row drawn from two hundred and
   * eighty-five, and the honest reading of that is not "almost nobody
   * mentioned staff", it is "almost nothing has been re-analysed".
   *
   * Reported rather than silently applied, because *whether five out of two
   * hundred is worth showing* is a display decision and belongs on the surface
   * that renders it, not in the query that counts.
   */
  const [coverage] = await tx
    .select({
      analysed: sql<number>`count(*)::int`.mapWith(Number),
      withThemes: sql<number>`count(${schema.reviewInsights.themes})::int`.mapWith(Number),
    })
    .from(schema.reviews)
    .innerJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .where(scope);

  const statuses = await tx
    .select({ value: schema.reviews.status, count: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.reviews)
    .where(scope)
    .groupBy(schema.reviews.status);

  // One pass for the scalars. They all read the same rows, and the quick
  // filters they feed are shown together — five round trips to render one row
  // of chips would be four too many.
  //
  // **The `replies` join is gone** (A22-A4). It was here only so `UNANSWERED`
  // had a column to read, and it made `count(*)` count a review with two
  // replies twice — so `total`, `overdue`, `unassigned` and `mine` were all
  // quietly inflated for any business that has ever redrafted. The predicates
  // ask about the review now, so the join is not merely unnecessary, it was
  // wrong.
  const totals = await tx
    .select({
      total: sql<number>`count(*)::int`.mapWith(Number),
      unanswered: sql<number>`count(*) filter (where ${UNANSWERED})::int`.mapWith(Number),
      // Written and not sent — a subset of `unanswered`, never added to it.
      drafted: sql<number>`count(*) filter (where ${DRAFTED})::int`.mapWith(Number),
      // Exactly the predicate the `overdue` filter uses. A chip that promises
      // 129 and shows 124 is worse than no chip at all.
      overdue: sql<number>`count(*) filter (
        where ${schema.reviews.slaDueAt} is not null
          and ${schema.reviews.slaDueAt} < now()
          and ${schema.reviews.status} in ('open', 'in_progress')
          and ${schema.reviews.firstResponseAt} is null
          and ${schema.reviews.ownerRepliedAt} is null
      )::int`.mapWith(Number),
      unassigned:
        sql<number>`count(*) filter (where ${schema.reviews.assigneeUserId} is null)::int`.mapWith(
          Number,
        ),
      mine: sql<number>`count(*) filter (
        where ${schema.reviews.assigneeUserId} = ${options.userId ?? null}::uuid
      )::int`.mapWith(Number),
    })
    .from(schema.reviews)
    .where(scope);

  const sentimentOrder: Sentiment[] = ["negative", "neutral", "positive"];

  return {
    sources,
    // Negative first: the filter an owner reaches for is not the happy one.
    sentiments: sentiments
      .filter((row): row is { value: Sentiment; count: number } => row.value !== null)
      .sort(
        (left, right) => sentimentOrder.indexOf(left.value) - sentimentOrder.indexOf(right.value),
      ),
    themes,
    canonicalThemes,
    themeCoverage: {
      analysed: coverage?.analysed ?? 0,
      withThemes: coverage?.withThemes ?? 0,
    },
    statuses: statuses.sort(
      (left, right) => STATUS_ORDER.indexOf(left.value) - STATUS_ORDER.indexOf(right.value),
    ),
    unanswered: totals[0]?.unanswered ?? 0,
    drafted: totals[0]?.drafted ?? 0,
    overdue: totals[0]?.overdue ?? 0,
    mine: totals[0]?.mine ?? 0,
    unassigned: totals[0]?.unassigned ?? 0,
    total: totals[0]?.total ?? 0,
  };
}
