import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `docs/15`: "If you find yourself typing a hex code, a font size or a corner
 * radius, stop — the value you want is already a token."
 *
 * That rule has been in force since 3 Aug 2026 and nothing checked it, which is
 * the only reason this file exists. A design system decays one reasonable
 * exception at a time: every raw value is defensible on the day it is typed,
 * and the cost only shows up months later as a screen that no longer looks like
 * the product. Review cannot catch it — `#4f46e5` looks exactly like `#3d5af1`
 * — so it has to be a build failure.
 *
 * **Both lists below are allowlists with reasons, not bans.** Several raw
 * values in this codebase are correct, and a check that forced them out would
 * be worse than no check. The property being defended is not "zero raw values";
 * it is **"every raw value was argued for"**. A new one fails, and the fix is
 * either to use the token or to add a line here saying why not — which is the
 * conversation the rule wants to force.
 *
 * **It found five on its first run, and they were not judgement calls.**
 * `text-[11px]` *is* `--text-meta` and `text-[13px]` *is* `--text-copy` —
 * byte-identical to the token, typed by hand in five files across the sample
 * page, the avatar, the queues rail and two dashboard panels. Nobody chose a
 * different size; they wrote the number instead of the name, and the value
 * silently stopped tracking the scale. That is the whole failure mode, and it
 * is invisible until somebody moves a token — which this pass did.
 *
 * Same shape as the enumerations this codebase already relies on:
 * `TENANT_TABLES` in the RLS suite, the public-route list in
 * `public-leakage.test.ts`, the send-path classification in
 * `outbound-consent.test.ts`.
 */

const ROOT = "src";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** Comments are prose. A hex in a sentence is a citation, not a colour. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

/**
 * Files that may write colour literally, each because it renders somewhere
 * `globals.css` does not exist.
 *
 * This is the whole exemption: **no stylesheet reaches it.** A React component
 * inside the app never qualifies, however inconvenient the token is.
 */
const MAY_WRITE_HEX: Record<string, string> = {
  "src/widgets/theme.ts": "A widget renders on a stranger's site. Its own contrast suite.",
  "src/reports/document.ts": "A PDF has no stylesheet. Floors pinned by report-contrast.",
  "src/digest/pdf.ts": "The digest PDF, same as above.",
  "src/collect/poster.ts": "The QR poster and table tent, printed.",
  "src/messaging/templates.ts": "Email clients ignore custom properties. Pinned by email-palette.",
  "src/app/u/[token]/route.ts":
    "The unsubscribe page is an HTML string with no stylesheet — a compliance " +
    "surface a recipient reaches from an email footer.",
  "src/components/connections/provider-mark.tsx":
    "A brand colour is a fact about another company, not a value in our palette.",
  "src/components/brand/logo.tsx": "Our own mark. A logo's colours are the logo.",
  "src/app/manifest.ts":
    "The operating system reads a manifest before any stylesheet exists — it is " +
    "what paints the splash screen and the task-switcher chrome, so a custom " +
    "property there resolves to nothing. Copied from `--ink-900` and pinned by " +
    "tests/lib/manifest.test.ts so the two cannot drift.",

  /*
    Not colours at all — hex that is *shown to a person* rather than applied to
    anything. Listed rather than excluded by a cleverer regex, because "is this
    string a colour" is not decidable from the outside and a rule nobody can
    predict is worse than a list they can read.
  */
  "src/components/agency/branding-form.tsx": "A placeholder: the example a customer types over.",
  // `src/server/agency.ts` was exempted for the hex inside "Use a hex colour
  // like #3d5af1" and no longer needs it: that sentence is a translated string
  // now, so the example lives in the catalogues with the rest of the copy. The
  // stale-exemption check is what noticed, which is the whole point of it.
  "src/connectors/mock-platform/meta.ts":
    "`(#130429)` is a Meta *error code*, not a colour. Six digits are valid hex " +
    "characters, so the check cannot tell; a reader can.",
};

/**
 * Arbitrary Tailwind sizes that are deliberate, with the reason each is not a
 * token. Mostly optical: a glyph or a chip whose *drawn* size does not match
 * the scale's numbers.
 */
