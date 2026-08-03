# 15 — Design system

**Status:** in force as of 3 Aug 2026. Imported from the approved Home redesign (option **1a**) in the `Revira home page redesign review` project on claude.ai/design.

This is the contract every screen inherits. Read it before building a new surface. If you find yourself typing a hex code, a font size or a corner radius, stop — the value you want is already a token, and if it genuinely is not, add it here first.

The tokens live in `src/app/globals.css` under `Revira Design System`. The shared components live in `src/components/ds/`. `src/app/(app)/home` is the reference implementation.

---

## 1. The three rules that decide most arguments

1. **Rank the page.** Blocks are not equal. A dashboard of ten same-sized cards makes the reader do the prioritising, and they will get it wrong. Home is five ranked blocks: briefing → trend + queue → breakdown + supporting reads → activity.
2. **Hairline first.** A card is white with a 1px `--line` border and no shadow. Elevation means "this floats above the page" and only two things do: a menu (`--elevation-md`) and the active pill in a segmented control (`--elevation-sm`).
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

**The lightest text allowed is `--text-faint` (`#666E88`, 4.54:1).** `--graphic-faint` (`#8B93AC`, 3.06:1) is one step below the text floor and is for **non-text only**: chart axis ticks, legend dots, disabled glyphs. Using it for a timestamp is an accessibility bug, not a taste call.

---

## 3. Type

Geist everywhere, Geist Mono for numerals that need to align. **Four roles and no more.**

| Role | Utility | Size | Used for |
|---|---|---|---|
| Hero | `text-hero` | 32 / 600 / −0.03em | **Public surfaces only.** Never in the app. |
| Display | `text-display` | 25 / 600 / −0.025em | The one `<h1>`. `PageHeader` owns it. |
| Card title | `text-title` | 14 / 600 | Every card heading. |
| Body | `text-body` · `text-copy` · `text-meta` | 13.5 · 12.5 · 11 | Page body · inside a card · timestamps and legends. |
| Micro-caps | `text-eyebrow` | 10.5 / 600 / 0.08em / uppercase | The only label style on a data surface. Use `<Eyebrow>`. |

Plus one numeral role: `text-metric` (28 / 600 / −0.03em, `tabular-nums`) via `<Metric>`.

**Geist with `tabular-nums` for headline numbers; Geist Mono for deltas, counts, ranges and axis labels.** Both are about alignment — a proportional 1 next to a proportional 7 makes a column of numbers shuffle sideways on every sync.

**Sentence case everywhere** — headings, buttons, menu items, badges. The micro-caps label is the single exception, and it is uppercased in CSS so the `İ`/`ı` problem stays the browser's.

---

## 4. Space, corners, motion

- **Layout:** 232px rail · 56px top bar · 24px page gutter · **14px gap between every block** · 1280px content max. All tokens: `--rail-width`, `--topbar-height`, `--page-gutter`, `--grid-gap`, `--content-max`.
- **Card padding:** 16px vertical / 18px horizontal, as `--card-py` / `--card-px`. Split so a full-bleed child can cancel the horizontal one.
- **Corners:** 14px blocks (`rounded-lg`) · 9px controls (`rounded-md`) · 7px chips (`rounded-sm`) · `rounded-full` for numeric counts. 22px on the logo tile only.
- **Motion:** 120ms hover, 180ms for anything that moves, `cubic-bezier(.2,.7,.3,1)`. No springs, no bounce, **no entrance animation on data** — a number that changes just changes.
- **Hover:** indigo darkens 600 → 700; tinted surfaces deepen; rows lift text from secondary to primary. Never fade a primary button on hover — a washed-out primary reads as disabled.
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
| `Stars` | Typographic ★☆, inheriting colour and size. |
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
