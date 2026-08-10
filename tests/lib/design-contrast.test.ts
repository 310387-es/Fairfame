import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
 * "5.06:1 on white", "3.06:1 — NON-TEXT only", "an ink that clears 4.5:1 *on
 * that wash*". Comments like those are true on the day they are written and
 * silently stop being true the first time somebody nudges a hex by one digit.
 * This turns them into assertions.
 *
 * This header used to quote "4.54:1 on white — the lightest text allowed",
 * which was wrong twice over by 6 Aug 2026: `--text-faint` is 5.06:1 on white,
 * and on white the lightest *legal* ink is `--ink-400` at 4.68:1, not
 * `--text-faint` at all. Both `docs/15` and this comment had drifted from the
 * hexes underneath them — the very thing the file was written to prevent,
 * happening in the file's own prose, because nobody asserts a comment.
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
  /*
    The two surfaces a list row can be sitting on.

    Added with the row rebuild, and they belong in this table for the reason the
    table exists: a selected review carries `--ink-350` for its timestamp and
    for the snippet of a row already answered, and those are the pixels somebody
    is looking straight at.

    `--surface-selected` originally aliased `--indigo-050` and measured 4.49:1
    against `--ink-350` — under AA by a hundredth, invisible to the eye, and
    caught only by putting it in here. It has its own hex now; see the comment
    in globals.css for why `--indigo-050` could not simply move.
  */
  {
    surface: "surface-selected",
    lightest: "ink-350",
    darkerToo: ["ink-500", "ink-600", "ink-800"],
  },
  { surface: "surface-hover", lightest: "ink-350", darkerToo: ["ink-500", "ink-600", "ink-800"] },
  /*
    The marketing band on `/`, and the reason the completeness test below exists.

    `--indigo-050` was already in this file — as a *badge wash*, carrying
    `--indigo-700`. That is a different question from "may body text sit on it",
    and nothing connected the two, so when the landing page used it as a
    full-bleed section background carrying `--ink-350` the suite stayed green
    while four paragraphs measured **4.493:1** — under AA by seven thousandths.

    `--ink-350` and `--ink-400` both fail here (4.49 and 4.16); the lightest that
    clears is `--ink-500` at 5.21:1. The page uses `--ink-600`, which is darker
    still and therefore fine.
  */
  { surface: "indigo-050", lightest: "ink-500", darkerToo: ["ink-600", "ink-800"] },
];

/**
 * Backgrounds that are deliberately not body-text surfaces.
 *
 * Each entry is a claim: nobody sets ordinary prose on this. Keeping the reason
 * next to the token is the point — it is what a future reader has to disagree
 * with in writing before promoting one of these to a page surface.
 */
