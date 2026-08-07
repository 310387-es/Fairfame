# 21 — Revira's visual language

**Status: in force from 6 Aug 2026.** This refines `docs/15-design-system.md`; it does not
replace it. Where the two disagreed, this file won and **15 has been brought into line** —
its type scale, elevation, contrast and component tables now match what is below, so the two
can be read in either order.

Judged against the running app on real data (65 Turkish reviews, 32 analysed), at 1440px and
390px, EN and TR. Every rule below is a response to something that was actually on screen.

§0b names where each pattern came from, including the ones deliberately **not** taken from
the category — that section is the argument for the product's visual posture, not a
bibliography.

---

## 0. What was wrong, precisely

Not the token architecture — that is good, and better reasoned than most.

**0a. First, a bug that was masquerading as a design problem.** `cn()` was deleting the type
scale at runtime. Tailwind puts font-size and text-colour in one `text-*` namespace and
`tailwind-merge` tells them apart from a table of Tailwind's *default* scale — but every size
here is a custom `@theme` token and so is every ink, so it recognised neither, filed both as
one ambiguous group, and applied last-one-wins:

```
cn("text-eyebrow text-faint uppercase")   ->  "text-faint uppercase"
cn("text-copy", "text-muted-foreground")  ->  "text-muted-foreground"
```

The size never reached the DOM and the element fell back to the inherited **16px**. `Eyebrow`
— whose entire purpose is to be 10.5px so that a metric's number outranks its label — was
rendering at 16px on every tile in the product. No build error, no console warning, correct
markup, correct colour. It also explains why one token looked right in some places and wrong
in others: `ChipGroup` writes its classes as a single literal string and never goes through
the merge, so filter labels were correctly tiny while metric eyebrows beside them were not.

Fixed in `src/lib/utils.ts` with `extendTailwindMerge`; `tests/lib/class-merge.test.ts` pins
it, and its last case reads the tokens out of `globals.css` so a size added there and not
registered in `cn` fails loudly rather than silently vanishing. **Adding a `--text-*` size
means adding it to `FONT_SIZES`.**

Read the five judgements below knowing that part of "the typography is flat" was this bug
rather than the scale. They were re-checked against the running app after the fix and still
hold.

1. **The type scale had no steps.** `body` 13.5 · `copy` 12.5 · `meta` 11 · `eyebrow` 10.5 —
   four roles inside a 3px band. A card title, a customer's sentence and a timestamp all
   resolved to "small grey text", so nothing on a screen could be more important than
   anything else. Meanwhile `display` (25px, the h1) lost to `metric` (28px), so every page
   was outranked by its own statistics.
2. **Selection and hover were the same colour.** `bg-surface-sunken` against
   `bg-surface-sunken/60`. On the review list — a list you drive with `j`/`k` — you could not
   tell what you had chosen from what your pointer was over.
3. **The rating was not amber.** `Stars` inherited `currentColor`, so in a product about
   ratings the rating rendered in body ink on eleven of twelve surfaces. Exactly one call
   site had noticed and passed `text-state-rating-text` by hand.
4. **Controls outweighed content.** `/reviews` spent ~300px on six rows of filter chips
   above the queue, four of which were *duplicated* by the rail 300px below. The customer's
   words — the entire subject of the product — got one truncated line in a 19rem column.
5. **Four empty states**, four different layouts — a left-aligned card on `/conversations`,
   a centred one with a button on `/widgets`, a grey sentence on `/reviews`, and a fourth on
   the dashboard. (Three were visible at first; the fourth only turned up when the shared
   component was actually rolled out.)

None of that is a taste problem. All of it is a *hierarchy* problem, which is why it reads
as "built by engineers": every element was rendered correctly and nothing was ranked.

---

## 0b. Benchmark — what was borrowed, and from where

Every rule in this file came from somewhere. Naming the source is not credit-giving; it is
so the next person can go and look at the thing rather than argue with me about it. The
column that matters is the last one: several of these were looked at and **rejected**, and
the reasons are the more useful half.

### Queues and lists — Linear, Front, Superhuman

