import { and, eq, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { schema } from "../db/client.ts";

/**
 * What "answered" means. One definition, and this is it (W1.2).
 *
 * **The bug this closes.** A review can be answered two ways: we post a reply
 * through the product, or the business answers on the platform itself — in
 * Google Business Profile, say, which most owners were already doing before
 * they had us. Until now the product had *four* different opinions about which
 * of those counted:
 *
 *   - the reply filter and the `unanswered` chip asked whether a `replies` row
 *     existed;
 *   - the overdue filter and chip asked whether `first_response_at` was set;
 *   - `slaState` and `computePriority` each asked one of those two;
 *   - and the Inbox card sniffed `raw_payload` for an `ownerReply` key.
 *
 * Only the last one knew about platform replies, and it fed a badge and nothing
 * else. So a review the owner had already answered on Google displayed
 * "answered on Google" *and* counted as unanswered, *and* accrued an overdue
 * badge, *and* sorted to the top of the triage queue as if nobody had touched
 * it. That is where the audit's fake overdue count came from.
 *
 * **The `raw_payload` sniff was also wrong on its own terms.** Google does not
 * write `ownerReply`; it writes `reviewReply` (`google/schemas.ts`). The check
 * only ever matched the mock connector's payload shape, so it would have gone
 * on being wrong the day real Google traffic arrived — silently, because a
 * missing badge looks like a review nobody answered.
 *
 * **The fix is to normalise at ingest, not to sniff at read time.** Each
 * connector knows its own payload and writes `reviews.owner_replied_at`; every
 * reader here asks one question of one column.
 *
 * **Why no `answered_at` column.** The obvious move — one maintained column
 * that is true when either kind of answer exists — would be a second source of
 * truth for something `replies` already records, kept in step by a refresh
 * function that every future reply path has to remember to call. That is the
 * `broadcasts.converted` argument from P4-T4, and it goes the same way here:
 * the answer is derived at read time from the two facts that own themselves.
 */

/**
 * The join every "is it answered" question needs.
 *
 * A **failed** reply leaves the review unanswered — an attempt Google rejected
 * did not reach the customer — so it must not satisfy the predicate. This was
 * already written four times with three slightly different ON clauses; it is
 * written once now, because the predicates below only mean what they say when
 * the join underneath them is this one.
 */
export const liveReplyJoin = and(
  eq(schema.replies.reviewId, schema.reviews.id),
  eq(schema.replies.organizationId, schema.reviews.organizationId),
  ne(schema.replies.status, "failed"),
);

/**
 * Whether a reply actually reached the customer (A22-A4).
 *
 * **A draft is not an answer.** These predicates asked whether a `replies` row
 * existed, which meant saving a draft marked the review answered: the tester
 * pressed "draft with AI", the queue went 47 → 46, and a customer nobody had
 * written to disappeared from every list that means "outstanding work". A draft
 * that is never approved is the worst case — the review is gone from the queue
 * and the customer is still waiting.
 *
 * **A subquery rather than a condition on the join**, for a reason that only
 * shows up with the new rule. A review can carry a draft *and* a posted reply;
 * under `liveReplyJoin` that is two joined rows, and `replies.posted_at IS
 * NULL` would be true of one of them — so an answered review would appear in
 * the unanswered list through its draft. The old `replies.id IS NULL` was
 * immune to that by accident, not by design. Asking about the *review* is what
 * makes the answer independent of how many times it joined.
 *
 * The outer table is written literally rather than interpolated: a column
 * interpolated into a `sql` fragment renders **unqualified in a SELECT
 * projection** (the P4-T1 lesson), and `UNANSWERED` is used inside a `count(*)
 * filter (where …)` — where an unqualified `id` would bind to the subquery's
 * own table and silently compare a row to itself.
 */
const POSTED_REPLY = sql`exists (
  select 1 from ${schema.replies} as posted_reply
  where posted_reply.review_id = "reviews"."id"
    and posted_reply.organization_id = "reviews"."organization_id"
    and posted_reply.posted_at is not null
)`;

const NO_POSTED_REPLY = sql`not exists (
  select 1 from ${schema.replies} as posted_reply
  where posted_reply.review_id = "reviews"."id"
    and posted_reply.organization_id = "reviews"."organization_id"
    and posted_reply.posted_at is not null
)`;

/**
 * Answered — by us or by the business, on the platform.
 *
 * No longer needs `liveReplyJoin` in the query, though every existing caller
 * still joins for other reasons (the draft's text on the row, the reply's
 * status in the composer).
 */
export const ANSWERED: SQL = or(POSTED_REPLY, isNotNull(schema.reviews.ownerRepliedAt))!;

/** Its exact complement, so the two chips cannot add up to more than the total. */
export const UNANSWERED: SQL = and(NO_POSTED_REPLY, isNull(schema.reviews.ownerRepliedAt))!;

/**
 * Somebody has written something and it has not gone out (A22-A4).
 *
 * A **subset of `UNANSWERED`**, not a third state beside it: the customer is
 * still waiting either way, and the count of outstanding work must not fall
 * because a colleague started. What this earns is a way to *see* that someone
 * is on it — the queue keeps the row, the row says "Taslak", and two people are
 * not sent to the same review by a queue that told neither of them.
 *
 * `failed` is excluded: an attempt the platform rejected is not a draft waiting
 * for approval, it is an error somebody has to look at, and the composer
 * already says so.
 */
export const DRAFTED: SQL = and(
  sql`exists (
    select 1 from ${schema.replies} as pending_reply
    where pending_reply.review_id = "reviews"."id"
      and pending_reply.organization_id = "reviews"."organization_id"
      and pending_reply.posted_at is null
      and pending_reply.status <> 'failed'
  )`,
  isNull(schema.reviews.ownerRepliedAt),
)!;

/**
 * The same question, asked of a fact rather than of a row (A22-A3).
 *
 * **Why this exists.** The SQL above is the definition for anything reading the
 * `reviews` table directly — the Inbox queues, the facet counts, the branch
 * table. Everything on Home and Insights reads a *projection* instead
 * (`ReviewFact`), whose `repliedAt` is `least(min(replies.posted_at),
 * owner_replied_at)` — the same rule, already applied in the loader. So four
 * screens were each writing `fact.repliedAt === null` inline, and one of them
 * quietly wrote `fact.repliedAt === null && isUnhappy(fact)` and called the
 * result "waiting for a reply". The cafe-owner test found four counts of
 * "waiting" on one product and no way to tell which was the real one.
 *
 * A named function is not much code. What it is, is a place where narrowing the
 * set has to be written down: `needsReply(f) && isNegative(f)` says what it is
 * in a way `f.repliedAt === null && isUnhappy(f)` does not, and the screen that
 * shows it then has to say so too.
 *
 * `tests/db/answered.test.ts` pins this against the SQL above, which is the
 * only way two implementations of one rule stay one rule.
 */
export type ReplyStateFact = { repliedAt: Date | null };

export function needsReply(fact: ReplyStateFact): boolean {
  return fact.repliedAt === null;
}

/**
 * Negative — the narrowing the Home strip applies, named rather than inlined.
 *
 * Sentiment alone, deliberately, and **not** "or rated two stars or fewer".
 * That wider rule was what the strip used, and it cannot be expressed as a
 * queue: `src/reviews/filters.ts` combines `sentiment` and `rating` with AND,
 * so the "Reply now" button next to the number led to a strictly smaller list
 * than the number promised. A figure a reader cannot click through to is a
 * figure they have to take on trust, which is the thing this whole wave is
 * about. An unanalysed one-star review is caught by the attention queue further
 * down the same screen, which ranks on `computePriority` and does read ratings.
 */
export function isNegative(fact: { sentiment: string | null }): boolean {
  return fact.sentiment === "negative";
}

/**
 * When this review was answered, as far as anyone can tell — or null.
 *
 * `first_response_at` is what the *team* did through the product and stays the
 * numerator of every response-time figure; it is preferred when both exist
 * because it is the one we measured rather than the one we were told. The
 * platform's timestamp is the fallback, and it is a real timestamp rather than
 * a flag precisely so an SLA can still be judged met or missed on a review
 * somebody answered in Google.
 */
export function answeredAt(review: {
  firstResponseAt: Date | null;
  ownerRepliedAt: Date | null;
}): Date | null {
  return review.firstResponseAt ?? review.ownerRepliedAt;
}
