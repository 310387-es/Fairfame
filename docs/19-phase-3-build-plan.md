# Phase 3 — Showcase & Analyze · Build Plan

*Revira · turn reviews into growth + intelligence · companion to `docs/02-prd.md` §5 (Phase 3) and `docs/01-master-plan.md` §7*

> **Two tracks, one honest split.** *Showcase* (widgets, badges, SEO pages) and the *internal Analyze* work are **fully buildable now on mock / first-party data**. **Competitor benchmarking is gated** — it needs real competitors' public reviews, which arrive with the real connectors at go-live (Phase 1b, post-company). Build its framework now against fixtures; wire live data later.
>
> Builds on the existing `reviews` / `review_insights`, the `src/dashboard/*` metrics layer, and the `widgets` entity from the Phase 0 data model. Reuse the digest email infra for scheduled reports.

## Definition of Done

A business can **display its reviews on its own site** (embeddable widget + rating badge) and on a **hosted, SEO-optimized review page** (schema.org rich snippets); and can **analyze** reviews in depth (theme/sentiment/rating trends, per-location and per-staff performance) with **scheduled PDF/email reports**. Competitor benchmarking is built behind a flag, live data deferred to go-live.

---

## Security note (read first)

The widget + SEO endpoints are **public and unauthenticated**. A tenancy leak here is worse than in-app — it's on the open internet. Every public read must expose **only that widget's org's reviews**, and only ones **approved for display** (a per-review/publish flag). This gets an explicit test (P3-T8). No auth cookie, no cross-org data, ever.

---

## Ordered Tasks

### P3-T0 — Public read API + widget delivery
A cacheable, **unauthenticated** public endpoint keyed by a widget `public_key` (CDN cache headers, CORS, rate limit). A tiny framework-agnostic **embed script** (+ iframe fallback) customers paste into their site. Extend the `widgets` table (public_key, filters, style, published flag).
**Done when:** a public_key returns only its org's approved reviews as cacheable JSON; the embed script renders on a plain HTML page.

### P3-T1 — Embeddable review widget
Configurable: sources, min rating, count, layout (carousel / grid / list), light/dark, locale. In-app **widget builder**: create → preview → copy embed snippet. Uses the design tokens.
**Done when:** a user builds a widget in-app and it renders their reviews on an external page.

### P3-T2 — Rating badge
Compact aggregate badge ("4.6★ · 842 reviews"), embeddable, links to the SEO page.
**Done when:** the badge embeds and shows the live aggregate.

### P3-T3 — SEO review pages
A hosted public page per location (reuse/confirm the existing public route groups — `src/app/r`, `/u`, `/c` — or add one) listing reviews with **schema.org `AggregateRating` + `Review` JSON-LD**, indexable, localized TR/EN, fast.
**Done when:** the page renders, validates as rich-result-eligible structured data, and shows only approved reviews.

### P3-T4 — Analytics workspace (Insights page)
Deeper than Home: theme trends over time, sentiment trend, rating trend, **per-location comparison**, **per-staff performance** (staff-mention extraction), source comparison — with date ranges + CSV/PDF export. Reuse `src/dashboard/*` metrics; add trend/comparison aggregates.
**Done when:** the Insights page answers "are we improving, where, and driven by what" with exportable charts.

### P3-T5 — Scheduled reports
Per-location/org weekly or monthly **PDF + email** report built from the analytics + the digest email infra; schedule config; entitlement-gated (Pro+).
**Done when:** a scheduled report generates and emails on cadence.

### P3-T6 — Competitor benchmarking *(framework now, live data gated)*
A `competitors` model (link a competitor's public listing) + a benchmark view comparing your rating/sentiment/volume vs theirs. **Build against fixtures now**; live data uses the real connectors at go-live. Flag it clearly as unverified until credentials land.
**Done when:** the benchmark renders from fixture data behind a flag; a documented go-live step swaps in real data.

### P3-T7 — Entitlements
Gate per plan config (reuse `can()`/`withinLimit()`): widgets (Starter 1 / Growth+ more), SEO pages, analytics depth, scheduled reports, benchmarking (Pro+). Config, not code.
**Done when:** plan changes toggle these with no code change.

### P3-T8 — Tests
**Public-endpoint tenancy isolation** (a widget/SEO page never exposes another org's or unapproved reviews) — the headline test; schema.org markup validity; analytics correctness; report generation; entitlement gates; i18n TR/EN; WCAG AA; mobile.
**Done when:** all pass; the public-leakage test is explicit and green.

---

## Reminders (same standards)

Build missing aggregates **alongside the widget — never stub**; flag unsourceable metrics. Tokens/charts discipline (no hardcoded hex). Full **TR/EN**. **WCAG 2.1 AA.** **Mobile-first.** Widgets must be lightweight (they load on customers' sites — performance is a feature).

## Out of scope

Engagement — messaging / surveys / CRM / campaigns (Phase 4); real competitor data live-verification (post-company).

---

## Claude Code Kickoff Prompt

> Read `CLAUDE.md` and `docs/19-phase-3-build-plan.md`. Phases 0–2 are done. We're starting **Phase 3 — Showcase & Analyze**, on the mock connector, with competitor benchmarking built behind a flag (live data deferred to go-live). First update `CLAUDE.md`'s current-phase pointer to Phase 3, then restate the Definition of Done and the **public-endpoint security rule** (widgets/SEO pages expose only that org's approved reviews — no cross-org data, ever). Begin at **P3-T0** and proceed in order, pausing after each task for review. Build missing queries rather than stubbing; ask before adding any dependency not named in the plan.
