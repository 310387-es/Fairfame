---
name: Revira
description: Cool indigo-led, hairline-first document system — extended once, for a marketing front door that is itself the artefact.
colors:
  indigo-600: "#3D5AF1"
  indigo-700: "#2E45C4"
  indigo-100: "#DDE3FB"
  ink-900: "#0E1734"
  ink-800: "#10193A"
  ink-600: "#3A4260"
  ink-350: "#666E88"
  ink-300: "#8B93AC"
  canvas: "#F6F7FB"
  surface: "#FFFFFF"
  line: "#E7EAF3"
  line-soft: "#F3F5FA"
  line-inner: "#EFF1F7"
  amber-500: "#F5A524"
typography:
  poster:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.25rem, 5.6vw, 4.25rem)"
    fontWeight: 650
    lineHeight: 1.04
    letterSpacing: "-0.036em"
  hero:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.125rem"
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: "-0.032em"
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.6875rem"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.028em"
  metric-lg:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.375rem"
    fontWeight: 650
    lineHeight: 1
    letterSpacing: "-0.035em"
  metric:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 650
    lineHeight: 1
    letterSpacing: "-0.032em"
  lead:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    lineHeight: 1.45
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.90625rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.008em"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    lineHeight: 1.5
  copy:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    lineHeight: 1.5
  meta:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    lineHeight: 1.4
rounded:
  sm: "7px"
  md: "9px"
  lg: "14px"
  full: "9999px"
spacing:
  card-px: "18px"
  card-py: "16px"
  grid-gap: "14px"
  page-gutter: "24px"
  content-max: "1280px"
  marketing-measure: "1152px"
  margin-column: "17rem"
  margin-gutter: "40px"
components:
  button-primary:
    backgroundColor: "{colors.indigo-600}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    typography: "{typography.title}"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.indigo-700}"
  card-hairline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-800}"
    rounded: "{rounded.lg}"
  margin-note:
    backgroundColor: "transparent"
    textColor: "{colors.ink-350}"
    typography: "{typography.copy}"
  masthead:
    backgroundColor: "{colors.ink-900}"
    textColor: "{colors.surface}"
    height: "56px"
---

# Design System: Revira

> **This file is a pointer, not an authority.** The design system is
> [`docs/15-design-system.md`](docs/15-design-system.md), refined by
> [`docs/21-visual-language.md`](docs/21-visual-language.md); **where 15 and 21 disagree, 21
> wins.** The normative token values live in `src/app/globals.css` under `Revira Design
> System`, the shared components in `src/components/ds/`, and three tests enforce them
> (`design-tokens`, `design-contrast`, `class-merge`). The frontmatter above mirrors that
> source for tooling; if it ever disagrees with `globals.css`, `globals.css` is right.
>
> What follows is only the **delta** — what the marketing front door at `/` added to the
> system, or taught it, that is not already in 15 or 21. Everything unstated here is
> unchanged and governed there.

## Overview

**Creative North Star: "The Annotated Document"**

Revira's system was built entirely for **Operate** surfaces — a review queue, a dashboard,
an analytics workspace — where the reader already believes the product and needs to work.
The landing page at `/` is the first **Persuade** surface, and it was built without
softening a single rule: same tokens, same hairlines, same refusal of imagery. The delta is
therefore small on purpose. One new type role, one scoped stylesheet block, and one new
layout pattern.

The page's thesis is that it **is** the artefact. It renders a real weekly briefing from
`getSampleDigest()` — the same pipeline, arithmetic and model that runs on a customer's own
reviews — and puts the marketing argument in the **margins** beside it, each note anchored
to the element it explains. It refuses the category arrangement of a slogan over a
device-framed screenshot followed by three feature cards, and it refuses it structurally:
there is no screenshot to frame and no card grid to fill.

Two things carried across from Operate that a marketing surface would normally abandon, and
both held. **Zero raster** — `docs/15` §7's "the product's imagery is its data" survives on
a surface whose category default is photography, and the built page contains no photograph,
illustration, gradient or texture of any kind. And **hairline-first** — the briefing card,
the pricing table and the disclosure notice all carry a 1px `--line` border and no shadow,
on a page where floating cards are the convention.

**Key Characteristics:**
- Marginalia instead of feature cards; the argument sits beside its evidence, never three screens from it.
- One fluid type role, and it exists only here.
- Evidence discloses in place; the page never links away to prove a claim.
- The artefact is composed live, not screenshotted.
- Alternating density: an annotated spread, then a quiet full-width section that earns it.

## Colors

The palette is unchanged. What this build settled is **which parts of it a Persuade surface
may use**, and the answer is narrower than the app's.

