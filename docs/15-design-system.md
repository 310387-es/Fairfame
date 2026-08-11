# 15 — Design system

**Status:** in force as of 3 Aug 2026, **amended 6 Aug 2026**. Imported from the approved Home redesign (option **1a**), reviewed on claude.ai/design.

> **Read [`21-visual-language.md`](./21-visual-language.md) alongside this.** It refines this document after the running app was judged on real data at 1440px and 390px, in both languages. Where the two disagree, 21 wins and this file has been brought into line — the type scale (§3), elevation and the selection surface (§4) are the sections it changed.

This is the contract every screen inherits. Read it before building a new surface. If you find yourself typing a hex code, a font size or a corner radius, stop — the value you want is already a token, and if it genuinely is not, add it here first.

The tokens live in `src/app/globals.css` under `Fairfame Design System`. The shared components live in `src/components/ds/`. `src/app/(app)/dashboard` is the reference implementation.

---

## 1. The three rules that decide most arguments

1. **Rank the page.** Blocks are not equal. A dashboard of ten same-sized cards makes the reader do the prioritising, and they will get it wrong. Home is five ranked blocks: briefing → trend + queue → breakdown + supporting reads → activity.
2. **Hairline first.** A card is white with a 1px `--line` border and no shadow. Elevation means "this floats above the page", and it is now a four-step language (`--elevation-xs` … `--elevation-lg`, plus `--elevation-selected`) so the things that genuinely float have somewhere to go — see `21` §3. Each step is *two* shadows, a tight contact one and a wide ambient one; a single blur at any radius reads as a smudge, which is what the old one-line `--elevation-md` looked like under a dropdown. A card still gets none of them.
3. **Never say it in colour alone.** Every delta, bar, chip and slice restates its direction in words. This is WCAG 1.4.1, and it is also just clearer.

---

## 2. Colour

Cool, indigo-led, low-chroma. Utility names read as the role, not the swatch.

| Role | Token | Utility | Value |
|---|---|---|---|
| Interaction | `--indigo-600` | `bg-primary`, `text-primary` | `#3D5AF1` |
| Interaction, hovered | `--indigo-700` | `hover:bg-indigo-700` | `#2E45C4` |
| Ratings, highlights | `--amber-500` | `bg-amber-500` | `#F5A524` |
| Text, and the one dark surface | `--ink-800` / `--ink-900` | `text-foreground`, `bg-rail` | `#10193A` / `#0E1734` |
| Page | `--canvas` | `bg-canvas` | `#F6F7FB` |
| Card | `--surface` | `bg-card` | `#FFFFFF` |
| Inputs, meter tracks | `--surface-sunken` | `bg-surface-sunken` | `#F5F7FA` |
| Card hairline | `--line` | `border-line` | `#E7EAF3` |
| Between rows in a list | `--line-soft` | `border-line-soft` | `#F3F5FA` |
| Between cells in one card | `--line-inner` | `border-line-inner` | `#EFF1F7` |

**Indigo carries interaction and nothing else** — links, primary buttons, the active nav pill, the chart line. It does not mean "good". Positive sentiment is `--sentiment-positive`, and conflating the two makes every later change a guess about which meaning was intended.

**Amber is reserved** for ratings, neutral sentiment and highlights. It is never a surface and never a button on white. The only two amber controls in the product are on ink: the briefing bar's CTA and the trial footer's.

**Sentiment is muted on purpose.** Saturated green/red reads as an alarm system, not as reputation. Where a hue sits behind small text, pair it with its ink variant — the `--state-*-bg` / `--state-*-text` pairs are pre-matched and clear 4.5:1 *on the wash*, which is stricter than clearing it on white.

**A rating is an ordered scale**, not three categories. Five rungs, green → olive → amber → orange → red (`--rating-5` … `--rating-1`), each the lightest value of its hue that still clears 4.5:1.

**`--text-faint` (`#666E88`) is the lightest ink that clears AA on a *tinted* surface** — 5.06:1 on white, 4.73:1 on `--canvas`, 4.57:1 on `--surface-selected`. On a white card `--ink-400` (`#6B7391`, 4.68:1) is lighter still and legal; on anything tinted it is not. That is why the rule below is a table rather than a single "lightest" token. *(The figure here read 4.54:1 until 6 Aug 2026, which matched no surface in the product — a prose ratio that had drifted from its hex, which is the exact failure `tests/lib/design-contrast.test.ts` exists to catch and had not been asked about.)*

`--graphic-faint` (`#8B93AC`, 3.06:1) is one step below the text floor and is for **non-text only**: chart axis ticks, legend dots, disabled glyphs. Using it for a timestamp is an accessibility bug, not a taste call.

---

