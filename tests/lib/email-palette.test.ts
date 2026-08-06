import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AA_TEXT, contrast } from "./contrast-math";

/**
 * Every colour in an email is the brand's colour.
 *
 * Email clients do not support custom properties, so `src/messaging/templates.ts`
 * writes hex literally — the same exemption `src/widgets/theme.ts` has. That
 * exemption is about *how* a colour is written, never about *which* colour it
 * is, and without something checking, the difference is invisible: until
 * 7 Aug 2026 the templates were drawn in Tailwind's stock greys, and the digest
 * linked in `#4f46e5` — Tailwind's indigo-600, not Revira's `#3d5af1`. Two
 * indigos in one email, neither obviously wrong on its own.
 *
 * A hand-copied palette cannot be caught by review, because a wrong grey looks
 * exactly like a right one. It can be caught by asking whether the value exists
 * in `globals.css`, which is what this does.
 *
 * Mirrors `report-contrast.test.ts`, which does the same job for the PDF.
 */

const CSS = readFileSync("src/app/globals.css", "utf8");

/**
 * The templates **with comments stripped**, which is not a detail.
 *
 * The header of that file explains this rule by quoting the values it replaced
 * — "`#6b7280` for muted text… `#4f46e5`, which is Tailwind's indigo-600 and
 * not Revira's" — because a rule with no example of the mistake is a rule
 * nobody can apply. Scanning the raw text made that documentation fail the very
 * check it documents, which would have left one of two bad options: delete the
 * explanation, or weaken the test.
 *
 * So the check reads code. A hex in prose is a citation; a hex in a style
 * attribute is a colour.
 */
const TEMPLATES = readFileSync("src/messaging/templates.ts", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

/** Every plain hex declared as a token, lowercased. */
const TOKENS = new Map<string, string[]>();
for (const match of CSS.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
  const hex = match[2]!.toLowerCase();
  TOKENS.set(hex, [...(TOKENS.get(hex) ?? []), match[1]!]);
}

/**
 * White is not a token and does not need to be. It is the paper an email is
 * printed on, and `--surface` happens to equal it; asserting it as a token
 * would only invite somebody to add `--white`.
 */
const ALLOWED_OUTSIDE_TOKENS = new Set(["#ffffff"]);

function hexesIn(source: string): string[] {
  return [...new Set([...source.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0]!.toLowerCase()))];
}

describe("the email palette", () => {
  it("uses only colours that exist in globals.css", () => {
    const strays = hexesIn(TEMPLATES).filter(
      (hex) => !TOKENS.has(hex) && !ALLOWED_OUTSIDE_TOKENS.has(hex),
    );

    expect(
      strays,
      `These hex values appear in src/messaging/templates.ts but are not any ` +
        `token in globals.css. An email cannot use var(), so the hex is written ` +
        `out — but it still has to be a brand colour. Find the token that means ` +
        `what you want and copy its value: ${strays.join(", ")}`,
    ).toEqual([]);
  });

  it("links in Revira's indigo, not a lookalike", () => {
    // The one that actually shipped wrong. `#4f46e5` is Tailwind's indigo-600
    // and sat four pixels of hue from ours in the same email.
    expect(TEMPLATES).not.toContain("#4f46e5");
    expect(TEMPLATES).toContain("#3d5af1");
  });

  it("keeps its muted text legal on the tinted blocks, not just on white", () => {
    /*
      The trap this file is really guarding. The app's muted role is
      `--ink-400`, but several email blocks sit on `--surface-sunken`, where it
      measures 4.37:1 and is illegal. The templates use `--ink-350`, which
      clears AA on both — so one value is safe wherever a template puts it,
      which matters more here than matching the app, because a template has no
      layout engine to check it with.
    */
    const inkFor = (name: string) => {
      const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(CSS);
      return match![1]!;
    };

    const muted = inkFor("ink-350");
    expect(TEMPLATES).toContain(muted);
    expect(TEMPLATES).not.toContain(inkFor("ink-400"));

    for (const surface of ["#ffffff", inkFor("surface-sunken"), inkFor("canvas")]) {
      expect(contrast(muted, surface)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});