### Primary
- **Interaction Indigo** (`indigo-600`): the same single job it has everywhere — the primary CTA, action numerals, the evidence disclosure link, the short rule above a margin note. It is the only saturated colour in the page's chrome.

### Neutral
- **Masthead Ink** (`ink-900`): both dark passages — the masthead bar and the conscience band. The front door is ink because the product's own rail and briefing bar are ink; it should read as a piece of the application, not as marketing bolted onto it.
- **Faint Ink** (`ink-350`): every margin note body, every secondary description. The page background is `--canvas`, so this is the *lightest legal ink here* — `ink-400` measures 4.37:1 on a tinted surface and misses AA. This is the table in `docs/15` §2 doing real work on a new surface.

### Named Rules

**The No-Amber-Chrome Rule.** Amber is a *rating* colour and nothing else on this surface.
There is no amber button, no amber surface and no amber highlight anywhere on `/` — but the
star ratings inside the evidence disclosure render in the system's amber, because `Stars`
is amber by default and a rating drawn in ink would be a different lie. *(The direction
contract's OWN-WORLD line reads "no amber" flatly; the build diverges, correctly. Amber on
a rating is native to this world and banning it would have meant repainting the one mark
the product treats as pictographic.)*

**The Marketing Selection Rule.** `.marketing ::selection` is indigo at its lightest tint
(`indigo-100`) with `ink-900` on top. Scoped to `.marketing` rather than set globally: a
selection colour that suits a landing page is not automatically the right one behind a
review queue somebody drags a cursor through all day.

## Typography

The scale is `docs/21` §1's, unchanged, plus **one new role at the top**.

### Hierarchy
- **Poster** (650, `clamp(2.25rem, 5.6vw, 4.25rem)` → 36–68px, −0.036em, 1.04): **the marketing front door only.** The one fluid role in the entire scale.

Everything below it — hero, display, metric-lg, metric, lead, title, body, copy, meta — is
as `docs/21` defines it and is not restated here.

### Named Rules

**The Poster Rule.** `--text-poster` is the only fluid role in the scale, and it is fluid
because it is the only role that spans the **viewport** rather than a 1280px content column
— it has to survive 390px to 1920px, where every other role lives at a predictable measure.
It is clamped so it cannot exceed 68px or drop below 36px, the point at which it stops
outranking the briefing card beneath it. **Never use it inside the app**: a dashboard has
one subject and `display` names it.

**The Artefact-Does-Not-Shout Rule.** The briefing card's own headline is set at `display`,
not `hero`, precisely because the page's headline above it is at `poster`. An artefact that
shouts as loudly as the page is an artefact competing with its own argument.

**The Registered-Role Rule.** Adding a `--text-*` token means adding it to `FONT_SIZES` in
`src/lib/utils.ts`, or `cn()` silently drops the size and the element falls back to 16px.
`--text-poster` is registered; `tests/lib/class-merge.test.ts` fails if the next one is not.

## Layout

**The marketing measure is 1152px (`max-w-6xl`), not the app's 1280px `--content-max`.** The
app's width is sized for a rail plus dense tables; a document read straight on wants a
narrower column, and the page sets it consistently on every section, the masthead and the
footer.

**The annotated spread** is the page's one layout primitive (`Spread` in
`src/components/marketing/spread.tsx`): a `minmax(0,1fr)` content column and a **17rem**
margin column, 40px apart, collapsing at **`lg`**. The breakpoint is `lg` and not `md`
deliberately — below roughly 1024px there is not enough width left for the artefact to keep
a comfortable measure beside a 17rem note, and a margin squeezed to 9rem stops reading as
apparatus and starts reading as a second, narrower body. Below `lg` the note simply follows
its anchor in the flow, which is the correct mobile reading order anyway: thing, then note
about the thing.

Vertical rhythm between major sections is 80px (`pt-20`), and the conscience band breaks it
with 64–80px of its own internal padding.

### Named Rules

**The Alternating Density Rule.** An annotated spread is the page's dense passage; a
full-width section with no margin note is the quiet one that earns it. Two annotated
sections in a row exhaust the device, and two identical two-column lists in a row read as
one section repeated — which is why delivery is four across and the product areas are six
in two-to-three columns. Absence of a margin note is rhythm, never omission.

**The Marginalia-Means-One-Thing Rule.** A margin note glosses the artefact. It must not
degenerate into a second column of body copy, which is what happens the moment every
section gets one.

## Elevation & Depth

Unchanged, and worth restating because a marketing surface is where it usually breaks:
**hairline first**. Every container on `/` — the briefing card, the pricing table, the score
tile, the invented-café notice — is a 1px `--line` border on white with **no shadow at
all**. The only shadow on the page is on the skip-to-content link when it takes focus.

