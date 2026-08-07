import { isBadgeLayout, type WidgetStyle, type WidgetTheme } from "./config.ts";

/**
 * The widget's stylesheet — the one part of the product that cannot use a token.
 *
 * `CLAUDE.md` says never type a hex code, because the value is already a token
 * in `globals.css`. That rule holds everywhere our CSS is loaded. A widget is
 * the exception it cannot cover: it renders on a **stranger's website**, where
 * `globals.css` does not exist, Tailwind does not exist, and nothing we ship is
 * available except the bytes in this file. So the palette is restated here as
 * literal hex — the same colours, from `docs/08` §2 and `globals.css`, written
 * in the only form that survives the trip.
 *
 * Two safeguards keep that from becoming drift:
 *   - `tests/lib/widget-theme.test.ts` re-derives every contrast ratio claimed
 *     below, so an edit that breaks WCAG AA fails the run rather than the user.
 *   - The brand colours are the design brief's own hex codes, which is the
 *     upstream `globals.css` converted to oklch from — not a second opinion.
 *
 * Everything is inlined into one `<style>` element and scoped under `.rvw`, so
 * the widget document carries no external request: no font file, no CSS file,
 * no icon sprite. A widget that costs the customer's page a round trip before
 * it paints is a widget they will eventually remove.
 */

export type WidgetPalette = {
  surface: string;
  /** The card, which sits on `surface`. */
  card: string;
  border: string;
  ink: string;
  /** Secondary text — dates, source names. Clears 4.5:1 on `card`. */
  inkMuted: string;
  /** Filled stars. Clears 3:1 on `card` as WCAG 1.4.11 asks of a meaningful graphic. */
  star: string;
  /** Empty stars: decorative, since the filled ones plus the number carry the value. */
  starEmpty: string;
  accent: string;
};

/**
 * Light is the default because most sites are light, and because the app itself
 * has exactly one theme (see the note in `src/widgets/config.ts` on why a widget
 * theme is not the app's dark mode).
 */
export const WIDGET_PALETTES: Record<WidgetTheme, WidgetPalette> = {
  light: {
    surface: "#ffffff",
    card: "#ffffff",
    border: "#e5e8f2",
    // Brand Ink — 17.2:1 on white.
    ink: "#10193a",
    /*
      6.1:1 on white. It said "the hex counterpart of `--muted-foreground`",
      which was true when it was written and is not now: the design-system block
      later re-pointed that alias at `--ink-400` (#6b7391, 4.68:1), and this hex
      did not follow.

      **Deliberately not updated to match.** A widget renders on a stranger's
      site, at whatever size and against whatever background their CSS leaves
      behind, with no way for us to check the result. 6.1:1 is the right amount
      of margin for that; 4.68 is the app's floor, chosen for a surface we
      control. The claim was wrong, not the colour — so the claim is what
      changed.
    */
    inkMuted: "#5a6180",
    /**
     * Not brand amber. `#f5a524` is 2.04:1 on white — `globals.css` measured the
     * same thing and answers it with `--rating-ink`, a darker value of the same
     * hue. This is that value in hex: 4.7:1, so the stars are legible rather
     * than merely present.
     */
    star: "#a66300",
    starEmpty: "#dfe3ef",
    // Brand Indigo.
    accent: "#3d5af1",
  },
  dark: {
    // Brand Ink as a surface, so a dark widget still reads as ours.
    surface: "#10193a",
    card: "#182252",
    border: "#2a3358",
    ink: "#f2f4fb",
    // 6.4:1 on the dark card.
    inkMuted: "#a9b2ce",
    // Brand amber, which on ink is 7.6:1 — the contrast problem is white's, not
    // the colour's.
    star: "#f5a524",
    starEmpty: "#3a4478",
    // Lifted from brand indigo, which at 5.0:1 against ink is too close to its
    // own background to read as a link.
    accent: "#8fa2ff",
  },
};

/** Where the accent lands when the business has not chosen one. */
export function resolveAccent(style: WidgetStyle): string {
  return style.accent ?? WIDGET_PALETTES[style.theme].accent;
}