const NOT_A_TEXT_SURFACE: Record<string, string> = {
  transparent: "not a colour",
  white: "plain white, covered by --surface",
  current: "inherits, not a surface",
  // Dark surfaces: they carry `--text-on-ink`, asserted in "the two dark surfaces".
  "ink-900": "the rail and the briefing bar; white text, tested separately",
  "ink-800": "the same dark family",
  rail: "alias of --ink-900",
  brief: "alias of --ink-900",
  primary: "indigo-600 as a button fill; white text, not prose",
  "cta-brief": "amber on ink, the one amber control; tested separately",
  // Badge washes: each carries its own paired ink, asserted in "state pairs".
  "state-positive-bg": "badge wash with --state-positive-text",
  "state-negative-bg": "badge wash with --state-negative-text",
  "state-rating-bg": "badge wash with --amber-ink",
  "state-accent-bg": "badge wash with --state-accent-text",
  // Decorative fills: bars, hairlines and chart marks, never text beds.
  "sentiment-positive": "sentiment bar fill",
  "sentiment-neutral": "sentiment bar fill",
  "sentiment-negative": "sentiment bar fill",
  "line-soft": "a hairline drawn as a filled element",
  line: "a hairline",
  "indigo-100": "the margin rule and selected ring, non-text",
  "amber-500": "the rating mark and the one amber button; tested separately",
  destructive: "shadcn alias, white text",
  // shadcn aliases that resolve to surfaces already in the table above.
  card: "alias of --surface",
  popover: "alias of --surface",
  muted: "alias of --surface-sunken",
  accent: "alias of --surface-sunken",
  background: "alias of --canvas",
  secondary: "alias of --surface-sunken",
  input: "alias of --line",
  border: "alias of --line",
  sidebar: "alias of --ink-900",
  // Chart marks and scale fills. `--rating-1`…`--rating-5` each clear 4.5:1 as
  // *ink on white* (docs/15 §2) — which is a different claim from carrying
  // text, and they never do: they are the rungs of a bar.
  "rating-1": "rating scale fill",
  "rating-2": "rating scale fill",
  "rating-3": "rating scale fill",
  "rating-4": "rating scale fill",
  "rating-5": "rating scale fill",
  "chart-1": "chart series fill",
  "chart-2": "chart series fill",
  "chart-3": "chart series fill",
  "chart-4": "chart series fill",
  "chart-5": "chart series fill",
  "graphic-faint": "the non-text token; axis ticks and dots, by definition never prose",
  "indigo-700": "the primary button's hover fill; white text, not prose",
  "ink-500": "a filled marker, not a text bed",
};

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

  it("keeps the selected row's margin over AA, which is thin on purpose", () => {
    /*
      4.57:1 against a 4.5 floor. Recorded as an exact number rather than a
      `toBeGreaterThan`, because the margin is seven hundredths and the whole
      point is that nobody can nudge this surface a shade darker without the
      suite saying so — which is exactly what happened when it aliased
      `--indigo-050` and sat at 4.49.
    */
    expect(ratio(token("ink-350"), token("surface-selected"))).toBe(4.57);
  });

  it("keeps selection and hover distinguishable from each other", () => {
    // Not a WCAG rule — a design one, asserted here because this is where the
    // colour maths already lives. They were the same grey at two opacities,
    // which made a selected row invisible under the pointer.
    expect(token("surface-selected")).not.toBe(token("surface-hover"));
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

/**
 * The table above has to know about every background the product paints.
 *
 * This is the test that would have caught the landing page's 4.493:1 failure,
 * and it is deliberately shaped like the project's other completeness tests —
 * public routes enumerated from disk, tenant tables derived from the catalog.
 * Each of those exists because a *behaviour* test proves one door is locked and
 * notices nothing when somebody adds a door.
 *
 * The same was true here. Every assertion in this file was correct and the page
 * still shipped illegal text, because the surface it used was not on the list
 * and nothing required it to be. A hand-maintained list of six surfaces cannot
 * fail; it can only be incomplete.
 *
 * So: every `bg-*` in the app is resolved to a token and must be classified —
 * either it is a text surface with a known lightest ink, or it is named in
 * `NOT_A_TEXT_SURFACE` with the reason it is not. Adding a background without
 * deciding which it is now fails here rather than in front of somebody using a
 * screen reader.
 */
describe("every painted background is classified", () => {
  /* The same walk `action-feedback`, `design-tokens` and `formats` use. */
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return walk(path);
      return path.endsWith(".tsx") ? [path] : [];
    });
  }

  const FILES = walk("src");

  /*
    `bg-` is not only a colour prefix.

    Tailwind also spells `bg-clip-padding`, `bg-cover`, `bg-no-repeat` and
    friends this way, and a class built as `bg-rating-${n}` leaves the literal
    `bg-rating-` in the source. Both showed up as "unclassified surfaces" on the
    first run of this test, which is the sort of noise that gets an enumeration
    test deleted rather than fixed.
  */
  const NOT_A_COLOUR =
    /^(clip|cover|contain|center|top|bottom|left|right|repeat|no-repeat|fixed|local|scroll|origin|blend|auto|none|gradient|size|position)(-|$)/;

  const used = new Set(
    FILES.flatMap((file: string) => [...readFileSync(file, "utf8").matchAll(/\bbg-([a-z0-9-]+)/g)])
      .map((match) => match[1]!)
      .filter((name) => !/^\[/.test(name) && !NOT_A_COLOUR.test(name) && !name.endsWith("-")),
  );

  const classified = new Set([
    ...LIGHTEST_LEGAL_TEXT.map((entry) => entry.surface),
    ...Object.keys(NOT_A_TEXT_SURFACE),
  ]);

  it("finds backgrounds to check", () => {
    // A regex that silently matches nothing would make every assertion below
    // vacuously true, which is the failure mode of enumeration tests.
    expect(used.size).toBeGreaterThan(10);
  });

  it("has a ruling for each one", () => {
    const unclassified = [...used].filter((name) => !classified.has(name)).sort();

    expect(
      unclassified,
      `These backgrounds are painted somewhere in src/ and this file has no ` +
        `ruling on them. Either add the token to LIGHTEST_LEGAL_TEXT with the ` +
        `lightest ink that clears 4.5:1 on it, or to NOT_A_TEXT_SURFACE with ` +
        `the reason prose never sits on it: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });
});
