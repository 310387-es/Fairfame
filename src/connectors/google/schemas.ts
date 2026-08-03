import { z } from "zod";

/**
 * Google Business Profile response shapes, as documented.
 *
 * Three APIs are involved, which is a quirk of Google's own migration rather
 * than a choice of ours:
 *
 *   - Account Management API (v1) — which accounts the user administers.
 *   - Business Information API (v1) — the locations under an account.
 *   - **My Business v4** — reviews and replies. These were never migrated to a
 *     v1 surface, so `mybusiness.googleapis.com/v4` remains the documented
 *     endpoint for them. Anyone reading this expecting one tidy v1 API is not
 *     wrong to be surprised.
 *
 * Every schema is `.loose()` on purpose: Google adds fields without notice, and
 * a strict parse would turn a harmless new key into a sync outage. We validate
 * what we consume and carry the rest through untouched into `raw_payload`.
 */

/** STAR_RATING_UNSPECIFIED exists and means "no rating", not "zero stars". */
export const starRatingSchema = z.enum([
  "STAR_RATING_UNSPECIFIED",
  "ONE",
  "TWO",
  "THREE",
  "FOUR",
  "FIVE",
]);

export type StarRating = z.infer<typeof starRatingSchema>;

const STAR_VALUES: Record<StarRating, number | null> = {
  STAR_RATING_UNSPECIFIED: null,
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export function starsToNumber(rating: StarRating): number | null {
  return STAR_VALUES[rating];
}

/** The reverse direction, for a reply body or a test fixture. */
export function numberToStars(value: number): StarRating {
  return (["ONE", "TWO", "THREE", "FOUR", "FIVE"][value - 1] ??
    "STAR_RATING_UNSPECIFIED") as StarRating;
}

export const googleReviewerSchema = z
  .object({
    displayName: z.string().optional(),
    profilePhotoUrl: z.string().optional(),
    /** An anonymous reviewer has no display name at all. */
    isAnonymous: z.boolean().optional(),
  })
  .loose();

export const googleReviewSchema = z
  .object({
    /** "accounts/{account}/locations/{location}/reviews/{review}". */
    name: z.string().optional(),
    reviewId: z.string().min(1),
    reviewer: googleReviewerSchema.optional(),
    starRating: starRatingSchema,
    /** Absent for a star-only review, which is common. */
    comment: z.string().optional(),
    createTime: z.string(),
    updateTime: z.string(),
    reviewReply: z
      .object({ comment: z.string(), updateTime: z.string().optional() })
      .loose()
      .optional(),
  })
  .loose();

export type GoogleReview = z.infer<typeof googleReviewSchema>;

export const googleReviewsPageSchema = z
  .object({
    // Absent rather than empty when a location has no reviews.
    reviews: z.array(googleReviewSchema).optional(),
    averageRating: z.number().optional(),
    totalReviewCount: z.number().int().optional(),
    nextPageToken: z.string().optional(),
  })
  .loose();

export const googleReplySchema = z
  .object({ comment: z.string(), updateTime: z.string().optional() })
  .loose();

export const googleAccountSchema = z
  .object({
    /** "accounts/{accountId}". */
    name: z.string().min(1),
    accountName: z.string().optional(),
    type: z.string().optional(),
    verificationState: z.string().optional(),
  })
  .loose();

export const googleAccountsPageSchema = z
  .object({
    accounts: z.array(googleAccountSchema).optional(),
    nextPageToken: z.string().optional(),
  })
  .loose();

export const googleAddressSchema = z
  .object({
    regionCode: z.string().optional(),
    postalCode: z.string().optional(),
    administrativeArea: z.string().optional(),
    locality: z.string().optional(),
    addressLines: z.array(z.string()).optional(),
  })
  .loose();

export const googleLocationSchema = z
  .object({
    /** "locations/{locationId}" — note: no account prefix on this API. */
    name: z.string().min(1),
    title: z.string().optional(),
    storefrontAddress: googleAddressSchema.optional(),
    metadata: z.object({ mapsUri: z.string().optional() }).loose().optional(),
  })
  .loose();

export const googleLocationsPageSchema = z
  .object({
    locations: z.array(googleLocationSchema).optional(),
    nextPageToken: z.string().optional(),
    totalSize: z.number().int().optional(),
  })
  .loose();

/** Google's standard error envelope, shared by all three APIs. */
export const googleErrorSchema = z
  .object({
    error: z
      .object({
        code: z.number().int(),
        message: z.string(),
        status: z.string().optional(),
      })
      .loose(),
  })
  .loose();

/** Flattens an address into one line for the mapping picker. */
export function formatAddress(address: z.infer<typeof googleAddressSchema> | undefined): string {
  if (!address) return "";

  return [...(address.addressLines ?? []), address.locality, address.administrativeArea]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(", ");
}

/** "accounts/123" → "123". Google returns resource names, we store bare ids. */
export function idFromResourceName(resourceName: string): string {
  return resourceName.split("/").pop() ?? resourceName;
}
