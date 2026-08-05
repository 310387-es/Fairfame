import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AA_NON_TEXT, AA_TEXT, contrast, ratio } from "./contrast-math";

/**
 * WCAG 2.1 AA contrast, on the tokens themselves (P2-T9).
 *
 * The build plan asks for WCAG AA and there is no browser test layer, by
 * decision. Most of AA needs a rendered page — focus order, roving tabindex,
 * whether a control announces itself — and asserting that from source would be
 * theatre. **Contrast is the part that is a property of the palette**, not of
 * the page, so it can be checked exactly, here, on every run.
 *
 * It is worth checking because `globals.css` states its own ratios in prose:
 * "4.54:1 on white — the lightest text allowed", "3.06:1 — NON-TEXT only",
 * "an ink that clears 4.5:1 *on that wash*". Comments like those are true on
 * the day they are written and silently stop being true the first time somebody
 * nudges a hex by one digit. This turns them into assertions.
 *
 * Scope: the hex tokens. The shadcn base layer is `oklch()` and is not part of
 * the brand palette a designer edits — converting it would add a colour-space
 * implementation to prove something about values nobody touches.
 */

const CSS = readFileSync("src/app/globals.css", "utf8");

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(CSS);
  if (!match) throw new Error(`Token --${name} is not a plain hex in globals.css`);
  return match[1]!;
}

const WHITE = "#ffffff";

describe("the contrast maths", () => {
  it("agrees with the known anchors", () => {
    // Black on white is 21:1 and a colour on itself is 1:1, by definition. If
    // these are wrong every other number in this file is decoration.
    expect(ratio("#000000", WHITE)).toBe(21);
    expect(ratio(WHITE, WHITE)).toBe(1);
  });
});

/**
 * The lightest ink each surface can legally carry as body text.
 *
 * This is the rule the palette actually has, and it is not "one lightest text
 * token" — every surface in the product is a different tint, so the answer is a
 * table. A token designed against white is marginal on the canvas and illegal
 * on a segmented control's trough, which is exactly how a 3.97:1 label shipped.
 *
 * Read it as: on this surface, this token and every darker one clears AA.
 */
const LIGHTEST_LEGAL_TEXT: { surface: string; lightest: string; darkerToo: string[] }[] = [
  {
    surface: "surface",
    lightest: "ink-400",
    darkerToo: ["ink-350", "ink-500", "ink-600", "ink-800"],
  },
  { surface: "canvas", lightest: "ink-350", darkerToo: ["ink-500", "ink-600", "ink-800"] },
  { surface: "surface-sunken", lightest: "ink-350", darkerToo: ["ink-500", "ink-600", "ink-800"] },
  { surface: "surface-segmented", lightest: "ink-500", darkerToo: ["ink-600", "ink-800"] },
];

describe.each(LIGHTEST_LEGAL_TEXT)("text on --$surface", ({ surface, lightest, darkerToo }) => {
  it(`clears AA from --${lightest} downwards`, () => {
    for (const name of [lightest, ...darkerToo]) {
      expect(contrast(token(name), token(surface))).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe("the boundaries of that table", () => {
  it("puts --ink-400 out of bounds on every tint", () => {
    // It reads as "the muted label" and looks usable everywhere, which is how
    // it ended up on a segmented trough at 3.97:1. Asserting where it *fails*
    // keeps the constraint visible instead of tribal.
    expect(ratio(token("ink-400"), token("surface"))).toBe(4.68);

    for (const surface of ["canvas", "surface-sunken", "surface-segmented"]) {
      expect(contrast(token("ink-400"), token(surface))).toBeLessThan(AA_TEXT);
    }
  });

  it("puts --ink-350 out of bounds on the darkest tint only", () => {
    expect(ratio(token("ink-350"), token("surface"))).toBe(5.06);
    expect(ratio(token("ink-350"), token("canvas"))).toBe(4.73);
    expect(contrast(token("ink-350"), token("surface-segmented"))).toBeLessThan(AA_TEXT);
  });

  it("labels the segmented control's inactive segments legibly", () => {
    // The control the inbox sort uses, and the reason the table exists.
    expect(contrast(token("ink-500"), token("surface-segmented"))).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe("the non-text token", () => {
  it("is documented as 3.06:1 on white and still is", () => {
    expect(ratio(token("ink-300"), token("surface"))).toBe(3.06);
  });

  it("clears the non-text threshold on white", () => {
    expect(contrast(token("ink-300"), token("surface"))).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it("does not clear it on a tint, so it is a white-surface token too", () => {
    // 2.86:1 on the canvas. Recorded rather than silently tolerated: an axis
    // tick drawn straight onto the page background is under the floor.
    expect(contrast(token("ink-300"), token("canvas"))).toBeLessThan(AA_NON_TEXT);
  });

  it("does not clear the text threshold, which is why it is not text", () => {
    // The assertion that stops it being promoted to a label by somebody who
    // liked how light it looked. Failing *upward* here is the real risk.
    expect(contrast(token("ink-300"), token("surface"))).toBeLessThan(AA_TEXT);
  });
});

describe("state pairs", () => {
  // Every badge in the inbox: sentiment chips, the SLA chips added in P2-T4 and
  // P2-T7, the accent tag. Each is ink on its own wash, which is a stricter
  // test than the same ink on white.
  it.each([
    ["positive", "state-positive-text", "state-positive-bg"],
    ["negative", "state-negative-text", "state-negative-bg"],
  ])("%s ink clears AA on its own wash", (_label, ink, wash) => {
    expect(contrast(token(ink), token(wash))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("rating ink clears AA on its wash", () => {
    // `--state-rating-*` are aliases, so resolve the underlying tokens.
    expect(contrast(token("amber-ink"), token("amber-050"))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("accent ink clears AA on its wash", () => {
    expect(contrast(token("indigo-700"), token("indigo-050"))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("still clears AA on a plain white card", () => {
    // A badge's wash is a hint, not a guarantee: `Badge` can sit on a white
    // surface where the tint is barely there. The ink has to hold up alone.
    for (const ink of ["state-positive-text", "state-negative-text", "amber-ink", "indigo-700"]) {
      expect(contrast(token(ink), WHITE)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe("the two dark surfaces", () => {
  const rail = token("ink-900");

  it("carries white text at full AA", () => {
    expect(contrast(WHITE, rail)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("keeps the amber call to action legible on ink", () => {
    // The briefing bar's button — the one place amber is a background.
    expect(contrast(token("ink-800"), token("amber-500"))).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe("brand amber", () => {
  it("is unusable as text on white, which is why --amber-ink exists", () => {
    // globals.css says 2.04:1. Keeping the failing value asserted is what stops
    // somebody reaching for `--amber-500` the next time they want a warm label.
    expect(ratio(token("amber-500"), WHITE)).toBe(2.04);
    expect(contrast(token("amber-500"), WHITE)).toBeLessThan(AA_TEXT);
  });
});