| Pattern | Where | Revira | Verdict |
| --- | --- | --- | --- |
| **Two-pane list + reading pane**, selection held in the URL | Front, Superhuman | `/reviews` (W4.1 already had this) | Kept |
| **Selection = tinted row + a solid bar in the gutter**, distinct from hover | All three, independently | `--surface-selected` + 3px indigo bar | **Adopted.** The convergence is the argument: three keyboard-driven inboxes landed on the same answer because a wash alone dies under a pointer |
| **Two-line rows where line 2 is the content**, not metadata | Front, Superhuman, Gmail | `ReviewRows` `line-clamp-2` | **Adopted.** This is why the column went 19rem → 23rem; one line at 19rem is ~30 characters |
| **`j`/`k` navigation, `e` to resolve** | Linear, Superhuman | Already present | Kept |
| **Filters as one composing toolbar row**, long tail behind a control | Linear's issue filters | The `<details>` disclosure | **Adopted in spirit, not in mechanism.** Linear uses a popover; this is a `<details>` because the bar is server-rendered links and works with scripts off. A popover would make it the one thing on the page that does not |
| Command palette as primary navigation (⌘K) | Linear, Notion | Already present (`search-palette`) | Kept |

### Numbers and dashboards — Stripe, Vercel

| Pattern | Where | Revira | Verdict |
| --- | --- | --- | --- |
| **Small-caps label above a large number**, label losing decisively | Stripe's dashboard | `Eyebrow` + `Metric` — the intent was already here and the `cn()` bug was silently defeating it (§0a) | Kept, and finally working |
| **Tabular numerals in any column that refreshes** | Stripe | `tabular-nums` throughout | Kept |
| **Near-monochrome plus one accent**; status as dot + word | Vercel | §2's colour discipline; the priority dot on a review row | **Adopted.** Vercel is the discipline this file is arguing for: if you cannot say which question a colour answers, it should be ink |
| Geist as the typeface | Vercel ships it | Already the product's font | Noted — worth knowing the type scale here is being applied to the family Vercel designed for exactly this density |
| **Sparklines with no axis are decoration** | Stripe uses them sparingly, always beside the number they describe | `VolumeSparkline` / `TrendSparkline` | Partly. The four on Home still carry no readable information — priority 6 fixed their *colour* contradiction, not the question of whether they earn the space |

### Pricing — Stripe, Vercel, Linear

| Pattern | Where | Revira | Verdict |
| --- | --- | --- | --- |
| **Price at display size**, plan name demoted to a label | All three | `plan-section.tsx`, price at `text-metric` | **Adopted** |
| **The current plan is visually held**, not just badged | Stripe's billing settings | Indigo border + ring | **Adopted** |
| **One emphasised action**; downgrades are quiet | All three | Indigo for upgrades, outline for downgrades, derived from catalogue order | **Adopted** |
| A "Most popular" flag on a middle tier | Common across SaaS pricing | — | **Rejected.** It is a marketing claim, and inventing one is a pricing decision rather than a design one. The current plan is the only tier this screen has a truthful reason to emphasise |

### Empty and resting states — Notion, Linear

| Pattern | Where | Revira | Verdict |
| --- | --- | --- | --- |
| **Icon, one sentence, one action** — never a paragraph | Notion | `EmptyState` `blank` | **Adopted** |
| **A waiting pane is not an empty pane** | Superhuman's reading pane before selection | `EmptyState` `resting` | **Adopted.** This is the distinction that was missing: `/reviews` dressed "pick one of sixty-five" as a first-run screen |
| Illustrated empty states | Intercom, most of the category | — | **Rejected**, and it was asked for. `docs/15` §7: "the product's imagery is its data". An `IconTile` says the same thing and does not commit us to commissioning artwork for every future screen |

### The category — Birdeye, Podium, Trustpilot, Yotpo

This is where benchmarking is most useful, because the competitors' shared instinct is one
Revira should deliberately not follow.

