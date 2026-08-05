import { describe, expect, it } from "vitest";
import { DEFAULT_WIDGET_STYLE, WIDGET_THEMES, type WidgetTheme } from "@/widgets/config";
import { resolveAccent, WIDGET_PALETTES, widgetStylesheet } from "@/widgets/theme";
import { AA_NON_TEXT, AA_TEXT, ratio } from "./contrast-math";

/**
 * The widget palette, held to the same standard as the app's (P3-T0).
 *
 * `tests/lib/design-contrast.test.ts` exists because `globals.css` states its
 * ratios in prose and prose stops being true silently. The widget palette has
 * the same problem and one more: it is *literal hex*, written out by hand
 * because a customer's website has none of our tokens. There is no `globals.css`
 * to fall back on, so every claim in `src/widgets/theme.ts` is checked here.
 *
 * The bar is WCAG 2.1 AA, which the phase plan asks for and which a widget has
 * no excuse to miss — it is nine cards of text.
 */

describe.each(WIDGET_THEMES)("the %s palette", (theme: WidgetTheme) => {
  const palette = WIDGET_PALETTES[theme];

  it("carries body text at 4.5:1 on the card", () => {
    expect(ratio(palette.ink, palette.card)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("carries secondary text — dates, sources — at 4.5:1 too", () => {
    // The tempting mistake: treating "muted" as licence to go under the bar.
    // A date nobody can read is not a subtler date.
    expect(ratio(palette.inkMuted, palette.card)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("draws filled stars at 3:1, the bar WCAG 1.4.11 sets for a meaningful graphic", () => {
    // Brand amber is 2.04:1 on white — this is the check that keeps the light
    // palette using the darker `--rating-ink` value instead.
    expect(ratio(palette.star, palette.card)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it("makes links legible as text, not merely visible", () => {
    expect(ratio(palette.accent, palette.card)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("separates the card from the surface behind it", () => {
    // A border is a graphical object too. Below 3:1 the cards stop being cards
    // and the whole widget reads as one undifferentiated block of quotes.
    expect(ratio(palette.border, palette.surface)).toBeGreaterThanOrEqual(1.2);
  });
});

describe("the stylesheet", () => {
  it("inlines the chosen palette", () => {
    const css = widgetStylesheet({ ...DEFAULT_WIDGET_STYLE, theme: "dark" });
    expect(css).toContain(WIDGET_PALETTES.dark.ink);
    expect(css).not.toContain(WIDGET_PALETTES.light.border);
  });

  it("loads nothing over the network", () => {
    // The widget runs on somebody else's page. A font file or a background image
    // here is a request they did not ask for and cannot see coming.
    const css = widgetStylesheet(DEFAULT_WIDGET_STYLE);
    expect(css).not.toMatch(/@import|url\(/);
  });

  it("lets a business use its own accent, and falls back to brand indigo", () => {
    expect(resolveAccent({ ...DEFAULT_WIDGET_STYLE, accent: "#00695c" })).toBe("#00695c");
    expect(resolveAccent(DEFAULT_WIDGET_STYLE)).toBe(WIDGET_PALETTES.light.accent);
  });
});

/**
 * What makes the rating badge hug its frame (P3-T2).
 *
 * Two rules that look cosmetic and are not. The inline-block root is what the
 * auto-size script measures to report a width at all — a block root's width is
 * the frame's own width, so measuring it would answer the question with the
 * question. And `color-scheme` decides the paint behind a transparent document:
 * under `dark` the browser gives it a black canvas, which is what put a small
 * badge on a black slab in the builder.
 */
describe("the badge's box", () => {
  const badge = (theme: WidgetTheme) =>
    widgetStylesheet({ ...DEFAULT_WIDGET_STYLE, theme, layout: "badge" });

  it("sizes the widget root by its content rather than by the frame", () => {
    expect(badge("light")).toMatch(/\.rvw--badge\s*\{[^}]*display:\s*inline-block/);
    expect(badge("light")).toMatch(/\.rvw--badge\s*\{[^}]*width:\s*max-content/);
  });

  it("paints no surface behind a badge, in either theme", () => {
    for (const theme of WIDGET_THEMES) {
      expect(badge(theme)).toMatch(/\.rvw--badge\s*\{[^}]*background:\s*transparent/);
    }
  });

  it("keeps the document's canvas transparent, so a dark badge is not a black slab", () => {
    expect(badge("dark")).toContain("color-scheme: normal");
    expect(badge("dark")).not.toContain("color-scheme: dark");
  });

  it("still declares the theme for a wall of reviews, which covers its own frame", () => {
    expect(widgetStylesheet({ ...DEFAULT_WIDGET_STYLE, theme: "dark" })).toContain(
      "color-scheme: dark",
    );
  });
});
