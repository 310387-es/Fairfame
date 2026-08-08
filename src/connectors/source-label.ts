/**
 * What a source is called on screen.
 *
 * **Why this is its own module.** The label already existed — every descriptor
 * in `PROVIDERS` carries one, and `/connections` renders "Google Business
 * Profile" and "First-party page" from it. But `providers.ts` imports `getEnv`
 * and the token vault, so a `"use client"` file cannot reach it, and six places
 * therefore invented the same fallback instead:
 *
 *     source.charAt(0).toUpperCase() + source.slice(1)
 *
 * Which renders the enum. `/analytics` compared "Google" against **"Firstparty"**
 * in its source table; so did the widget builder, the approval list, the
 * scheduled PDF, the public widget markup, and the hosted review page — the last
 * two on the open internet, under the business's own name.
 *
 * So the labels live here, with no imports at all, and `providers.ts` reads
 * *from* this module rather than beside it. One definition, reachable from a
 * client component, a PDF worker and a stranger's website alike.
 *
 * **The fallback is kept and is still the capitalisation**, deliberately. A
 * review's `source` is a free string column holding whatever a connector wrote,
 * including sources no longer in `PROVIDERS`, and an account with years of
 * history must not start rendering blanks because a descriptor was retired.
 */

/**
 * Display names, keyed by the value stored in `reviews.source`.
 *
 * Not translated, and that is the rule rather than an omission: these are the
 * names of other companies' products. "Google Business Profile" is called that
 * in Turkish too, and a translated platform name is a support ticket asking
 * which service the business is actually connected to.
 */
export const SOURCE_LABELS: Record<string, string> = {
  google: "Google Business Profile",
  instagram: "Instagram",
  whatsapp: "WhatsApp Business",
  firstparty: "First-party page",
  mock: "Mock source",
  fixture: "Fixture provider",
};

/** The name to show for a stored `source` value. Never returns empty. */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}
