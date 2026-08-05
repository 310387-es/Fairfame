import { and, eq, isNotNull, isNull, ne, or, type SQL } from "drizzle-orm";
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
 * Answered — by us or by the business, on the platform.
 *
 * Requires `liveReplyJoin` in the query. Reading it without that join asks
 * about a column that is not in the FROM list, which is an error rather than a
 * wrong answer, and that is the intended failure mode.
 */
export const ANSWERED: SQL = or(
  isNotNull(schema.replies.id),
  isNotNull(schema.reviews.ownerRepliedAt),
)!;

/** Its exact complement, so the two chips cannot add up to more than the total. */
export const UNANSWERED: SQL = and(
  isNull(schema.replies.id),
  isNull(schema.reviews.ownerRepliedAt),
)!;

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
