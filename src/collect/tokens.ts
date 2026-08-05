import { looksLikeCode, randomCode } from "../lib/codes.ts";

/**
 * Codes that end up in public collection URLs.
 *
 * Two different jobs, so two different lengths over the shared generator in
 * `src/lib/codes.ts`:
 *
 * - A campaign **slug** is printed on a poster and read aloud ("revira.app
 *   slash c slash kadikoy-h7m2qp"). It is public by design and guards nothing,
 *   so it is short and human-friendly.
 * - A request **token** identifies one person's ask. Anyone holding it can mark
 *   that request opened and attach a submission to it, so it is a secret:
 *   generated with a CSPRNG, long enough that guessing is hopeless.
 */

/** Turkish letters have no ASCII equivalent in `normalize()`; map them by hand. */
const TURKISH_MAP: Record<string, string> = {
  ı: "i",
  İ: "i",
  ş: "s",
  Ş: "s",
  ğ: "g",
  Ğ: "g",
  ü: "u",
  Ü: "u",
  ö: "o",
  Ö: "o",
  ç: "c",
  Ç: "c",
};

/** "Kadıköy Şubesi" → "kadikoy-subesi". Empty when nothing survives. */
export function slugifyName(value: string, maxLength = 24): string {
  return value
    .replace(/[ıİşŞğĞüÜöÖçÇ]/g, (char) => TURKISH_MAP[char] ?? char)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/** 6 random characters ≈ 30 bits — ample for a namespace of campaigns. */
const SLUG_SUFFIX_LENGTH = 6;

/**
 * A readable, globally unique-ish campaign slug: the campaign's name plus a
 * random suffix. Uniqueness is still the database's call (`campaigns.slug` is
 * unique); the caller retries on collision.
 */
export function generateCampaignSlug(name: string): string {
  const prefix = slugifyName(name);
  const suffix = randomCode(SLUG_SUFFIX_LENGTH);
  return prefix ? `${prefix}-${suffix}` : suffix;
}

/** ~110 bits. Not guessable, and short enough to survive an email client. */
export const REQUEST_TOKEN_LENGTH = 22;

export function generateRequestToken(): string {
  return randomCode(REQUEST_TOKEN_LENGTH);
}

/** Cheap shape check before a database round trip on a public route. */
export function looksLikeToken(value: string): boolean {
  return looksLikeCode(value, REQUEST_TOKEN_LENGTH);
}

export function looksLikeSlug(value: string): boolean {
  return /^[a-z0-9-]{1,64}$/.test(value);
}
