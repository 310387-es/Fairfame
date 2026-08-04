/**
 * Template variables, and how one is filled in (P2-T5).
 *
 * Deliberately its own module, free of any database import. The settings screen
 * renders the list of available placeholders in a `"use client"` component, and
 * a client file that imports a module reaching `db/client` pulls in `pg`, which
 * needs Node's `dns`, and the build fails on the missing built-in. Constants are
 * not erased the way types are — so they live here, and `./templates.ts` imports
 * them rather than the other way round.
 */

/**
 * The variables a template may use.
 *
 * A closed set, not an expression language. Everything here is a fact the
 * product already knows about the review being answered, and adding a fourth is
 * a deliberate act rather than a side effect of someone typing a new name into a
 * template body.
 */
export const TEMPLATE_VARIABLES = ["author", "location", "business"] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export type TemplateContext = Partial<Record<TemplateVariable, string | null>>;

const PLACEHOLDER = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

/**
 * Fills a template in.
 *
 * **One pass, never sequential replaces.** A reviewer is called whatever they
 * called themselves, and someone signing a review as `{{business}}` would
 * otherwise have that expanded on the next pass — untrusted text reaching a
 * second round of substitution is the shape of every template-injection bug
 * there has ever been. A single regex walk with a lookup means a substituted
 * value is never rescanned.
 *
 * A known variable with nothing behind it collapses: "Merhaba {{author}}," for
 * an anonymous reviewer becomes "Merhaba," rather than "Merhaba ,". An
 * *unknown* variable is left exactly as written — whoever typed `{{autor}}` sees
 * their typo in the composer, which is a far better outcome than a silently
 * empty greeting reaching a customer.
 */
export function renderTemplate(body: string, context: TemplateContext): string {
  const filled = body.replace(PLACEHOLDER, (match, rawName: string) => {
    const name = rawName as TemplateVariable;
    if (!TEMPLATE_VARIABLES.includes(name)) return match;
    return context[name]?.trim() ?? "";
  });

  return (
    filled
      // Tidy the hole an empty variable left: a doubled space, and a space that
      // has drifted in front of its punctuation.
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+([,.!?:;])/g, "$1")
      .replace(/[ \t]+$/gm, "")
      .trim()
  );
}