const MAY_SIZE_BY_HAND: Record<string, string> = {
  "src/components/ds/stars.tsx":
    "`★`/`☆` are drawn well inside their em box, so they need sizes the text " +
    "scale does not have to sit level with the text beside them.",
  "src/components/ds/metric.tsx": "The delta is 11.5px — between `meta` and `copy` by eye.",
  "src/components/ds/chip.tsx": "A chip's label and its mono count are optically matched.",
  "src/components/ui/badge.tsx": "10px: a state chip is smaller than any text role.",
  "src/components/ui/button.tsx": "One size variant lands between two type roles.",
  "src/components/shell/notification-bell.tsx": "Feed rows and the unread count.",
  "src/components/shell/trial-footer.tsx": "The rail footer, tighter than the rail.",
  "src/components/shell/sidebar-nav.tsx": "Rail items, tighter than `copy`.",
  "src/components/shell/user-menu.tsx": "Menu rows, matching the rail.",
  "src/components/shell/search-palette.tsx": "Palette rows, matching the rail.",
  "src/components/analytics/trend-chart.tsx": "SVG axis ticks; see also the `tick` prop note.",
  "src/components/widgets/embed-snippet.tsx": "A code block, sized to its own monospace.",
  "src/components/ds/segmented.tsx": "11.5px, matching the delta in `Metric`.",
  "src/components/locations/public-page-control.tsx": "11.5px, matching `Segmented` beside it.",
  "src/components/dashboard/reputation-chart.tsx": "10px SVG axis ticks, via the `tick` prop.",
  "src/components/reviews/saved-views.tsx": "10px, matching `Badge` — these read as state chips.",
  "src/components/reviews/template-picker.tsx": "10px, matching `Badge`.",
  "src/components/requests/recipient-picker.tsx":
    "12px: a picker row sits between `meta` and `copy`, and 13 crowded the " + "two-line result.",
  "src/components/requests/campaign-card.tsx":
    "17px: the campaign's own name, above `title` and well below `metric`. " +
    "The scale has no role here because nothing else in the product does this.",
};

const FILES = walk(ROOT);

/**
 * Files that write the *string* `text-something` without meaning a Tailwind
 * class, so the dead-class check below has to skip them.
 *
 * All but one emit a stylesheet as text — `text-align`, `text-decoration` and
 * `text-transform` are CSS properties, and they appear in exactly the surfaces
 * that have no stylesheet to reach for (the same reason these files may write
 * hex). `src/lib/utils.ts` is the odd one: `text-color` there is the name of a
 * `tailwind-merge` class *group*, which is the thing doing the checking.
 */
const NOT_CLASS_NAMES: Record<string, string> = {
  "src/widgets/theme.ts": "CSS properties in the widget's own stylesheet.",
  "src/messaging/templates.ts": "CSS properties in inline email styles.",
  "src/app/u/[token]/route.ts": "CSS properties in the unsubscribe page's <style>.",
  "src/lib/utils.ts": "`text-color` is a tailwind-merge class group, not a class.",
};

/** Tailwind's own `text-*` utilities that are neither a token nor a palette entry. */
const TAILWIND_TEXT_KEYWORDS = new Set([
  // Alignment, overflow, wrapping.
  "left",
  "center",
  "right",
  "justify",
  "start",
  "end",
  "ellipsis",
  "clip",
  "wrap",
  "nowrap",
  "balance",
  "pretty",
  // Keyword colours and the default size scale.
  "auto",
  "current",
  "transparent",
  "inherit",
  "white",
  "black",
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "5xl",
  "6xl",
  "7xl",
  "8xl",
  "9xl",
]);

const TAILWIND_PALETTE =
  /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|\d00)$/;

