import { and, eq, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import type { CanonicalReview } from "./types.ts";

/**
 * Writing canonical reviews.
 *
 * Dedup is on (organization_id, source, source_review_id) — the unique key from
 * migration 0000. Re-ingesting the same review updates it in place rather than
 * duplicating, which is what makes a re-sync safe and a scheduled sync
 * idempotent.
 *
 * `organizationId` is supplied by the caller from the tenant context, never by
 * the connector. Combined with RLS, a connector cannot write into another
 * tenant even if it tried: the WITH CHECK policy would reject the row.
 */

export type UpsertOutcome = {
  received: number;
  inserted: number;
  updated: number;
};

/** Reviews whose content changed keep their id; only the payload moves. */
export async function upsertReviews(
  tx: TenantDatabase,
  organizationId: string,
  reviews: CanonicalReview[],
): Promise<UpsertOutcome> {
  if (reviews.length === 0) {
    return { received: 0, inserted: 0, updated: 0 };
  }

  // Within one batch a provider can legitimately repeat an id (a page overlap).
  // Postgres refuses to update the same row twice in a single INSERT, so
  // collapse duplicates first, keeping the last occurrence.
  const deduped = new Map<string, CanonicalReview>();
  for (const review of reviews) {
    deduped.set(`${review.source}::${review.sourceReviewId}`, review);
  }
  const batch = [...deduped.values()];

  const rows = await tx
    .insert(schema.reviews)
    .values(
      batch.map((review) => ({
        organizationId,
        locationId: review.locationId,
        source: review.source,
        itemType: review.itemType ?? "review",
        sourceReviewId: review.sourceReviewId,
        authorName: review.authorName,
        rating: review.rating,
        text: review.text,
        language: review.language,
        postedAt: review.postedAt,
        url: review.url,
        rawPayload: review.rawPayload,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.reviews.organizationId, schema.reviews.source, schema.reviews.sourceReviewId],
      set: {
        // `item_type` is deliberately absent: a row's kind is fixed at
        // ingestion and a source that changed it mid-life would be a bug, not
        // an update worth applying.
        authorName: sql`excluded.author_name`,
        rating: sql`excluded.rating`,
        text: sql`excluded.text`,
        language: sql`excluded.language`,
        postedAt: sql`excluded.posted_at`,
        url: sql`excluded.url`,
        rawPayload: sql`excluded.raw_payload`,
        updatedAt: new Date(),
      },
    })
    // `xmax = 0` is true only for a freshly inserted tuple, so this
    // distinguishes inserts from updates in a single round trip.
    .returning({ id: schema.reviews.id, inserted: sql<boolean>`(xmax = 0)` });

  const inserted = rows.filter((row) => row.inserted).length;

  return {
    received: batch.length,
    inserted,
    updated: rows.length - inserted,
  };
}

/** Reviews for one location, newest first — the Inbox query. */
export async function listReviewsForLocation(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  limit = 50,
) {
  return tx
    .select()
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.locationId, locationId),
      ),
    )
    .orderBy(sql`${schema.reviews.postedAt} desc nulls last`)
    .limit(limit);
}
