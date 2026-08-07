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

  /*
    Not colours at all — hex that is *shown to a person* rather than applied to
    anything. Listed rather than excluded by a cleverer regex, because "is this
    string a colour" is not decidable from the outside and a rule nobody can
    predict is worse than a list they can read.
  */
  "src/components/agency/branding-form.tsx": "A placeholder: the example a customer types over.",
  "src/server/agency.ts": 'A validation message — "Use a hex colour like #3d5af1".',
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

describe("the design system's own rule", () => {
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
