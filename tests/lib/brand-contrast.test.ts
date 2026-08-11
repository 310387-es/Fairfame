import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AA_TEXT, contrast, ratio } from "./contrast-math";

/**
 * The brand layer's palette (`docs/24` §3), asserted the way `docs/15`'s is.
 *
 * `design-contrast.test.ts` proves the product's tokens; this proves the five
 * the marketing front door adds. They are a separate file because they are a
 * separate palette with a separate rule — the brand's surface is *warm* and
 * the product's is cool, which is the whole boundary §7 draws — and because
 * they are declared on `.marketing` rather than on `:root`, so a reader of
 * either file should not have to hold both scopes in their head at once.
 *
 * Two kinds of claim are checked here, and only the first is about colour:
 *
 *   1. **Legibility.** Every ink the front door sets prose in clears AA on
 *      both surfaces it can land on — paper, and the white cards on paper.
 *   2. **Identity.** `docs/24` §3 says the brand's ink *is* `--ink-800` and
 *      its indigo *is* the product's. A hex repeated in the brand block would
 *      make that a coincidence maintained by hand; pointing at the product
 *      token makes it a fact. So the block is asserted to *reference* rather
 *      than restate — which is the check that fails the day somebody "tidies"
 *      `var(--ink-800)` into `#10193a` and the two quietly drift apart.
 */

const CSS = readFileSync("src/app/globals.css", "utf8");

/** The `.marketing` block alone — these tokens exist nowhere else. */
const BRAND_BLOCK = (() => {
  const match = /\.marketing\s*\{([^}]*)\}/.exec(CSS);
  if (!match) throw new Error("No `.marketing` token block in globals.css");
  return match[1]!;
})();

function brandToken(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(BRAND_BLOCK);
  if (!match) throw new Error(`--${name} is not a plain hex in the .marketing block`);
  return match[1]!;
}

/** A product token, read from anywhere in the file. */
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(CSS);
  if (!match) throw new Error(`--${name} is not a plain hex in globals.css`);
  return match[1]!;
}

const WHITE = "#ffffff";

describe("the brand's warm surface", () => {
  const paper = brandToken("paper");

  it("is warm, which is the reason it is not --canvas", () => {
    // Red above blue. If somebody replaces paper with a cool grey the page
    // still passes every contrast check and stops being the brand.
    const [r, , b] = [1, 3, 5].map((offset) =>
      Number.parseInt(paper.slice(offset, offset + 2), 16),
    );
    expect(r!).toBeGreaterThan(b!);
  });

  it("carries both brand inks at full AA", () => {
    for (const ink of ["paper-faint", "paper-body"]) {
      expect(contrast(brandToken(ink), paper)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("carries the same inks on the white cards that sit on it", () => {
    // Every card on the front door is white on paper, and the secondary ink is
    // reused inside them. Clearing on one surface is not clearing on both.
    for (const ink of ["paper-faint", "paper-body"]) {
      expect(contrast(brandToken(ink), WHITE)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("would not carry the product's --ink-400, which is why --paper-faint exists", () => {
    // 4.37:1. Keeping the failing value asserted is what stops somebody
    // reaching for the app's muted ink the next time they want a quiet label
    // on this page — it is legal on white and not on paper.
    expect(ratio(token("ink-400"), paper)).toBe(4.37);
    expect(contrast(token("ink-400"), paper)).toBeLessThan(AA_TEXT);
  });
});

describe("the brand's dark surfaces", () => {
  it("carries white text on the closing band", () => {
    expect(contrast(WHITE, token("ink-900"))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("keeps the amber call to action legible on it", () => {
    // The one amber *button* on the page, and the same pairing the briefing
    // bar uses in-product: rail ink on amber.
    expect(contrast(token("ink-900"), token("amber-500"))).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe("what the brand shares with the product", () => {
  /*
    docs/24 §3: "Ink #10193A — identical to --ink-800" and "Indigo #3D5AF1 —
    same meaning as in-product". The document states the identity; this makes
    the stylesheet keep it.
  */
  it("declares its ink by reference, not by repeating a hex", () => {
    expect(BRAND_BLOCK).toMatch(/--brand-ink:\s*var\(--ink-800\)/);
    expect(BRAND_BLOCK).toMatch(/--brand-rail:\s*var\(--ink-900\)/);
  });

  it("adds warm values only — nothing the product palette already has", () => {
    const literals = [...BRAND_BLOCK.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)];

    // Exactly the four warm ones. Anything else means a cool value has been
    // copied in rather than referenced, which is how two palettes become one
    // and the boundary in §7 stops meaning anything.
    expect(literals.map((match) => match[1]).sort()).toEqual([
      "paper",
      "paper-body",
      "paper-faint",
      "paper-line",
    ]);
  });
});