| Pattern | Where | Verdict |
| --- | --- | --- |
| **Dashboard-first: gauge clusters, donut breakdowns, dense KPI grids** | Birdeye and Podium both lead with reporting density | **Rejected, and it is the product's main visual argument.** That layout answers "how are we doing"; Revira's differentiator is the Action Digest, which answers "what should I do on Monday". A wall of gauges is the *posture* of a reporting tool, and adopting it would flatten the one thing that is not commodity. It is also why `/weekly-plan` now leads with the plan rather than a list of dates |
| Review cards with **amber stars, source attribution, and a date** | Trustpilot, and the category convention | **Adopted** — this is settled convention and deviating would only cost recognition. It is also the argument for `Stars` being amber by default rather than inheriting ink |
| **Widget-first social proof layouts** | Yotpo | Already built (P3-T0/T1), and the widget's separate palette is the right call for the same reason theirs is: it renders on somebody else's site |
| Star-rating *inputs* drawn large and unfilled until touched | Trustpilot, Google | Already how `/c/{slug}` works | Kept |

### What none of them solved for us

Two constraints these references cannot help with, which is why several rules in this file
have no row above:

- **Turkish.** Every product named here is designed English-first. TR runs ~30% longer, and
  the two layout bugs this pass found — the meter column and the delta breaking mid-unit —
  are invisible in every one of them. §8 exists because the benchmark set has nothing to say
  here.
- **Surfaces we cannot look at.** An email, a PDF, a widget on a stranger's page. Linear does
  not have a weekly PDF; Stripe's emails are a different discipline from its dashboard. Four
  of the bugs in this pass lived on exactly these surfaces, and the guard is tests
  (`email-palette`, `report-metrics`, `report-contrast`, `widget-theme`) rather than taste.

## 1. Type

Eight roles, re-spaced so neighbouring steps differ by ~1.12–1.25× instead of ~1.04×. Sizes
are whole or half pixels only.

| Token | Size | Use | Never |
| --- | --- | --- | --- |
| `text-hero` | 34 / 650 / −0.032em | Public marketing + document surfaces only | Inside the app |
| `text-display` | 27 / 650 / −0.028em | The page `h1`. One per page | A card title |
| `text-metric-lg` | 38 / 650 | **New.** One hero number per dashboard | Any second number |
| `text-metric` | 28 / 650 | A headline number in a tile | Body copy |
| `text-lead` | 15 / 1.45 | **New.** A sentence that *is* the subject of its row | A label |
| `text-title` | 14.5 / 600 | Every card title, every button | A paragraph |
| `text-body` | 14 / 1.5 | Page body | Inside a dense card |
| `text-copy` | 13 / 1.5 | Body inside a card, list rows | A page's main prose |
| `text-meta` | 11 / 1.4 | Timestamps, legends, counts | Anything a decision rests on |
| `text-eyebrow` | 10.5 / 600 / 0.08em caps | The **only** label style on a data surface | Sentence case |

**Rules.**

- `13.5px` is gone. Fractional sizes render differently per browser for no benefit, and
  Turkish is the launch locale: `ğ ş ı İ` lose their distinguishing marks first, and TR runs
  ~30% longer than EN so it wraps sooner at every size.
- **Numerals are Geist with `tabular-nums`** wherever they sit in a column or refresh in
  place. **Deltas, counts, ranges and axis labels are Geist Mono.** A number is data; a name
  is prose.
- Uppercasing happens in CSS, never in the catalogue — `İ`/`ı` casing is the browser's
  problem, not a translator's.
- Eyebrow tracking stays at **0.08em**. 0.09em was tried, looks marginally better in
  isolation, and pushed "REPUTATION SCORE" onto a second line in the dashboard's metric strip.
  An eyebrow sits in the narrowest column on any data surface, so its tracking is a layout
  value rather than a typographic preference.

## 2. Colour, with intent

Each of the four families answers exactly one question. If you cannot say which question a
colour is answering, it is decoration and should be ink.

- **Indigo — "this is interactive, or this is chosen."** Primary buttons, links, the focus
  ring, the selected row's wash and bar, the active chip. Never a chart's default series
  when the chart is not about us. Never a status.
