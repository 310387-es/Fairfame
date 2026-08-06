import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { liveReplyJoin, UNANSWERED } from "../reviews/answered.ts";
import { normalizeThemes } from "../reviews/taxonomy.ts";
import type { Sentiment } from "../db/schema.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import type { RangeWindow } from "./range.ts";

/**
 * The needs-attention queue (Home live dashboard §4, widget 4).
 *
 * Its own query rather than a slice of `dashboard/facts.ts`, because it needs
 * what the facts deliberately leave out: the review text. Loading text for
 * every review in a 90-day window to show four of them would be wasteful, and
 * the four are chosen by a rule the facts cannot express.
 *
 * "Urgency" here means one thing: **someone is waiting and unhappy**. Not
 * volume, not sentiment alone, not recency alone — a two-star review from three
 * weeks ago that nobody answered is still an open wound, and a five-star review
 * from an hour ago is not work.
 */

export type AttentionRow = {
  reviewId: string;
  source: string;
  itemType: "review" | "comment" | "mention" | "dm";
  rating: number | null;
  text: string | null;
  authorName: string | null;
  at: Date;
  sentiment: Sentiment | null;
  url: string | null;
  /**
   * Canonical themes (W3.2), or empty when this review predates the taxonomy
   * or nothing fitted. Carried so the queue can say *what* the complaint is
   * about without the reader opening it — "servis, bekleme süresi" is the
   * difference between a list of angry people and a list of problems.
   */
  themes: string[];
  /**
   * Which branch, for the all-branches view (W4.3). Rendered only where more
   * than one branch is in scope: on a single-branch account it would be the
   * same word on every row.
   */
  locationId: string;
  /** Why it is here, highest first. See `scoreUrgency`. */
  urgency: number;
};

const effectiveAt = sql<Date>`coalesce(${schema.reviews.postedAt}, ${schema.reviews.createdAt})`;

/**
 * How loudly this one is asking to be answered.
 *
 * Deliberately a small integer scale rather than a tuned formula: an owner
 * should be able to look at the order and agree with it, and a weighting nobody
 * can explain is one nobody can trust. Stars dominate because they are public
 * and permanent; sentiment breaks ties for text with no rating, which is every
 * Instagram comment.
 */
export function scoreUrgency(
  row: Pick<AttentionRow, "rating" | "sentiment" | "at">,
  now: Date,
): number {
  let score = 0;

  if (row.rating !== null) {
    // 1★ → 4, 2★ → 3, 3★ → 2. Above three stars is not a complaint.
    if (row.rating <= 3) score += 5 - row.rating;
  } else if (row.sentiment === "negative") {
    // No stars to go on: treat an angry comment like a two-star review.
    score += 3;
  }

  if (row.sentiment === "negative") score += 2;
  if (row.sentiment === "positive") score -= 2;

  // Nothing has escalated it, so recency cannot. Applying the freshness bonus
  // first would let any unanalysed comment from this morning score a point and
  // walk into a queue that is supposed to mean "someone is unhappy".
  if (score <= 0) return 0;

  // A nudge, never a decision: a day of waiting must not outrank a star, or
  // yesterday's mild grumble buries last week's furious one.
  const hours = (now.getTime() - row.at.getTime()) / (60 * 60 * 1_000);
  if (hours <= 24) score += 1;

  return score;
}

/** Ranked worst-first, then newest-first among equals. */
export function rankAttention(rows: AttentionRow[], now: Date, limit: number): AttentionRow[] {
  return (
    [...rows]
      .map((row) => ({ ...row, urgency: scoreUrgency(row, now) }))
      // Nothing neutral-or-better gets in. An empty queue is a true and useful
      // answer; padding it with three-star reviews to fill the card would train
      // people to ignore it.
      .filter((row) => row.urgency > 0)
      .sort((left, right) => right.urgency - left.urgency || right.at.getTime() - left.at.getTime())
      .slice(0, limit)
  );
}

export async function needsAttention(
  tx: TenantDatabase,
  organizationId: string,
  locationIds: string[],
  window: RangeWindow,
  options: { now?: Date; limit?: number } = {},
): Promise<AttentionRow[]> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 4;

  const rows = await tx
    .select({
      reviewId: schema.reviews.id,
      source: schema.reviews.source,
      itemType: schema.reviews.itemType,
      rating: schema.reviews.rating,
      text: schema.reviews.text,
      authorName: schema.reviews.authorName,
      at: effectiveAt,
      sentiment: schema.reviewInsights.sentiment,
      themes: schema.reviewInsights.themes,
      locationId: schema.reviews.locationId,
      url: schema.reviews.url,
    })
    .from(schema.reviews)
    .leftJoin(
      schema.reviewInsights,
      and(
        eq(schema.reviewInsights.reviewId, schema.reviews.id),
        eq(schema.reviewInsights.organizationId, schema.reviews.organizationId),
      ),
    )
    .leftJoin(schema.replies, liveReplyJoin)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        inArray(schema.reviews.locationId, locationIds),
        gte(effectiveAt, window.start),
        lt(effectiveAt, window.end),
        // Unanswered: no live reply at all, and none the owner left on the
        // platform (W1.2). A draft counts as answered here on purpose —
        // someone is already on it, and surfacing it again would send two
        // people to the same review.
        UNANSWERED,
        // Cheap pre-filter so the text of every happy review stays on the
        // database side. The real ranking happens in `rankAttention`, and an
        // item with neither a low rating nor negative sentiment can never
        // score above zero there.
        or(eq(schema.reviewInsights.sentiment, "negative"), lt(schema.reviews.rating, 4)),
      ),
    )
    .orderBy(desc(effectiveAt))
    // Enough to rank meaningfully without reading a whole quarter of text.
    .limit(50);

  return rankAttention(
    rows.map((row) => ({
      ...row,
      at: new Date(row.at),
      // Through the same normaliser every other reader uses, so a value the
      // model invented cannot reach a chip here while being dropped elsewhere.
      themes: normalizeThemes(row.themes),
      urgency: 0,
    })),
    now,
    limit,
  );
}