**Text contrast is a table, not a token.** Every surface is a different tint, so the lightest ink that clears WCAG AA as body text depends on what it sits on: `--ink-400` on a white card, `--ink-350` on `--canvas`, `--surface-sunken`, `--surface-selected` or `--surface-hover`, `--ink-500` on a segmented control's trough. Anything darker is fine; lighter is not. `--ink-300` is non-text only, and only on white. `tests/lib/design-contrast.test.ts` enforces all of it — a palette edit that breaks a ratio fails the build rather than shipping.

## 3. Type

**Amended 6 Aug 2026 — the scale was re-spaced. See [`21-visual-language.md`](./21-visual-language.md) §1, which is the authority; the table below is kept in step with it.**

The old scale ran `body` 13.5 · `copy` 12.5 · `meta` 11 · `eyebrow` 10.5 — four roles inside a 3px band, so a card title, a customer's sentence and a timestamp all read as one grey texture. `display` (25) also lost to `metric` (28), which put every page below its own statistics. Neighbouring steps now differ by ~1.12–1.25× instead of ~1.04×, and sizes are whole or half pixels only.

Geist everywhere, Geist Mono for numerals that need to align.

| Role | Utility | Size | Used for |
|---|---|---|---|
| Poster | `text-poster` | clamp(36→68) / 650 / −0.036em | **The marketing front door only** (`/`). The one fluid role in the scale, because it spans the viewport rather than a 1280px column. |
| Hero | `text-hero` | 34 / 650 / −0.032em | **Public surfaces only.** Never in the app. Section headings on `/`. |
| Marketing body | `text-marketing` | 17 / 1.6 | **Public surfaces only.** The scale below is an *Operate* scale; 14px body on a page whose job is persuasion reads as a settings screen. |
| Display | `text-display` | 27 / 650 / −0.028em | The one `<h1>`. `PageHeader` owns it. Outranks a metric. |
| Card title | `text-title` | 14.5 / 600 | Every card heading, every button. |
| Lead | `text-lead` | 15 | A sentence that **is** the subject of its row — a review in the list. |
| Body | `text-body` · `text-copy` · `text-meta` | 14 · 13 · 11 | Page body · inside a card · timestamps and legends. |
| Micro-caps | `text-eyebrow` | 10.5 / 600 / 0.08em / uppercase | The only label style on a data surface. Use `<Eyebrow>`. |

Numerals: `text-metric` (28 / 650, `tabular-nums`) via `<Metric>`, and `text-metric-lg` (38) for the single hero statistic on a dashboard — never a second one.

**`cn()` must know about every one of these.** Tailwind puts font-size and text-colour in one `text-*` namespace, and `tailwind-merge` separates them from a table of Tailwind's *defaults* — which none of these are. Until it was configured, `cn("text-eyebrow", "text-faint")` silently dropped the size and the element fell back to 16px, product-wide. Adding a `--text-*` token means adding it to `FONT_SIZES` in `src/lib/utils.ts`; `tests/lib/class-merge.test.ts` fails if you forget.

**Geist with `tabular-nums` for headline numbers; Geist Mono for deltas, counts, ranges and axis labels.** Both are about alignment — a proportional 1 next to a proportional 7 makes a column of numbers shuffle sideways on every sync.

**Sentence case everywhere** — headings, buttons, menu items, badges. The micro-caps label is the single exception, and it is uppercased in CSS so the `İ`/`ı` problem stays the browser's.

---

## 4. Space, corners, motion

- **Layout:** 232px rail · 56px top bar · 24px page gutter · **14px gap between every block** · 1280px content max. All tokens: `--rail-width`, `--topbar-height`, `--page-gutter`, `--grid-gap`, `--content-max`.
- **Card padding:** 16px vertical / 18px horizontal, as `--card-py` / `--card-px`. Split so a full-bleed child can cancel the horizontal one.
- **Corners:** 14px blocks (`rounded-lg`) · 9px controls (`rounded-md`) · 7px chips (`rounded-sm`) · `rounded-full` for numeric counts. 22px on the logo tile only.
- **Motion:** 120ms hover, 180ms for anything that moves, `cubic-bezier(.2,.7,.3,1)`. No springs, no bounce, **no entrance animation on data** — a number that changes just changes.
- **Hover:** indigo darkens 600 → 700; tinted surfaces deepen; rows lift text from secondary to primary. Never fade a primary button on hover — a washed-out primary reads as disabled.
- **Selected is not hover.** `--surface-selected` (indigo) says "you are here"; `--surface-hover` (grey) says "your pointer is here". They were the same grey at two opacities, which made a selected row invisible under the pointer. A selected list row also carries a 3px indigo bar in its gutter — a 4% wash does not survive being looked at from across a desk.
- **Press:** 1px nudge down, no scale. **Focus:** one ring everywhere, `--focus-ring`, keyboard only.

---

## 5. Components

Reach for these before writing a div. All from `@/components/ds/*`.

