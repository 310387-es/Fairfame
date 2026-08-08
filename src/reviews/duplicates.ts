import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";

/**
 * The same review, arriving twice (W5-7).
 *
 * > **Cross-source duplicate detection** (pgvector cosine + author/date window).
 *
 * A customer who has a bad afternoon frequently says so in two places: on
 * Google, and on the form the business linked from its own site. Both arrive,
 * both get analysed, both appear in the queue — so somebody answers the same
 * complaint twice, and every theme that customer named is counted twice in a
 * briefing that is supposed to say what a week was about.
 *
 * ## What this does, and the thing it deliberately does not do
 *
 * It **links** a duplicate to the one that arrived first, and stops. It does
 * not delete anything, and — the important one — **it changes no aggregate**.
 * The average rating, the review count, the sentiment split and the digest all
 * read exactly what they read before.
 *
 * That is a decision and not an omission. A business that has genuinely been
 * reviewed on Google *and* on its own page has two reviews, both real on the
 * platform they live on, and both counted by anybody looking at either. Quietly
 * dropping one from our average would make our number disagree with the one on
 * their Google listing — and the number a business is judged by is the one on
 * the listing. What an owner actually needs is to not answer the same person
 * twice, and that is a badge and a filter.
 *
 * Whether the *themes* should be de-duplicated inside a briefing is a real
 * question and a separate one; the link this writes is what a later change
 * would read, and doing it in the same commit would bury the aggregate change
 * inside the detection change.
 *
 * ## Three signals, and all three must agree
 *
 * Cosine distance alone is not enough, and the failure is not subtle: two
 * different customers complaining about parking on the same Tuesday produce
 * near-identical vectors. "Otopark yok, 15 dakika tur attık" and "Park yeri
 * bulamadım, çok dar" are the same *complaint*, not the same *review*, and
 * merging them would delete a customer.
 *
 * So a duplicate needs all of:
 *
 *   1. **A different source.** Two reviews on the same platform from the same
 *      person are two reviews; the platform allowed both and we are not going
 *      to argue with it.
 *   2. **A close date.** `DUPLICATE_WINDOW_DAYS` either side. Somebody who
 *      complains in March and again in July has complained twice.
 *   3. **Either the same author name, or text near enough to be the same
 *      words.** A name matches loosely (case, spacing, accents) because
 *      platforms disagree about how to print one; the text threshold is tight
 *      because it is the only signal that can stand on its own.
 */

const log = childLogger({ module: "reviews/duplicates" });

/**
 * How far apart two postings may be and still be one review.
 *
 * Three days. Long enough for a platform that timestamps by moderation rather
 * than by submission — Google's delay is routinely a day — and short enough
 * that a regular's second complaint about the same thing is its own review.
 */
export const DUPLICATE_WINDOW_DAYS = 3;

/**
 * Cosine distance below which two texts are the same words.
 *
 * 0.06 is *tight*. `clusterThemes` uses a much looser threshold and is right
 * to: it is grouping complaints that are *about* the same thing. This is
 * deciding that a customer wrote once, and the cost of being wrong is a real
 * review hidden behind another person's.
 */
export const DUPLICATE_DISTANCE = 0.06;

/** Distance allowed when the author's name also matches. */
export const DUPLICATE_DISTANCE_WITH_AUTHOR = 0.25;

/**
 * A name, reduced to what two platforms would agree on.
 *
 * Turkish-aware lower-casing, because `İ.toLowerCase()` is locale-dependent and
 * the naive recipe turns `İrem` into `i̇rem` — the same trap `src/seo/slug.ts`
 * documents. Diacritics are folded because one platform prints "Ayşe" and
 * another "Ayse", and initials are kept: "A. Yılmaz" and "Ayşe Yılmaz" are not
 * asserted to be the same person by this function alone, but with a matching
 * surname and a three-day window they are close enough for the text threshold
 * to decide.
 */
export function normalizeAuthor(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim();
  if (trimmed.length === 0) return null;

  const folded = trimmed
    .toLocaleLowerCase("tr")
    .replaceAll("ı", "i")
    .replaceAll("ş", "s")
    .replaceAll("ğ", "g")
    .replaceAll("ç", "c")
    .replaceAll("ö", "o")
    .replaceAll("ü", "u")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return folded.length > 0 ? folded : null;
}

export type DuplicateCandidate = {
  reviewId: string;
  source: string;
  authorName: string | null;
  postedAt: Date | null;
  distance: number;
};

export type DuplicateSubject = {
  reviewId: string;
  source: string;
  authorName: string | null;
  postedAt: Date | null;
};

/**
 * The verdict, given the three signals. Pure, so it can be argued with in a
 * test rather than in a query plan.
 */