- **Amber — "this is a rating."** Stars, the rating scale, the neutral sentiment band, and
  the single CTA on the dark briefing bar (where indigo disappears). **Never a surface,
  never a warning.** Warnings are not amber here; a warning is a state, and states have
  their own pairs.
- **Neutrals — everything else.** `--canvas` behind, `--surface` on top, `--line` between.
  Text follows the contrast *table*, not a token: lightest legal ink is `--ink-400` on
  white, `--ink-350` on `--canvas`/`--surface-sunken`, `--ink-500` on `--surface-segmented`.
- **Semantic pairs — "this is a state."** `--state-{positive,negative,rating,accent}-{bg,text}`,
  always used as a pair, because each ink clears 4.5:1 *on its own wash* — a stricter test
  than clearing it on white.

**Sentiment is not `--primary`/`--destructive` in disguise.** `--sentiment-*` means "what
customers felt"; `--destructive` means "what this button does". Conflating them makes every
later change a guess about which was meant.

**Two files may type a literal hex, and both say why in their own comment:**
`src/widgets/theme.ts` (a widget renders on a stranger's site where `globals.css` does not
exist) and `src/components/connections/provider-mark.tsx` (a brand colour is a fact about
another company). There is no third.

## 3. Surfaces, elevation, radii

**Selection ≠ hover.** Two new tokens, and they must never resolve to the same value:

```css
--surface-selected: #f0f3fe;  /* you are here */
--surface-hover:    #f1f3f9;  /* your pointer is here */
```

`--surface-selected` has its own hex rather than aliasing `--indigo-050`, and that is a
contrast decision. A selected row carries `--ink-350` for its timestamp and for the snippet
of a row already answered; on `--indigo-050` that measures **4.49:1**, missing AA for body
text by a hundredth. `--indigo-050` could not simply be lightened — it is also
`--state-accent-bg`, a badge wash doing an unrelated job — so selection took its own value at
4.57:1. Both new surfaces are in the lightest-legal-ink table in
`tests/lib/design-contrast.test.ts`.

A selected row also carries a **3px indigo bar in its gutter**. The wash alone is 4% and
disappears across a desk; the bar is what survives. (Front, Superhuman, Linear all landed
here independently — it is the one selection pattern that works in a scannable list.)

**Elevation is four steps, two shadows each.** A tight contact shadow that reads as an edge,
plus a wide ambient one that reads as height. One blur at any radius is a smudge — which is
what the old single-line `--elevation-md` looked like under a dropdown.

| Token | Reads as | On |
| --- | --- | --- |
| `--elevation-xs` | a seam | inputs, chips |
| `--elevation-sm` | resting on the page | nothing by default — see below |
| `--elevation-md` | floating | popovers, dropdowns, sheets, toasts |
| `--elevation-lg` | above everything | modals |
| `--elevation-selected` | chosen | inset indigo ring on a chosen control |

**Cards stay flat: hairline, no shadow.** A shadow means "this floats", and a card does not.
This is `docs/15`'s rule and it is right; the four steps exist so that the things which *do*
float have somewhere to go.

**Radii, four steps, unchanged:** 14 blocks · 9 controls · 7 chips · full for numeric counts.

## 4. Density

- Page gutter 24 · grid gap 14 · card padding 18/16 (14/13 at `size="sm"`).
- **A list row is two lines and the second one is the content.** ~68px. Do not go to one
  line to fit more rows: thirty characters of a review proves one exists and tells you
  nothing about it.
- **A list column is ≥ 22rem** wherever the row carries a sentence. 19rem is where the
  truncation came from.
- Controls above a queue get **one row, plus a disclosure.** If a filter bar needs more than
  one row on a 1280px screen, the long tail belongs behind `<details>` — which also keeps it
  working with scripts off, unlike a popover.

