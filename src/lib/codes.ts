import { randomBytes } from "node:crypto";

/**
 * The primitive behind every code that ends up in a public URL.
 *
 * Lives in `lib/` rather than beside its first caller because it now has three
 * unrelated ones — campaign slugs and request tokens in `src/collect`, widget
 * keys in `src/widgets` — and a widget is not a collection concern. One
 * generator, one alphabet, one place to review the sampling.
 *
 * The alphabet omits i, l, o, 0 and 1: transcription errors from a printed page
 * are a real failure mode for a QR fallback link.
 */

export const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** 2^5 = 32 > 31, so a 5-bit sample sometimes lands out of range and is redrawn. */
const BITS_MASK = 0b11111;

/**
 * Uniform random string over `CODE_ALPHABET`.
 *
 * Rejection sampling rather than `byte % 31`: the modulo would make the first
 * two letters of the alphabet measurably likelier, which is exactly the kind of
 * quiet bias that erodes a token's entropy.
 */
export function randomCode(length: number): string {
  if (length <= 0) throw new Error("randomCode length must be positive.");

  let out = "";
  while (out.length < length) {
    // Over-draw: on average ~3% of samples are rejected, so one round is
    // almost always enough.
    for (const byte of randomBytes((length - out.length) * 2)) {
      const index = byte & BITS_MASK;
      if (index < CODE_ALPHABET.length) {
        out += CODE_ALPHABET[index];
        if (out.length === length) break;
      }
    }
  }

  return out;
}

/** Cheap shape check before a database round trip on a public route. */
export function looksLikeCode(value: string, length: number): boolean {
  return new RegExp(`^[${CODE_ALPHABET}]{${length}}$`).test(value);
}
