# Home — Live Dashboard · Implementation Handoff

*Revira · redesign of `src/app/(app)/home/page.tsx` · companion to `docs/08-design-brief.md` and `docs/06-ux-roles-and-flows.md`*

> **Decision (Omer, Aug 2026):** Home becomes a **live dashboard**, not a weekly-digest page. The weekly **Action Digest moves to email + WhatsApp** (and a `/digest` archive). Competitors all run live dashboards or live inboxes; the digest-as-email is the retention loop the market already trained users to open. Our edge on Home is a **live AI insight strip** plus an **action-first review queue** — nobody else does the AI layer live.
>
> **Visual reference:** `docs/assets/home-live-dashboard.html` (open in a browser). Build to match its layout, hierarchy, and use of colour — it is the source of truth for the look.

---

## 1. What changes

- `home/page.tsx` no longer renders `<DigestView>`. It renders the live Overview below.
- `DigestView`, `PulseTile`, `ActionCard` are **reused**, not deleted — they move to: (a) the **weekly digest email** template, and (b) a **`/digest` archive** page (list of past weekly digests). The AI strip's "View weekly digest" links there.
- Home is **live and scoped to the active location** (the location switcher already exists) and to a **date range** (7d / 30d / 90d) that scopes every widget.

---

## 2. Design tokens (`src/app/globals.css`)

The current `--chart-*` tokens are greyscale and the page is pure white, which is why the UI reads flat. Add this block **after** the existing Revira brand-tokens block:

```css
:root {
  --background: oklch(0.985 0.005 268);        /* faint tint so white cards lift */
  --positive: oklch(0.70 0.14 162);            /* green — up-deltas / healthy */
  --positive-foreground: oklch(0.99 0 0);
  --sentiment-positive: var(--positive);
  --sentiment-neutral:  var(--brand-amber);
  --sentiment-negative: var(--destructive);
  --chart-1: var(--brand-indigo);              /* real palette (was greyscale) */
  --chart-2: var(--brand-amber);
  --chart-3: oklch(0.70 0.13 182);             /* teal */
  --chart-4: oklch(0.63 0.17 285);             /* violet */
  --chart-5: var(--positive);
  --elevation-sm: 0 1px 2px rgb(16 25 58 / .05);
  --elevation-md: 0 8px 26px -10px rgb(16 25 58 / .13);
}
.dark {
  --background: oklch(0.16 0.02 269);
  --positive: oklch(0.75 0.14 162);
  --elevation-sm: 0 1px 2px rgb(0 0 0 / .3);
  --elevation-md: 0 10px 30px -12px rgb(0 0 0 / .5);
}
@theme inline {
  --color-positive: var(--positive);
  --color-sentiment-positive: var(--sentiment-positive);
  --color-sentiment-neutral:  var(--sentiment-neutral);
  --color-sentiment-negative: var(--sentiment-negative);
  --shadow-sm: var(--elevation-sm);
  --shadow-md: var(--elevation-md);
}
```

- Give the `Card` component a default `shadow-sm` (soft elevation is a big part of the richer feel).
- Keep `--card` white. Cards now sit on the faint tinted `--background` and lift.
- Amber stays reserved for ratings / neutral sentiment / highlights — never a default surface.

---

## 3. Layout (top → bottom)

Max content width ~1280px, 16px gaps, cards `rounded-2xl` + `shadow-sm`.

1. **Header row** — `PageHeader` "Overview" + active-location subtitle, right-aligned **range toggle** (7d / 30d / 90d segmented control). The range is a URL search param (`?range=30d`) so it's shareable and server-readable.
2. **KPI row** — 4 equal cards.
3. **AI insight strip** — full-width.
4. **Split row** — `grid lg:grid-cols-[1.9fr_1fr]`: Reputation-over-time chart (left) + Needs-attention queue (right).
5. **Triple row A** — `grid md:grid-cols-3`: Sentiment · Reviews by source · Top themes.
6. **Triple row B** — `grid md:grid-cols-3`: Rating distribution · Response time · Recent activity.

All rows stack to 1 column on mobile. **Mobile matters** (owners are phone-first): the KPI row → 2×2, the split row → stacked with Needs-attention first.

---

## 4. Widgets (data + interaction)