**A section's tab strip goes under the page header, never above it.** `ResourcePage`'s
`tabs` slot is the placement; `PageHeader` then `SectionTabs` is the equivalent for screens
that do not use it. Three screens had it above, on the reasonable-sounding argument that a
tab strip switches *section* while the header names the *page* — but above the title the
strip reads as chrome the title hangs off, and the page's own name comes second on its own
screen. What settled it: `/campaigns` and `/surveys` already rendered it **below** in their
locked-plan branch, so the tab strip moved up or down the page depending on the
organization's entitlement — one screen, two layouts, decided by billing.

## 5. Iconography

Lucide, `size-4` at default, `size-3` inside a chip, `strokeWidth` 1.75 for a decorative
tile and default elsewhere. **An icon never appears alone as the only label of a
destructive or irreversible control.** Provider marks are drawn geometry, not traced
trademarks — see `provider-mark.tsx`.

**Stars are the only pictographic marks in the product.** No emoji. `★☆` as characters, not
SVG, so they inherit font-size and hold the baseline; filled is `--rating`, empty is
`--graphic-faint`.

## 6. Every state

| State | Rule |
| --- | --- |
| Hover | `--surface-hover`, or indigo 600 → 700 on a primary. **Darken, never fade** — a washed-out primary reads as disabled. |
| Focus | `focus-visible` only. `ring-3` + `--ring` at 50%. One ring everywhere, including on `<summary>` and on a row that is a link. |
| Selected | `--surface-selected` + a 3px indigo gutter bar + `aria-current`. |
| Active/press | `translate-y-px`. No scale, no ripple. |
| Disabled | `opacity-45`, `pointer-events-none`. Never a colour change alone. |
| Loading | The control keeps its width and its label; a spinner replaces its icon. Never a layout shift, never a skeleton on a number that is already on screen. |
| Empty | One component — see below. |
| Error | The semantic pair, plus text. Colour is never the only carrier (WCAG 1.4.1). |

**Empty states are one component (`ds/empty-state.tsx`) with three tones**, because there is
more than one kind of nothing:

- `blank` — nothing exists yet. Brand-coloured icon tile, a title, one sentence, **one**
  action. A first run is an invitation.
- `resting` — the surface is waiting for a *selection*, not empty. Muted, no action. This is
  the review detail pane, and dressing it as a first-run screen told people the opposite of
  what was true: there were sixty-five reviews 200px to the left.
- `filtered` — data exists, the filter excluded it. The action clears the filter.

## 7. Motion

`--duration-fast` 120ms for a hover, `--duration-base` 180ms for anything that moves,
`--ease-out` `cubic-bezier(0.2, 0.7, 0.3, 1)`. **No springs, no bounce, no entrance
animation on data.** A number that changes just changes — animating it in says "look, new
information" on every re-render, including the ones where nothing happened.

`prefers-reduced-motion` removes transforms, keeps opacity.

## 8. Localisation and accessibility, which are layout constraints

