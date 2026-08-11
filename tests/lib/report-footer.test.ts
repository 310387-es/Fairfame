import { describe, expect, it } from "vitest";
import { reportDocument, type ReportContent } from "../../src/reports/document.ts";

/**
 * The report's footer, which for the whole of Phase 3 was not on the page.
 *
 * `styles.footer` said `position: absolute; bottom: 28` — the obvious way to
 * put something at the foot of every page, and it rendered nothing at all.
 * Every scheduled report went out without its brand line, its generation date
 * or "1 of 2". Nothing threw, no test failed, and the tables above it were
 * correct: the only evidence was a band of white paper that nobody reads.
 *
 * The cause is in `@react-pdf/renderer` 4 and is documented where it bites, in
 * `src/reports/document.ts`: a `fixed` child positioned with `bottom` is laid
 * out off the paper when the `Page` carries a `lineHeight`. Anchoring from the
 * top is the fix that leaves every other element exactly where it was.
 *
 * **So this test exists to stop a tidy-up.** `top: 802` beside a `bottom: 28`
 * that reads more naturally is precisely the kind of thing a later reader
 * "corrects", and the failure they would cause is invisible in review, in the
 * unit suite and in the browser suite. It is only visible in a rendered PDF —
 * which is why the property is asserted here rather than the pixels.
 *
 * Asserting the element tree rather than the bytes, the way the other report
 * tests do: `@react-pdf` renders through a layout engine we do not want to run
 * in a unit test, and the glyphs it emits are a subset font that cannot be
 * grepped for a word.
 */

const CONTENT: ReportContent = {
  title: "Kadıköy Kahve",
  subtitle: "27 July – 2 August 2026 · weekly",
  metrics: [{ label: "Reviews", value: "31", delta: "+7", direction: "up" }],
  tables: [],
  footer: "Fairfame · generated 10 August 2026",
  pageLabel: (page, total) => `${page} of ${total}`,
};

/** Every element in the tree, flattened — the footer's depth is not the point. */
function flatten(node: unknown): Record<string, unknown>[] {
  if (!node || typeof node !== "object") return [];
  const element = node as { props?: { children?: unknown } };
  const children = element.props?.children;
  const nested = Array.isArray(children) ? children : [children];
  return [element as Record<string, unknown>, ...nested.flatMap(flatten)];
}

describe("the report's footer", () => {
  const nodes = flatten(reportDocument(CONTENT));
  const fixed = nodes.filter(
    (node) => (node.props as { fixed?: boolean } | undefined)?.fixed === true,
  );

  it("is fixed, so it repeats on every page", () => {
    // A report can run to two pages, and a footer on the first one only is a
    // page-number that lies.
    expect(fixed).toHaveLength(1);
  });

  it("is anchored from the top, never from the bottom", () => {
    const style = (fixed[0]?.props as { style?: Record<string, unknown> } | undefined)?.style ?? {};

    expect(
      style.top,
      "the footer must be positioned from the top — `bottom` renders nothing under a Page " +
        "with a lineHeight (see src/reports/document.ts)",
    ).toBeTypeOf("number");
    expect(style.bottom).toBeUndefined();
  });

  it("carries the caller's own words, in the caller's language", () => {
    const text = flatten(fixed[0]).flatMap((node) => {
      const children = (node.props as { children?: unknown } | undefined)?.children;
      return typeof children === "string" ? [children] : [];
    });

    expect(text).toContain(CONTENT.footer);
  });
});
