import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AA_TEXT, ratio } from "./contrast-math";

/**
 * The report PDF's palette (P3-T8).
 *
 * The last surface in Phase 3 with **literal hex and no test**. Like the widget
 * stylesheet, a PDF has no tokens and no `globals.css` — `src/reports/
 * document.ts` restates the brand colours in the only form that survives the
 * trip, and a restated colour is a colour that can drift.
 *
 * It matters more here than it looks. A report is read on a screen by whoever
 * asked for it and then, often, printed and put in front of somebody else; a
 * delta rendered in a colour that fails AA is unreadable in both. And unlike a
 * web page, nobody can zoom a PDF's contrast into existence.
 *
 * The values are read **out of the module** rather than copied into this file,
 * so this cannot pass while the document renders something else.
 */

const source = readFileSync("src/reports/document.ts", "utf8");

function colour(name: string): string {
  const match = new RegExp(`const ${name} = "(#[0-9a-f]{6})"`).exec(source);
  if (!match) throw new Error(`src/reports/document.ts no longer declares ${name}`);
  return match[1]!;
}

const PAPER = "#ffffff";

describe("what a report is set in", () => {
  it("carries body text at AA on paper", () => {
    expect(ratio(colour("INK"), PAPER)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("carries its secondary text at AA too", () => {
    // Labels, the period, the footer. "Muted" is not licence to go under the
    // bar — a caption nobody can read is not a subtler caption.
    expect(ratio(colour("INK_MUTED"), PAPER)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("renders both directions of a delta legibly", () => {
    // These are the two colours that carry meaning on their own — up and down —
    // so they are the two that must not be decorative.
    expect(ratio(colour("ACCENT"), PAPER)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(ratio(colour("NEGATIVE"), PAPER)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("does not rely on colour alone to say which way a number moved", () => {
    // WCAG 1.4.1. The deltas are signed strings — "+0,4" and "−3" — so a reader
    // who cannot tell the two colours apart still gets the direction. This
    // asserts the renderer keeps the sign rather than styling it away.
    expect(source).toContain("metric.delta");
    expect(source).toContain('metric.value ?? "—"');
  });
});
