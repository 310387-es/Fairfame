import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cn } from "@/lib/utils";

/**
 * `cn` must not eat the type scale.
 *
 * Tailwind puts font-size and text-colour in one `text-*` namespace, and
 * `tailwind-merge` separates them from a table of Tailwind's *default* scale.
 * Every size and every ink in this product is a custom `@theme` token, so out
 * of the box it recognised neither, filed both as one ambiguous group, and
 * applied last-one-wins — which silently deleted the size:
 *
 *     cn("text-eyebrow text-faint")  ->  "text-faint"
 *
 * `Eyebrow` exists to be 10.5px so that a metric's number outranks its label.
 * It was rendering at the inherited 16px on every tile in the product, with no
 * build error, no console warning and correct-looking markup. That is the whole
 * reason this file exists: the failure is invisible everywhere except on screen,
 * so it has to be caught here.
 *
 * The last test is the one that matters over time — it reads the tokens out of
 * `globals.css` and fails when one is added there and not registered in `cn`.
 * Without it this suite only ever proves that yesterday's tokens still work.
 */

const GLOBALS = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");

/**
 * The `--text-*` names that are **font sizes**, which is not all of them.
 *
 * `--text-*` is overloaded in this stylesheet, deliberately and with a warning
 * attached: inside an `@theme` block it is Tailwind's font-size namespace, and
 * in plain `:root` it is the system's semantic ink aliases (`--text-primary`,
 * `--text-muted`, …). globals.css says so — "They must never enter an `@theme`
 * block, where the `--text-*` namespace means font-size and would collide."
 *
 * Scanning the whole file reported those five aliases as unregistered sizes,
 * which is the collision the comment predicts, arriving in a test rather than
 * in a stylesheet. So this reads only the `@theme` blocks. The `--` filter drops
 * the per-size modifiers (`--text-title--line-height`).
 */
function declaredFontSizes(): string[] {
  const found = new Set<string>();

  /*
    Comments first, and the reason is worth keeping: globals.css contains the
    sentence "They must never enter an `@theme` block", and this scanner matched
    the word `@theme` *inside that comment*, then ran on to the next `{` — which
    was the `:root` holding the ink aliases. The warning about the collision
    caused the collision.
  */
  const css = GLOBALS.replace(/\/\*[\s\S]*?\*\//g, "");

  // `@theme` blocks are top-level, so an unindented `}` closes one.
  for (const block of css.matchAll(/@theme[^{]*\{([\s\S]*?)\n\}/g)) {
    for (const match of block[1]!.matchAll(/^\s*--text-([a-z0-9-]+):/gm)) {
      const name = match[1]!;
      if (name.includes("--")) continue;
      found.add(name);
    }
  }

  return [...found];
}

describe("cn keeps a size and a colour apart", () => {
  it("does not drop a custom size when a custom ink follows it", () => {
    expect(cn("text-eyebrow text-faint uppercase")).toContain("text-eyebrow");
    expect(cn("text-copy", "text-muted-foreground")).toContain("text-copy");
    expect(cn("text-title", "text-foreground")).toContain("text-title");
    expect(cn("text-metric", "text-state-rating-text")).toContain("text-metric");
    expect(cn("text-body", "text-ink-400")).toContain("text-body");
  });

  it("keeps the ink too — this is not a licence to drop the other half", () => {
    expect(cn("text-eyebrow text-faint")).toContain("text-faint");
    expect(cn("text-copy", "text-muted-foreground")).toContain("text-muted-foreground");
  });

  it("still lets a later size override an earlier one", () => {
    expect(cn("text-copy", "text-body")).toBe("text-body");
    expect(cn("text-title", "text-meta")).toBe("text-meta");
  });

  it("still lets a later ink override an earlier one", () => {
    expect(cn("text-faint", "text-primary")).toBe("text-primary");
  });

  it("leaves Tailwind's own scale alone", () => {
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
    expect(cn("text-sm", "text-red-500")).toBe("text-sm text-red-500");
  });

  /**
   * The completeness check. Same shape as the public-route enumeration in
   * `tests/db/public-leakage.test.ts`: a rule that only covers what somebody
   * remembered to list is a rule the next addition walks straight past.
   */
  it("registers every --text-* size declared in globals.css", () => {
    const missing = declaredFontSizes().filter(
      (size) => !cn(`text-${size}`, "text-faint").includes(`text-${size}`),
    );

    expect(
      missing,
      `These font-size tokens are declared in globals.css but not registered in ` +
        `FONT_SIZES in src/lib/utils.ts, so tailwind-merge will silently delete ` +
        `them whenever they are composed with a text colour: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