All queries run inside `withTenant(...)`, scoped to `organizationId` + active `locationId` + the selected range; "previous period" = the equal-length window immediately before, for deltas. Charts are client components (**Recharts**) fed server data.

| # | Widget | Shows | Data | Interaction |
|---|--------|-------|------|-------------|
| 1 | **KPI ×4** | Reputation Score · Avg Rating · New Reviews · Response Rate — value + delta vs previous period + 7-point sparkline | aggregates over range | — |
| 2 | **AI insight strip** | One generated line: # urgent/unanswered + top emerging theme + a risk/reassurance clause | latest insight (cheap, cached; NOT the full digest run) | *Reply now* → `/inbox?filter=urgent`; *View weekly digest* → `/digest` |
| 3 | **Reputation over time** | Avg-rating line + review-volume bars over range | daily/weekly buckets | hover tooltip; follows range toggle |
| 4 | **Needs attention** | Top 3–5 open reviews ranked by urgency = negative ∧ unanswered ∧ recency | reviews + insights | AI-reply → composer; row → review; header → `/inbox` |
| 5 | **Sentiment** | Positive/neutral/negative donut + % | insights over range | — |
| 6 | **Reviews by source** | Per source: count + avg rating + bar | reviews grouped by source | row → `/inbox?source=` |
| 7 | **Top themes** | Ranked themes, count + dominant-sentiment colour | theme aggregates | theme → `/inbox?theme=` |
| 8 | **Rating distribution** | 5★→1★ counts | reviews grouped by rating | — |
| 9 | **Response time** | Median reply time + % replied < 24h + trend | replies vs reviews | — |
| 10 | **Recent activity** | Live feed: new review / reply posted / request sent / new comment | recent events (audit + reviews) | item → its detail |

**Empty state:** location with no connected source / no reviews → a friendly card prompting *Connect a source* (`/locations`) or *Send review requests* (`/requests`). Reuse the existing empty-state pattern in `home/page.tsx`.

**Loading:** stream the page; each card renders its own skeleton (`Suspense` boundaries) so the shell + KPIs paint immediately.

**Data note — build queries as you go, don't stub.** Several widgets need aggregate queries that may not exist in the schema yet: sparkline time-buckets, previous-period deltas, response-time medians, per-source and per-theme aggregates, and rating-distribution counts. Where a query is missing, **build it alongside its widget** — a typed, tenant-scoped aggregate in the data layer — rather than hard-coding placeholder numbers. If a metric genuinely cannot be sourced from the current schema, **stop and flag it** (say what's missing — a column, an index, a derived count — and whether to add it or defer the widget). Never invent data to fill a card.

---

## 5. Components to build (in `src/components/home/`)

Reuse the existing `ui/*` kit (Card, Badge, Button) and shell. New:

- `kpi-card.tsx` (+ a small `sparkline.tsx`, Recharts)
- `ai-insight-strip.tsx`
- `reputation-chart.tsx` (Recharts `ComposedChart`, client)
- `needs-attention.tsx` (reuses source badges + a compact review row)
- `sentiment-donut.tsx` (Recharts `PieChart`)
- `source-breakdown.tsx`
- `themes-list.tsx`
- `rating-distribution.tsx`
- `response-time.tsx` (radial)
- `activity-feed.tsx`

Charts use the `--chart-*` / `--sentiment-*` tokens (never hard-coded hex). Every chart needs an accessible label/summary; the page targets **WCAG 2.1 AA**. All copy through **next-intl** (TR + EN) — design for ~30% longer Turkish strings.

---

## 6. Digest → email / archive (separate follow-up, not this task)

Note for sequencing (do **not** build in this task unless asked): the weekly digest generation stays; its *surface* changes to (a) an email (and WhatsApp in 1b) built from the same payload with the existing `DigestView`/`PulseTile`/`ActionCard`, and (b) a `/digest` archive page listing past weeks. This handoff only covers the live Home.

---

## 7. Definition of done

Home renders the live Overview above, scoped to the active location + range toggle; KPIs show deltas + sparklines; the AI strip, reputation chart, needs-attention queue, and all six lower widgets render with real (mock-connector) data; charts use brand tokens; empty + loading states handled; TR/EN parity; mobile layout holds; matches the visual reference. `home/page.tsx` no longer imports `DigestView`.