- **Design in Turkish, check in English.** TR runs ~30% longer. Fixed-width label columns
  are sized for the longest TR string (`ChipGroup`'s 6rem is sized for "GÖRÜNÜMLER").
- Nothing below 390px may scroll horizontally. `e2e/mobile-layout.spec.ts` enforces it; a
  deliberately wide table must scroll *inside a container that is its containing block* —
  `relative` on that container is load-bearing, or absolutely positioned children (including
  `sr-only` labels) escape and drag the document's scroll width.
- Contrast is a table, not a token (§2). `tests/lib/design-contrast.test.ts` pins it.
- Every control reachable and visibly focused by keyboard; `e2e/keyboard.spec.ts`.

---

## 9. Priority — what to elevate, in order

Ranked by **frequency × visual weight × how much craft compounds**. The first three are
where this specific product's quality lives, because it is a *queue* product: an owner opens
Reviews, works it, and leaves.

| # | Surface / component | Why it is here | State |
| --- | --- | --- | --- |
| 1 | **The review row** | 65 instances per screen, on the screen with the most sessions. Every pixel of craft is multiplied by the length of the list, and it carries the product's only real content — the customer's words. | **Done** |
| 2 | **`/reviews` layout** | The daily driver. It was spending 300px of chrome, half of it duplicated, on top of the queue. | **Done** |
| 3 | **`Stars`** | Twelve call sites, and it is the brand's rating mark. One file. | **Done** |
| 4 | **Selection / hover / focus tokens** | Every list, table and chip in the product inherits these. Invisible individually, decisive collectively. | **Done** |
| 5 | **`EmptyState`** | Every screen has at least one, and four hand-built treatments existed. Rolled out: `ResourcePage` (which covers most list screens at once), the dashboard's two-reason empty, `/conversations` and `/reviews`. The *reasons* stay where they were — `DashboardEmpty` still distinguishes "no sources" from "a quiet week", and no shared primitive should flatten that. | **Done** |
| 6 | **The dashboard tile row** | The first thing every user sees. The `Eyebrow` fix (§0a) is most of it — the labels were 16px and outweighing their own numbers. The sparkline now follows the `Delta` beside it instead of contradicting it. | **Done** |
| 7 | **Settings → plan cards** | The page where money is asked for, and the weakest surface in the app. Price now leads at `text-metric`, the current plan is ringed, upgrades get an indigo button, and the tiers are two-up until `2xl` so 230px columns stop flattening them. | **Done** |
| 8 | **`/analytics` panels** | Second-most-viewed data surface. Both bugs fixed: the `00%` axis (a font bug, §0a's sibling — ticks rendered 16px sans) and the star histogram now uses the `--rating-5…1` ramp. The competitor caveat is a quiet note rather than a red block — it is the *expected* pre-go-live state, and red made a working screen look broken. | **Done** |
| 9 | **`/weekly-plan`** | The hero feature, rendered as four identical rows of dates — a filing cabinet, with the actual briefing two clicks from the rail. It now **leads with the plan itself**. The blocker was duplication: rendering it here meant a second copy of `/weekly-plan/{id}`'s loader. `src/digest/page-data.ts` (`loadDigestBundle` + `describeDigest`) is that loader extracted, so both surfaces read one definition of what a briefing is. The archive stays below it. | **Done** |
| 10 | **The env-var names on Settings** | `CONNECTOR_WHATSAPP_MODE` and `SMS_GATEWAY` printed in monospace under copy written for a café owner. Removed — on inspection it served *neither* reader: it printed the variable's **name** and never its **value**, so it said nothing the status chip above it had not, while being the one line on the card addressed to somebody other than the customer. The operator's tool is `pnpm golive`, which reports the resolved configuration. `envVar` still renders on `/channels`, correctly — there it sits inside a sentence with a verb ("Set {envVar}, or connect an account"), which is instruction rather than a label. | **Done** |
| 11 | **The two sparklines** | Not a defect after all, which is why it was left rather than merged. `ds/sparkline.tsx` baselines at **zero** (right for a *count* — 4,5,4,5 must not draw like 0,50,0,50); `dashboard/sparkline.tsx` baselines at the series **minimum** (right for a *bounded* measure — zero-basing a 1–5 rating pins every real business flat near the top). Both correct; the bug was that they shared the name `Sparkline` in two folders, so which one you got depended on autocomplete. Now `VolumeSparkline` and `TrendSparkline`, each naming its baseline and pointing at the other. | **Done** |

**Why this order and not "fix the dashboard first".** The dashboard is seen once per session
and mostly read. Reviews is *used* — scrolled, selected, replied to, forty times a morning.
Craft compounds where interaction is repeated, and a queue is the most repeated interaction
in this product. It is also the only screen where the customer's own voice appears at
length, which is the thing a reputation product is selling.

---

## 9b. Reference implementation — the review row

The highest-frequency component in the product: 65 instances per screen, on the screen with
the most sessions. Everything below is in `src/components/reviews/review-rows.tsx`; this is
the diff worth reading rather than the whole file.

### Before

```tsx
className={cn(
  "flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors",
  active ? "bg-surface-sunken" : "hover:bg-surface-sunken/60",
)}

<span className="min-w-0 flex-1 truncate text-copy font-medium text-foreground">
  {review.authorName ?? unnamed}
</span>
<Stars rating={review.rating} srLabel={review.ratingLabel ?? ""} />

<div className="flex items-center gap-1.5">
  <p className={cn("min-w-0 flex-1 truncate text-copy",
    review.answered ? "text-faint" : "text-muted-foreground")}>
    {review.snippet}
  </p>
  {review.overdue ? (
    <span className="shrink-0 text-meta text-state-negative-text">{overdueLabel}</span>
  ) : null}
</div>
```

Four faults, none wrong in isolation:

1. `bg-surface-sunken` against `bg-surface-sunken/60` — **selected and hover are the same
   colour** at two opacities, on a list driven by `j`/`k`.
2. `truncate` in a 19rem column — about thirty characters of the only content this product
   has, cut mid-word.
3. The name is `font-medium` whether or not the review is answered, so a half-worked queue
   still looks full.
4. Overdue is red words straight after the cut sentence, so a review appears to end with the
   word "Overdue".

### After

```tsx
className={cn(
  "relative flex w-full flex-col gap-1 py-2.5 pr-3 pl-4 text-left transition-colors",
  active ? "bg-surface-selected" : "hover:bg-surface-hover",
)}

{/* A 4% wash dies under a pointer; the bar survives a glance across a desk. */}
{active ? (
  <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] rounded-r-full bg-primary" />
) : null}

<span className={cn("min-w-0 flex-1 truncate text-copy",
  review.answered ? "font-normal text-ink-500" : "font-semibold text-foreground")}>
  {review.authorName ?? unnamed}
</span>
<Stars rating={review.rating} srLabel={review.ratingLabel ?? ""} size="sm" />

{/* `line-clamp-2`, not a character budget: the cut lands where the text runs
    out of room — the only version that works in EN and in a ~30% longer TR. */}
<p className={cn("line-clamp-2 text-copy",
  review.answered ? "text-faint" : "text-secondary-foreground")}>
  {review.snippet}
</p>

{/* A state belongs in a container that says it is a state. */}
{review.overdue ? (
  <span className="inline-flex w-fit items-center rounded-sm bg-state-negative-bg px-1.5 py-0.5 text-eyebrow font-semibold uppercase text-state-negative-text">
    {overdueLabel}
  </span>
) : null}
```

Two changes outside the component, because the row cannot fix them alone:

```diff
- lg:grid-cols-[11.5rem_minmax(0,19rem)_minmax(0,1fr)]   // reviews/page.tsx
+ lg:grid-cols-[11.5rem_minmax(0,23rem)_minmax(0,1fr)]
```

```diff
- <span aria-hidden>{"★".repeat(filled)}{"☆".repeat(5 - filled)}</span>   // ds/stars.tsx
+ <span aria-hidden className="text-rating">{"★".repeat(filled)}</span>
+ <span aria-hidden className="text-graphic-faint">{"☆".repeat(5 - filled)}</span>
```

### Why this one is the north star

It is four rules of this file working at once, which is why it is the reference rather than
something prettier:

- **§3** — selection is indigo, hover is grey, and they can never be the same value.
- **§4** — a list row is two lines and the second is the content; the column widened
  *because* of that. One decision, not two.
- **§6** — `answered` recedes by name as well as snippet, and overdue is a state in a
  container rather than coloured text.
- **§2** — `Stars` carries amber itself. A component that makes the caller remember the
  brand colour will have callers that forget.

## 10. Six principles

1. **The customer's words are the content; everything else is chrome.** If a control is
   crowding a sentence a customer wrote, the control moves.
2. **Rank everything.** Two things at the same size, weight and colour are two things nobody
   will choose between. A screen with no hierarchy has no opinion.
3. **Colour means one thing.** Indigo is interaction, amber is a rating, semantic pairs are
   states, everything else is ink.
4. **Flat by default; float only what floats.** Cards get a hairline. Shadows are reserved
   for things that genuinely sit above the page, so that when one appears it means something.
5. **State must survive a glance.** Selected, overdue, unanswered and disabled are legible
   from across a desk and never carried by colour alone.
6. **Design in Turkish, at 390px, and it will hold everywhere else.** The launch locale and
   the smaller screen are the constraint, not the adaptation.