Depth comes from tonal layering instead: `--canvas` page, white cards, and two `ink-900`
passages that read as the page's structural anchors.

## Shapes

Unchanged: 14px blocks, 9px controls, 7px chips, `rounded-full` for numeric counts. The
page's own signature geometry, all built from those steps:

- **The short indigo rule** above each margin note — 24px wide, 2px tall, `rounded-full`. The whole visual identity of an annotation, in place of a box.
- **Indigo circled numerals** on action rows — 24px `rounded-full`, white numeral at `meta`/600. Deliberately **not** monospaced: a numeral in a circle is not code, data or a measurement, and monospace as a costume for "technical" is the tell.
- **Hairline separators** between action rows (`line-soft`), between the artefact's header and its actions (`line-inner`), and above every item in the delivery and product lists — the same hairline vocabulary doing the work a card grid would otherwise do.

## Components

### Margin Note (signature)
- **Character:** apparatus, not content.
- **Structure:** a 24×2px indigo rule, a `copy`/600 title at full ink, a `copy` body at `ink-350`.
- **No box, no border, no fill.** A card is the lazy container: give every argument the same rounded box and the page becomes a grid of equals, which is the arrangement this direction refuses. A note with smaller type in lighter ink under a short rule is what an annotation looks like in a printed document, and it is legible as apparatus rather than as content competing with the artefact.
- **Stacked, never sticky.** One note can follow a reader down a long block; a stack of three cannot — they collide with each other and with the next section's margin the moment the column runs out.

### Evidence Disclosure (signature)
- **Character:** the page's one interaction, and its one authored motion moment.
- **Mechanism:** `<details>`/`<summary>`, no JavaScript, no ARIA. Keyboard-operable and correctly announced for free, works with scripts off, and stays open.
- **Summary:** `copy`/500 indigo, underline on hover, a chevron that rotates 180° when open.
- **Motion:** `.evidence-reveal` — opacity plus a 2px lift over `--duration-base` (180ms) on `--ease-out`, disabled under `prefers-reduced-motion`.

### Briefing Card
- **Corner:** 14px. **Border:** 1px `--line`. **Shadow:** none.
- **Score tile:** a hairline-bordered box holding `metric-lg` tabular numerals over `/100`. **Never banded by threshold** — indigo means interactive and amber means a rating, and a composed 0–100 score is neither. The sentence beneath carries the judgement.
- **Absent score is a sentence, not an em-dash.** Somebody who has not read `MIN_REVIEWS_FOR_PULSE` reads a dash as a rendering failure and concludes the gauge is broken.

### Pricing Table
- **Four columns divided by hairlines inside one 14px card**, not four floating cards. This page is a document, and a spec table is what a document uses to compare things.
- **No "most popular" flag** — there are no customers yet, so it would be invented.

### Conscience Band
- Full-bleed `ink-900`, `hero` heading at `--text-on-ink`, body at `--text-on-ink-muted`, internal divider at 12% white. The page's one dark passage after the masthead, placed where a dense white document needs somewhere to breathe.

## Do's and Don'ts

### Do:
- **Do** treat `docs/15` + `docs/21` as the authority and this file as the delta. A rule that belongs to the whole product goes there, not here.
- **Do** use `--text-poster` on the marketing front door and nowhere else; register any new `--text-*` role in `FONT_SIZES`.
- **Do** scope a Persuade-only stylesheet rule under `.marketing`. Motion and selection colour chosen for a landing page are not automatically right behind a review queue.
- **Do** compose the artefact live from the real pipeline. A picture of a briefing forfeits the entire claim the page makes.
- **Do** derive commercial copy from what the product enforces — the pricing table diffs `PLAN_CATALOG`, so the page is wrong only when the product is wrong.
- **Do** label an invented business as invented, above the artefact and in full ink, and make the claim conditional on what actually happened: when the model was unreachable and the briefing fell back to written prose, the sentence asserting "same model, same arithmetic" must change with it.
- **Do** keep `ink-350` as the floor for text on `--canvas`; `ink-400` is legal on white cards only.

### Don't:
- **Don't** put a margin note beside every section. Its meaning is "a gloss on the artefact", and it survives only while that is true.
- **Don't** give a margin note a border, a fill or a card. The absence of a box *is* the pattern.
- **Don't** make the annotated spread collapse at `md`. A 17rem margin squeezed to 9rem is a second body column, not an annotation.
- **Don't** add a shadow to a marketing card. Hairline-first is not an app-only rule.
- **Don't** introduce photography, illustration, gradient or texture on a marketing surface. `docs/15` §7 holds here; the category default does not override it.
- **Don't** link away to prove a claim. Evidence opens in place.
- **Don't** set the artefact's own headline at `poster` or `hero` to match the page. It is the subject, not the argument.