/**
 * The complete stylesheet for one widget.
 *
 * A system font stack rather than a webfont: downloading Geist onto a
 * customer's site to render nine review cards is a cost they did not ask for,
 * and a widget that inherits the host page's own typography usually looks more
 * native anyway — which is why `font-family` starts with `inherit` for the
 * embedded case and falls back to the system stack inside the iframe.
 */
export function widgetStylesheet(style: WidgetStyle): string {
  const palette = WIDGET_PALETTES[style.theme];
  const accent = resolveAccent(style);

  /**
   * A badge floats; a review wall fills its slot.
   *
   * `color-scheme` is what decides the *canvas* — the paint behind a document
   * with no background of its own. A wall never shows it (the root covers the
   * frame edge to edge), so declaring the widget's theme there is free. A badge
   * is the opposite: its root is transparent and smaller than the frame for the
   * moment before the frame catches up, and under `color-scheme: dark` the UA
   * paints that canvas **black**. Seen in the browser — a small dark badge on a
   * black slab. `normal` keeps the canvas transparent, which is what lets the
   * host page show through the badge's rounded corners.
   */
  const inline = isBadgeLayout(style.layout);

  return `
:root { color-scheme: ${inline ? "normal" : style.theme}; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
.rvw {
  --rvw-card: ${palette.card};
  --rvw-border: ${palette.border};
  --rvw-ink: ${palette.ink};
  --rvw-ink-muted: ${palette.inkMuted};
  --rvw-star: ${palette.star};
  --rvw-star-empty: ${palette.starEmpty};
  --rvw-accent: ${accent};
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  color: var(--rvw-ink);
  background: ${palette.surface};
  padding: 4px;
}
.rvw *:focus-visible { outline: 2px solid var(--rvw-accent); outline-offset: 2px; border-radius: 4px; }

.rvw-list { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
/* Mobile-first: one column, and only widen where there is room. The widget has
   no idea how wide its slot on the host page is, so this is a container query
   in spirit — expressed as a media query because the iframe *is* the container. */
.rvw-grid { grid-template-columns: 1fr; }
@media (min-width: 560px) { .rvw-grid { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 860px) { .rvw-grid { grid-template-columns: repeat(3, 1fr); } }

/* A carousel with no JavaScript: a scroll-snap row. It is keyboard-scrollable,
   respects the platform's own momentum and touch handling, and cannot break the
   way a hand-rolled slider does. Arrows would need script; swipe and arrow keys
   already work.

   The scrollbar is deliberately *visible* and styled rather than hidden. A row
   whose last card is cut off at the container edge with no other signal reads
   as broken layout, not as "there is more this way" — obvious on a phone where
   swiping is the instinct, much less so with a mouse. A thin permanent bar is
   the smallest honest affordance that does not cost a line of JavaScript. */
.rvw-carousel {
  grid-auto-flow: column;
  grid-auto-columns: minmax(240px, 78%);
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  padding-bottom: 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--rvw-star-empty) transparent;
  /* Keeps the off-screen cards out of the *document's* scrollable area.

     Being a scroll container is not enough on its own: with nine implicit grid
     columns the cards reach ~2440px, and the document itself became
     horizontally scrollable — so the widget had two horizontal scrollbars, the
     row's and its own. Measured, and overflow-x: hidden on this row did not
     stop it; paint containment does, because it takes the descendants out of
     every ancestor's overflow rather than merely clipping what is drawn.

     On a customer's page the document-level version of this is what drags their
     whole layout sideways on a phone. */
  contain: paint;
}
.rvw-carousel::-webkit-scrollbar { height: 6px; }
.rvw-carousel::-webkit-scrollbar-track { background: transparent; }
.rvw-carousel::-webkit-scrollbar-thumb {
  background: var(--rvw-star-empty);
  border-radius: 3px;
}
@media (min-width: 560px) { .rvw-carousel { grid-auto-columns: minmax(260px, 46%); } }
@media (min-width: 860px) { .rvw-carousel { grid-auto-columns: minmax(280px, 31%); } }
.rvw-carousel > li { scroll-snap-align: start; }

.rvw-card {
  background: var(--rvw-card);
  border: 1px solid var(--rvw-border);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rvw-stars { display: flex; align-items: center; gap: 2px; }
.rvw-star { width: 16px; height: 16px; flex: none; fill: var(--rvw-star); }
.rvw-star--empty { fill: var(--rvw-star-empty); }
.rvw-text { margin: 0; overflow-wrap: anywhere; }
.rvw-meta { margin: 0; font-size: 13px; color: var(--rvw-ink-muted); display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.rvw-author { font-weight: 600; color: var(--rvw-ink); }
.rvw-sep { color: var(--rvw-border); }
.rvw-link { color: var(--rvw-accent); text-decoration: none; }
.rvw-link:hover { text-decoration: underline; }
/* The rating badge (P3-T2).

   Sized to its content and nothing more: it goes in a header, a footer or
   beside a "Book now" button, so it has to sit inline without pushing anything
   around. inline-flex plus the auto-height message is what lets a customer
   drop it anywhere without picking a height.

   NOTE: everything from here to the closing backtick is inside a template
   literal. No backticks in these comments — one ends the string, and the error
   surfaces a hundred lines away as "Expected ';'". */
/* The badge's root, and the one place a widget is not a block.

   inline-block plus max-content is what makes the root's own box the badge's
   size rather than the frame's, which is what the auto-size script needs before
   it can report a width worth acting on: a block root's width IS the frame's
   width, so measuring it and sending it back would be a measurement of the
   answer. max-content owes nothing to the frame, so it converges in one pass —
   the same argument that keeps the height from running away.

   No surface and no padding, because there is nothing to sit on: the badge box
   below carries its own background and border, and anything painted out here
   would be a rectangle around a control meant to sit next to a Book-now button.

   **No max-width, and that is not an oversight.** The obvious max-width: 100%
   puts the frame's width straight back into the measurement: the root reports
   the clamped width, the frame shrinks to it, the clamp tightens, and the badge
   ratchets down a little further every pass. Watched it fall from 152px to 78px
   in the builder, with the badge overflowing a root that was still shrinking.
   max-content on its own owes nothing to the frame, so there is exactly one
   fixed point. Keeping the badge inside a narrow column is the frame element's
   job — the loader and the preview both cap it at 100% of its slot. */
.rvw--badge {
  display: inline-block;
  width: max-content;
  background: transparent;
  padding: 0;
}
.rvw-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  /* One line, always. A badge that can wrap has a width that depends on the
     width it is given, which is the same feedback loop by another route. */
  white-space: nowrap;
  border: 1px solid var(--rvw-border);
  border-radius: 10px;
  background: var(--rvw-card);
  line-height: 1.2;
}
.rvw-badge-score { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; }
.rvw-badge-meta { font-size: 12px; color: var(--rvw-ink-muted); }
/* The count sits under the stars rather than beside the score, so the number a
   reader cares about — the rating — is never competing with a four-digit total. */
.rvw-badge-lines { display: flex; flex-direction: column; gap: 2px; }
.rvw-badge-row { display: flex; align-items: center; gap: 6px; }
/* No rating yet is a state, not a zero. It reads as text, without a score. */
.rvw-badge--empty .rvw-badge-score { display: none; }
/* The badge as a link (P3-T2). It wraps the box rather than sitting inside it,
   so the whole badge is the target — a 150x50 hit area instead of a word. No
   underline and inherited colour: this is a control that already looks like
   one, and decorating it as body-text link would make it read as a footnote. */
.rvw-badge-link { display: inline-block; text-decoration: none; color: inherit; }
.rvw-badge-link:hover .rvw-badge { border-color: var(--rvw-accent); }

.rvw-empty { margin: 0; padding: 24px 16px; text-align: center; color: var(--rvw-ink-muted); border: 1px dashed var(--rvw-border); border-radius: 12px; }
.rvw-footer { margin: 12px 0 0; font-size: 12px; color: var(--rvw-ink-muted); text-align: right; }

/* Screen-reader-only, the standard clip-rect recipe. The star row is drawn with
   SVG that says nothing on its own, so every rating carries its value in text. */
.rvw-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

@media (prefers-reduced-motion: reduce) {
  .rvw * { animation: none !important; transition: none !important; }
}
`.trim();
}