export function isDuplicate(subject: DuplicateSubject, candidate: DuplicateCandidate): boolean {
  // 1. A different source. Two on one platform are two reviews.
  if (candidate.source === subject.source) return false;

  // 2. A close date. Absence is not closeness: a review with no timestamp
  //    cannot be placed, and guessing would merge the unplaceable ones.
  if (!subject.postedAt || !candidate.postedAt) return false;
  const apart = Math.abs(subject.postedAt.getTime() - candidate.postedAt.getTime());
  if (apart > DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1_000) return false;

  // 3. The words, and the name if we have one on both sides.
  const sameAuthor =
    normalizeAuthor(subject.authorName) !== null &&
    normalizeAuthor(subject.authorName) === normalizeAuthor(candidate.authorName);

  return candidate.distance <= (sameAuthor ? DUPLICATE_DISTANCE_WITH_AUTHOR : DUPLICATE_DISTANCE);
}

/** How many reviews one pass considers. Bounded like every sweep here. */
export const DUPLICATE_BATCH = 200;

export type DuplicateScanResult = { examined: number; linked: number };

/**
 * Links duplicates for one organization.
 *
 * Runs after the analysis batch, because that is when an embedding exists — a
 * review with no vector cannot be compared, and scanning before the pass that
 * produces one would be a scan that always finds nothing.
 *
 * **The older review is always the original.** Not the one from the "better"
 * source, and not the one with more text: arrival order is the only rule that
 * two runs of this cannot disagree about, and a rule that ranked sources would
 * flip a link the day somebody connected a new one.
 */
export async function scanForDuplicates(
  organizationId: string,
  options: { limit?: number } = {},
): Promise<DuplicateScanResult> {
  const limit = options.limit ?? DUPLICATE_BATCH;

  return withTenant({ organizationId }, async (tx) => {
    const subjects = await tx
      .select({
        reviewId: schema.reviews.id,
        locationId: schema.reviews.locationId,
        source: schema.reviews.source,
        authorName: schema.reviews.authorName,
        postedAt: schema.reviews.postedAt,
        embedding: schema.reviewInsights.embedding,
      })
      .from(schema.reviews)
      .innerJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
      .where(
        and(
          eq(schema.reviews.organizationId, organizationId),
          // Already linked: a duplicate does not need a duplicate of its own.
          isNull(schema.reviews.duplicateOfId),
          sql`${schema.reviewInsights.embedding} is not null`,
        ),
      )
      // Newest first: a fresh arrival is what somebody is about to answer.
      .orderBy(sql`${schema.reviews.postedAt} desc nulls last`)
      .limit(limit);

    let linked = 0;

    for (const subject of subjects) {
      if (!subject.embedding) continue;

      const match = await nearestOtherSource(tx, organizationId, {
        ...subject,
        embedding: subject.embedding,
      });
      if (!match) continue;

      // Arrival order decides which is the original — see the comment above.
      const older =
        (subject.postedAt?.getTime() ?? 0) <= (match.postedAt?.getTime() ?? 0)
          ? subject.reviewId
          : match.reviewId;
      const newer = older === subject.reviewId ? match.reviewId : subject.reviewId;

      const updated = await tx
        .update(schema.reviews)
        .set({ duplicateOfId: older, updatedAt: new Date() })
        .where(
          and(
            eq(schema.reviews.id, newer),
            // Only if it is still unlinked: two passes racing must produce one
            // link, and the second must not overwrite the first.
            isNull(schema.reviews.duplicateOfId),
          ),
        )
        .returning({ id: schema.reviews.id });

      if (updated.length > 0) linked += 1;
    }

    if (linked > 0) log.info({ organizationId, linked }, "Linked cross-source duplicates");
    return { examined: subjects.length, linked };
  });
}

/** The nearest review from a *different* source, inside the date window. */
async function nearestOtherSource(
  tx: TenantDatabase,
  organizationId: string,
  subject: {
    reviewId: string;
    locationId: string;
    source: string;
    authorName: string | null;
    postedAt: Date | null;
    embedding: number[];
  },
): Promise<DuplicateCandidate | null> {
  if (!subject.postedAt) return null;

  const vectorParam = sql`${JSON.stringify(subject.embedding)}::vector`;
  const windowMs = DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1_000;

  const rows = await tx
    .select({
      reviewId: schema.reviews.id,
      source: schema.reviews.source,
      authorName: schema.reviews.authorName,
      postedAt: schema.reviews.postedAt,
      distance: sql<number>`${schema.reviewInsights.embedding} <=> ${vectorParam}`.mapWith(Number),
    })
    .from(schema.reviews)
    .innerJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        // Same branch. A chain's Kadıköy and Beşiktaş reviews are different
        // customers however alike the words are.
        eq(schema.reviews.locationId, subject.locationId),
        sql`${schema.reviews.id} <> ${subject.reviewId}`,
        sql`${schema.reviews.source} <> ${subject.source}`,
        sql`${schema.reviewInsights.embedding} is not null`,
        sql`${schema.reviews.postedAt} between ${new Date(subject.postedAt.getTime() - windowMs)} and ${new Date(subject.postedAt.getTime() + windowMs)}`,
      ),
    )
    .orderBy(sql`${schema.reviewInsights.embedding} <=> ${vectorParam}`)
    .limit(1);

  const nearest = rows[0];
  if (!nearest) return null;

  return isDuplicate(subject, nearest) ? nearest : null;
}
