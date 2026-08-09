/**
 * What a form can say went wrong with a field — as keys, not sentences.
 *
 * **Why this is its own module with no imports at all.** The keys are minted on
 * the server, inside Zod schemas, and rendered on the client, inside
 * `useAction`. The natural home would be `src/server/action-result.ts` beside
 * `toFieldErrors`, and that file reaches `@/auth/session` and therefore `pg` and
 * therefore Node's `dns` — so a `"use client"` module importing a *runtime*
 * value from it fails the build. Types are erased and were always safe; a
 * constant is not. This is the same rule that put `search/types.ts` and
 * `notifications/types.ts` where they are.
 *
 * A leaf module is also the honest shape: a key is a word both ends agree on,
 * and it should not depend on either of them.
 */

/**
 * Marks a schema message as *our* key rather than Zod's prose.
 *
 * Zod's defaults are English sentences and so were the handful written by hand,
 * which left no way to tell them apart at the point where they have to be
 * translated. A sentinel character settles it: Zod cannot produce one, so a
 * message carrying it is a key by construction.
 */
export const KEY_PREFIX = "@";

/**
 * The code that lets the client translate the summary above the fields.
 *
 * **Only where there are fields.** Most `invalidInput` call sites pass a bespoke
 * summary — "Unknown widget.", "Invalid connection." — and those are reached by
 * a malformed request rather than by a person filling in a form: an id that does
 * not resolve, a payload nobody typed. They stay in English deliberately,
 * because translating forty defensive strings a reader cannot reach costs a key
 * each and tells nobody anything. The summary that *is* reachable is the one
 * that arrives with named fields, and `useAction` replaces exactly that one.
 */
export const INVALID_INPUT = "invalid_input";

/**
 * Every message a field can carry.
 *
 * The union is the point: `useAction` renders `validation.<key>`, and
 * `tests/lib/validation-messages.test.ts` asserts each one exists in **both**
 * locales — so a key added here without its Turkish fails the suite rather than
 * showing a café owner a raw identifier.
 */
export type ValidationKey =
  | "required"
  | "invalid"
  | "tooShort"
  | "tooLong"
  | "tooSmall"
  | "tooLarge"
  | "email"
  | "url"
  | "hexColour"
  | "hostname";

export const VALIDATION_KEYS: readonly ValidationKey[] = [
  "required",
  "invalid",
  "tooShort",
  "tooLong",
  "tooSmall",
  "tooLarge",
  "email",
  "url",
  "hexColour",
  "hostname",
];

/**
 * Names a validation message from inside a schema: `.min(1, msg("required"))`.
 *
 * The alternative was writing both sentences into the schema and picking one,
 * which puts locale resolution in a module that runs long before anyone knows
 * who is reading. This hands a key to the client, which is the only place that
 * does know.
 */
export function msg(key: ValidationKey): string {
  return `${KEY_PREFIX}${key}`;
}