| Component | What it is |
|---|---|
| `SectionCard` | **The standard block.** Icon tile, 14px title, optional meta, and a `link` or `action` on the right. Nearly every card should be this. `flush` drops body padding for charts and full-bleed lists. |
| `Eyebrow` | The micro-caps label. |
| `Metric` / `Delta` | A headline number, and the change beside it. `Delta`'s `direction` is *did it move in a good direction*, not *did it go up* — a falling response time is an improvement. |
| `IconTile` | Tinted rounded square behind a Lucide glyph. Tone says what kind of thing this is: `muted` neutral · `accent` action · `rating` stars · `negative` attention · `solid` the AI briefing, and nothing else. |
| `Meter` / `SentimentBar` / `LegendItem` | Labelled proportion bars. Use these instead of a bar chart — this is a div with a width, and it costs no client bundle. |
| `Stars` | Typographic ★☆, **amber by default** (`--rating`), with an unfilled track at `--graphic-faint`. Inherits size, not colour: this is a product about ratings and the rating used to render in body ink everywhere except the one call site that had noticed. `size` is `sm` · `default` · `lg`. |
| `EmptyState` | The one layout for "there is nothing here yet", in three tones — `blank` (nothing exists; brand tile and one action), `resting` (waiting for a *selection*, not empty; muted, no action), `filtered` (data exists, the filter excluded it; the action clears it). Four hand-built variants preceded it. |
| `Segmented` | The segmented control, as links. For state the **server** needs. |

**URL or local state?** The URL owns what the server needs to know — the Home range changes what is fetched, so it is a link and `Segmented` renders it. Local state owns *which of several things already on the page* you are looking at — the breakdown card ships all three panels with the page, so its tab strip is Radix `Tabs` and switching costs a CSS change rather than a round trip. Putting that in the URL made every tap re-render a page that already had the answer.

Shared shadcn primitives (`ui/card`, `ui/button`, `ui/badge`) are already bent to these tokens, so an untouched component comes out looking like the system. `Badge` has semantic variants: `positive`, `negative`, `rating`, `accent`, `count`, `count-urgent`. `Button` adds `brief` — amber on ink, for the two dark surfaces only.

---

## 6. Charts

- **Rating always on a fixed 1–5 axis.** Never auto-scaled: a 4.2 → 4.6 move must not look like a cliff.
- Volume as soft indigo bars behind the line; the range average as a dashed hairline.
- **Every chart needs a text equivalent.** A chart is an image to a screen reader, and Recharts draws nothing at all before hydration. Use `ChartFallback`: one table, hidden by `.chart-fallback`, revealed by the `<noscript>` stylesheet in `app/layout.tsx`.
- **Never put markup inside a `<noscript>`.** Only a `<style>`. A browser *with* scripting parses `<noscript>` content as raw text, so any element React streams into it never becomes a DOM node — its streaming renderer then throws `Cannot read properties of null (reading 'parentNode')` from `$RS`, once per row. That is exactly what a `<noscript><table>` did here, and it is silent in a buffered render and only appears when the response actually streams.
- Prefer a `Meter` row to a chart library. Recharts is worth its bundle for the reputation line; it was not worth it for three horizontal bar charts, which is why those are now divs.

---

## 7. Content

- **Turkish and English are equals.** TR is the launch locale; design for TR strings running ~30% longer than EN. All copy through `next-intl`.
- **Second person, informal-professional.** "22 reviews are waiting for a reply". Never "we noticed".
- **Locale-formatted numbers.** TR uses a decimal comma and a leading percent (`3,7`, `%67`). Deltas print magnitude only — the arrow carries the sign. Point scales say "points" so a 5-point move is not read as 5%.
- **Honesty is the house style.** "no prior period", not "0%". "no rating", not an invented average. "6 items not analysed yet", never folded into "neutral". An empty state is a result: "Nothing is waiting. Every unhappy review in this period has an answer."
- **Buttons say what they do.** "Draft a reply" only if pressing it drafts one; if it navigates, it is "Reply" and it is a link.
- **No emoji, ever.** Stars (★☆) are the only pictographic mark in the product.
- **No gradients, photography, illustration or texture.** The product's imagery is its data.

---

## 8. Known gaps

**The product has one theme, and this is it.** There is no dark mode, no `.dark` class, no `dark:` variant and no theme switcher — all of it was removed rather than left half-built, because a second palette nobody maintains drifts silently and then breaks in front of a customer. The two dark surfaces in the product (the navigation rail and the briefing bar) are *design decisions* within this one theme, not a dark theme. Do not add a `dark:` utility; if the product ever wants dark mode, it starts with a designed palette, not with variants sprinkled onto components.
- **Turbopack dev** still leaves inert `<table hidden>` wrappers on long ranges. Production is clean and nothing throws; see §6.
- **Turbopack dev** still leaves inert `<table hidden>` wrappers on long ranges. Production is clean and nothing throws; see §6.