/** Every `--text-*` and `--color-*` name declared inside an `@theme` block. */
function declaredTokenNames(): Set<string> {
  const css = readFileSync(join(ROOT, "app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const names = new Set<string>();

  for (const block of css.matchAll(/@theme[^{]*\{([\s\S]*?)\n\}/g)) {
    for (const match of block[1]!.matchAll(/^\s*--(?:text|color)-([a-z0-9-]+):/gm)) {
      if (!match[1]!.includes("--")) names.add(match[1]!);
    }
  }

  return names;
}

describe("the design system's own rule", () => {
  /**
   * The other half of the `cn` bug, and the half nothing was watching.
   *
   * `class-merge.test.ts` proves a token that *exists* survives being composed
   * with an ink. It cannot see a class that was never a token at all — and
   * Tailwind's failure mode for those is silence. `text-subtitle` is not in the
   * scale, has never been in the scale, and was sitting on the collection
   * funnel's numbers and the connections screen's volume figure. No build error,
   * no warning, correct-looking markup, and the element quietly inheriting
   * whatever its parent happened to be: **13px on `/get-reviews`, against the
   * identical statistic two hundred pixels away at a hardcoded 17px.**
   *
   * It found seven more of the same kind on its first run, and the worst were
   * public: `text-ink` — there is no `--color-ink`, only `ink-400` through
   * `ink-900` — on the SEO page's `<h1>`, its rating figure and the body of
   * every review a business shows the open internet, plus two analytics tables;
   * and `text-ink-700`, a shade that does not exist, on the dashboard's AI
   * draft. Nine dead classes in five files, every one of them looking correct
   * in review.
   *
   * This is the same class of defect as the hand-typed sizes above — a value
   * that stopped tracking the system — but arrived from the opposite direction:
   * not a number written instead of a name, a name that was never a number.
   */
  it("has no text-* class that resolves to nothing", () => {
    const tokens = declaredTokenNames();
    const dead = new Map<string, string[]>();

    for (const path of FILES) {
      if (path in NOT_CLASS_NAMES) continue;

      for (const match of code(path).matchAll(/\btext-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b/g)) {
        const name = match[1]!;
        if (tokens.has(name) || TAILWIND_TEXT_KEYWORDS.has(name) || TAILWIND_PALETTE.test(name)) {
          continue;
        }
        dead.set(name, [...new Set([...(dead.get(name) ?? []), path])]);
      }
    }

    const report = [...dead].map(([name, paths]) => `text-${name} (${paths.join(", ")})`);

    expect(
      report,
      `These text-* classes match no token in globals.css and no Tailwind ` +
        `utility, so they generate no CSS and the element silently inherits. ` +
        `Use a real token — or, if the string is not a class at all (a CSS ` +
        `property in an emitted stylesheet), add the file to NOT_CLASS_NAMES: ` +
        `${report.join("; ")}`,
    ).toEqual([]);
  });

  /**
   * A brand family's shades are ours, and only the ones we declared exist.
   *
   * `indigo`, `amber` and `ink` are Revira's palette *and* three of Tailwind's
   * default palette names. Where the two overlap, Tailwind's built-in shade is
   * always there as a fallback — so `fill-amber-400` compiles, renders, and
   * quietly paints **#fbbf24** instead of the brand's **#f5a524**, because
   * `--color-amber-400` was never declared and nothing had to be.
   *
   * That is exactly what it did: on the public collection page, the star a
   * customer taps was a different amber from every star elsewhere in the
   * product. No test could see it — `amber-400` is a valid class, it resolves,
   * and it is one digit away from a name we own.
   *
   * So within the families we claim, a shade must be one we declared. Outside
   * them (`text-red-500` in a script, say) Tailwind's palette is nobody's
   * brand and is left alone.
   */
  it("uses no undeclared shade of a brand colour family", () => {
    const declared = declaredTokenNames();
    const FAMILIES = ["indigo", "amber", "ink"];
    const pattern = new RegExp(
      `\\b(?:bg|text|fill|stroke|border|ring|from|via|to|divide|outline|accent|shadow)-` +
        `((?:${FAMILIES.join("|")})-[0-9]+)\\b`,
      "g",
    );

    const offenders: string[] = [];
    for (const path of FILES) {
      if (path in NOT_CLASS_NAMES) continue;
      for (const match of code(path).matchAll(pattern)) {
        if (!declared.has(match[1]!)) offenders.push(`${match[1]} (${path})`);
      }
    }

    expect(
      [...new Set(offenders)],
      `These use a shade of a brand family that globals.css never declares, so ` +
        `Tailwind's own palette silently supplies the colour and the brand value ` +
        `is bypassed. Use the declared token — or declare the shade, if the ` +
        `palette genuinely needs it: ${[...new Set(offenders)].join(", ")}`,
    ).toEqual([]);
  });

  /** The exemptions are documentation; they have to stay true. */
  it("has no stale NOT_CLASS_NAMES entry", () => {
    const missing = Object.keys(NOT_CLASS_NAMES).filter((path) => !FILES.includes(path));
    expect(missing, "Exempted files that no longer exist — renamed or deleted?").toEqual([]);
  });

  it("keeps raw hex to the surfaces with no stylesheet", () => {
    const offenders = FILES.filter((path) => !(path in MAY_WRITE_HEX)).filter((path) =>
      /#[0-9a-fA-F]{6}\b/.test(code(path)),
    );

    expect(
      offenders,
      `These files write a hex colour and are not on the exemption list in ` +
        `tests/lib/design-tokens.test.ts. Use the token — the value you want is ` +
        `almost certainly already in globals.css. If the file genuinely renders ` +
        `where no stylesheet reaches (an email, a PDF, a widget on somebody ` +
        `else's site), add it there with that reason: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps hand-typed font sizes to the optical exceptions", () => {
    const offenders = FILES.filter((path) => !(path in MAY_SIZE_BY_HAND)).filter((path) =>
      /\btext-\[[0-9]/.test(code(path)),
    );

    expect(
      offenders,
      `These files set a font size by hand. The scale has ten roles ` +
        `(docs/21 §1) and one of them is almost certainly right. If the size is ` +
        `genuinely optical — a glyph that draws smaller than its em box — add ` +
        `the file to MAY_SIZE_BY_HAND with that reason: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * The allowlists are the documentation, so they have to stay true. A file
   * that stops needing its exemption should lose it, or the list slowly becomes
   * a place where anything is permitted.
   */
  it("has no stale exemptions", () => {
    const unusedHex = Object.keys(MAY_WRITE_HEX).filter(
      (path) => FILES.includes(path) && !/#[0-9a-fA-F]{6}\b/.test(code(path)),
    );
    const unusedSize = Object.keys(MAY_SIZE_BY_HAND).filter(
      (path) => FILES.includes(path) && !/\btext-\[[0-9]/.test(code(path)),
    );

    expect(
      [...unusedHex, ...unusedSize],
      "These files are exempted and no longer need it. Remove them, so the " +
        "list keeps meaning what it says.",
    ).toEqual([]);
  });

  it("names a file that does not exist in neither list", () => {
    // A rename would otherwise silently widen the exemption to nothing, and the
    // check would keep passing while the real file went unguarded.
    const missing = [...Object.keys(MAY_WRITE_HEX), ...Object.keys(MAY_SIZE_BY_HAND)].filter(
      (path) => !FILES.includes(path),
    );

    expect(missing, `Exempted files that no longer exist — renamed or deleted?`).toEqual([]);
  });
});
