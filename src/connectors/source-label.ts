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

/**
 * The short form, for where a source is *repeated* rather than named.
 *
 * Unifying the labels was right and it made two surfaces measurably worse:
 * "Google" became "Google Business Profile" on every review card in a published
 * widget and under every review on a hosted page — twenty-three characters of
 * somebody else's brand, once per review, taking the room from the customer's
 * words that are the entire point of both surfaces. A single-source business
 * gets the same phrase on every row.
 *
 * The rule is the same one W4.1 settled for the review queue and this file's
 * first version got wrong by having only one answer:
 *
 * - **Named once** — an analytics row, a filter, a report's per-source table,
 *   a connections card — take the full name. It is being identified, and the
 *   official name is what a business matches against their own account.
 * - **Repeated per item** — a widget card, a hosted page's review, an approval
 *   row — take this, or better, `ProviderMark` where an SVG can be drawn.
 *
 * Entries only where the full name is actually longer; everything else falls
 * through, so there is no second list to keep in step.
 */
const SOURCE_SHORT_LABELS: Record<string, string> = {
  google: "Google",
  whatsapp: "WhatsApp",
  firstparty: "Our site",
};

export function sourceShortLabel(source: string): string {
  return SOURCE_SHORT_LABELS[source] ?? sourceLabel(source);
}
