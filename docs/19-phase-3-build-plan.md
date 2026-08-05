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

> **Built 4 Aug 2026, less the link.** A badge is a `layout` on the existing widget — same public key, publish flag, scope, embed script and builder — so everything T0 and T1 delivered carries it, and only the render branch is new.
>
> **The aggregate is deliberately uncurated.** It averages every rated review in the widget's scope, ignoring both the display-approval gate and the widget's own `minRating`, and `PublicAggregate.basis` is `"all_reviews_in_scope"` on the wire. A business may choose which reviews it *quotes*; it may not choose the score, because "4.8 · 320 reviews" is a claim about what customers said. Because those filters cannot move the number, the builder hides them — and the approval list with them — while a badge is selected.
>
> **"Links to the SEO page" is deferred to T3**, which is where that page comes into existence. The badge renders unlinked today rather than pointing at a URL that 404s; wiring the `href` is part of building the destination, not of building the badge.

### P3-T3 — SEO review pages
A hosted public page per location (reuse/confirm the existing public route groups — `src/app/r`, `/u`, `/c` — or add one) listing reviews, indexable, localized TR/EN, fast, with **`LocalBusiness` JSON-LD only**.

> **Amended 4 Aug 2026 — no review markup.** This task originally asked for `AggregateRating` + `Review` JSON-LD. That is not achievable and was never going to be, so building it would have produced a green Rich Results Test and no stars in search.
>
> Google's review-snippet policy: *"If the entity that's being reviewed controls the reviews about itself, their pages that use `LocalBusiness` or any other type of `Organization` structured data are ineligible for star review feature"* — and it names exactly our case, *"a review about entity A placed on the website of entity A, either directly in their structured data or through an embedded third-party widget"*. A second rule, *"Don't aggregate reviews or ratings from other websites"*, rules out marking up the Google and Instagram reviews we ingest.
>
> The Rich Results Test validates **syntax, not policy**, so the original Definition of Done could have been met by something that does nothing. Emitting the markup anyway risks a structured-data manual action.
>
> The widget and badge are unaffected: they emit no JSON-LD and the embed document is `noindex`, so they display reviews without making a claim to a search engine. Keep it that way.
>
> Source: [developers.google.com/search/docs/appearance/structured-data/review-snippet](https://developers.google.com/search/docs/appearance/structured-data/review-snippet)

**Done when:** the page renders with valid `LocalBusiness` structured data, is indexable, and shows only approved reviews. **Not** "rich-result-eligible" — that is not ours to promise. Check `docs/02` and `docs/05` for anywhere the product claims star snippets, and correct it.

> **Built 5 Aug 2026.** `/reviews/{slug}`, one page per location, opt-in from `/locations`.
>
> - **The slug is minted once and never moves.** It is built from the business's and the branch's names (`src/seo/slug.ts`, Turkish-aware — `ı`, `İ`, `ş`, `ğ` do not survive the usual NFD recipe), made unique globally because it is a URL, and then left alone. Renaming a location does not change its address, and unpublishing keeps it, so a page that goes down and comes back is the same page to a search engine.
> - **The fourth reader of `src/widgets/scope.ts`.** The approval list already promises "approving a review shows it on every widget, badge and public page you have"; this is the "and public page", and it keeps that promise by asking the same question. The projection is `PublicReview`, shared with the widget endpoint.
> - **`LocalBusiness` only**, per the amendment above, and `src/seo/jsonld.ts` carries the reasoning where somebody would go to add the missing bit. The average is stated in *prose* — "averaged over every rated review this branch has received, including the ones not shown" — which is the honest version of the `AggregateRating` claim we are not entitled to make.
> - `robots.txt` and `sitemap.xml` landed with it. The product had neither, so every private-by-intent public route — `/c/`, `/r/`, `/u/`, `/embed/` — was crawlable by default. `/u/` is the one that mattered: a crawler following a one-click unsubscribe opts people out.
> - **The badge's link now points somewhere** (the P3-T2 deferral). Only when a widget names a location whose page is actually published; otherwise it stays unlinked rather than pointing at a 404.
> - **Corrected in `docs/02` and `docs/01`**, which both promised schema.org rich snippets. `docs/05` never did.
> - **Not gated by its own entitlement key.** It shares `widgets`, because the pricing matrix in `docs/05` lists one line, "Widgets / showcase". If the two are ever priced apart, P3-T7 is where that happens.

### P3-T4 — Analytics workspace (Insights page)
Deeper than Home: theme trends over time, sentiment trend, rating trend, **per-location comparison**, **per-staff performance** (staff-mention extraction), source comparison — with date ranges + CSV/PDF export. Reuse `src/dashboard/*` metrics; add trend/comparison aggregates.
**Done when:** the Insights page answers "are we improving, where, and driven by what" with exportable charts.

> **Built 5 Aug 2026.** `/insights`, laid out as those three questions in order: trends say *whether*, the branch and source tables say *where*, themes and names say *what*.
>
> - **Its own facts loader**, not a flag on the dashboard's. Home is scoped to one branch; this reads across every location the member may see, so each fact carries its location and the **member's scope from `src/auth/scope.ts` is the filter**. An empty scope returns nothing rather than everything — the failure mode that looks perfect for an admin and is a leak for exactly the member it was meant to restrict.
> - **Absence is `null`, never `0`.** A week with no reviews did not score nought stars; the line breaks rather than diving to the axis, and a branch with nothing in the window shows a dash. The one exception is volume, where zero is a real measurement.
> - **Themes rank by what moved, not by what is biggest** — "food is the top theme again" is the weather; "waiting time tripled" is the news. A theme with no previous window reads "new", not "+∞%".
> - **Staff mentions, not staff scores.** Migration `0033` adds `review_insights.staff`, extracted by `analyze_review@2`; the prompt is narrow on purpose (copy a name the customer wrote, never resolve "the manager", never guess). The panel shows counts and the ratings of the reviews that named someone, with **no rank, no composite and nothing to sort by** — an automated evaluation of a named individual built from strangers' prose is not something this data supports or this product has a basis for. It also distinguishes "nobody was named" from "analysed before names were extracted", because a false negative there is one a manager would act on.
> - **CSV export, not PDF.** `/insights/export` reuses the page's own aggregate functions so the file cannot disagree with the screen, carries raw numbers so a spreadsheet can do arithmetic on them, and is scoped by the same `listLocationsForActor` — there is no `locationId` parameter and there must not be one. Values are neutralised against **CSV injection**: `=`, `+`, `-`, `@` at the start of a theme tag or a name is a formula to Excel and Sheets.
> - **The trend lines are trailing averages, not per-bucket** (corrected 5 Aug 2026 after review). Plotted per bucket, the rating line was a scatter of disconnected fragments, because a real business has reviews on a minority of days — and `src/dashboard/metrics.ts` had already settled this for Home's chart, with a comment describing the same complaint. Insights simply failed to reuse it. Each point now averages the week ending at it (`TRAILING_DAYS`, shared with Home), reaching back across the range boundary so the first points are not starved. Nothing is invented: a span with genuinely no data is still null, and **volume is deliberately not smoothed** because averaging a count hides the spike that makes somebody look at the week.
> - **Export offers the page as a PDF and everything as one CSV** (added 5 Aug 2026 after review). The PDF is the *same document* the scheduled report mails — a download that looked different from the thing arriving every Monday would make both look unreliable. "Everything" is one long table with a `section` column rather than four tables stacked with blank lines, because the second is not valid CSV and every tool guesses differently; a long table is what a pivot wants.
> - **PDF is deferred to T5**, which is where it becomes unavoidable (a scheduled report has to render server-side). No PDF library is in the project and adding one is a dependency decision worth taking deliberately — see the note on T5.



### P3-T5 — Scheduled reports
Per-location/org weekly or monthly **PDF + email** report built from the analytics + the digest email infra; schedule config; entitlement-gated (Pro+).
**Done when:** a scheduled report generates and emails on cadence.

> **Built 5 Aug 2026, on `@react-pdf/renderer` (approved).** Migration `0034`: `report_schedules` (what somebody asked for) and `report_deliveries` (what was sent). `/insights` carries the control; the `report_sweep` job runs hourly.
>
> - **Idempotency is a row, not a timer.** The ledger is keyed by `(schedule, period)` and the pipeline never asks "when did we last send" — it asks which period has *closed*. A sweep that fires hourly, runs twice, or first runs on Friday all send exactly one report for the right week. `src/reports/period.ts` is pure and tested against month ends, a leap February and the Sunday-is-day-zero trap.
> - **Scope is resolved at send time**, from the recipient's own location scope, so a schedule made when somebody could see three branches stops covering three the moment they are moved to one. A schedule whose owner has left the organization stops sending — there is no membership left to scope by.
> - **A schedule belongs to a person**, not to an organization: "email me this every Monday". There is no recipient field because there is nobody else to choose until invitations exist.
> - **The font was the hard part, and it was not cosmetic.** `@react-pdf` falls back to Helvetica, which has no Turkish glyphs: "Kadıköy Şubesi" rendered as "Kad1köy ^ubesi". `@fontsource/inter` does not fix it — Google's `latin` subset carries `ı ç ö ü` and `latin-ext` carries `İ ş Ş ğ Ğ`, so **neither file alone can set a Turkish sentence** and `Font.register` takes one file per weight. Measured with `fontkit`, not guessed. `@expo-google-fonts/inter` ships unsubsetted TTFs and covers all of it — but **Turbopack rewrites `require.resolve` into a module id**, so the app build broke whichever way the specifier was written, and the two weights are now **committed to `src/reports/fonts/` with their OFL licence**. A committed file has no resolution step to break. `★` is missing from every font checked, so the report writes "4,3 / 5".
> - **No JSX in `src/reports/document.ts`.** The worker runs `.ts` through Node's own type stripping, which strips types and does not transform JSX — a `.tsx` file would work in the app's bundler and crash the process that actually sends the reports.
> - **Entitlement:** a new `scheduled_reports` key, Pro and above per the matrix in `docs/05`. Checked when the schedule is saved *and* again at send time, because a plan can lapse in between.
> - **`pnpm email:preview` now sends it, with the PDF attached** — the file is the inventory of what the product can put in someone's inbox, and half of this one is rendered by a library.
> - Two defects only running it could find: the pipeline imported `lib/active-location.ts`, which imports `next/headers`, so the **worker crashed at startup** while every test passed; and the report's title and subtitle overlapped because the page's line height was shorter than 20pt glyphs.


### P3-T6 — Competitor benchmarking *(framework now, live data gated)*
A `competitors` model (link a competitor's public listing) + a benchmark view comparing your rating/sentiment/volume vs theirs. **Build against fixtures now**; live data uses the real connectors at go-live. Flag it clearly as unverified until credentials land.
**Done when:** the benchmark renders from fixture data behind a flag; a documented go-live step swaps in real data.

> **Built 5 Aug 2026, framework only, as asked.** Migration `0035` adds `competitors`; the card is on `/insights` behind the existing `benchmarking` entitlement (Pro+).
>
> - **One table, not two.** The obvious second is `competitor_snapshots`, so the benchmark can show a trend. It is not here, because the only source that can fill it today is a fixture and **invented rows written into a customer's database outlive the flag that produced them** — `iys_uploaded_via` is in this schema for exactly that lesson. What a business typed (the competitors they name) is stored; the numbers are fetched at read time and discarded. A snapshot table lands with the real adapter, and every row in it will have come from somewhere.
> - **`COMPETITOR_SOURCE` defaults to `none`, which refuses.** A deployment that has not chosen a source shows no benchmark rather than a plausible one. `fixtures` invents *deterministic* numbers — a figure that moved on every render would read as live data, which is the most misleading thing a fixture can do — and they are not rigged to flatter.
> - **Every reading carries its own source**, and the card's warning is driven by `Benchmark.unverified` rather than by the component guessing from a name. The notice is above the table, in the alarm colour, because a benchmark is the kind of number a business repeats to a landlord.
> - **The two halves are measured the same way.** A listing shows a *lifetime* rating, so our side is lifetime too — the Insights range deliberately does not apply, and the copy says so. A 30-day average against somebody's all-time one is the mistake that makes a business think it has overtaken a rival.
> - **Competitor sentiment is not obtainable** and is therefore absent rather than null-forever: it needs their review text, which no platform hands over for somebody else's business. `docs/13` records that as a permanent limitation, not a to-do.
> - Go-live steps: `docs/13-go-live.md` § Competitor benchmarking.

### P3-T7 — Entitlements
Gate per plan config (reuse `can()`/`withinLimit()`): widgets (Starter 1 / Growth+ more), SEO pages, analytics depth, scheduled reports, benchmarking (Pro+). Config, not code.
**Done when:** plan changes toggle these with no code change.

> **Done 5 Aug 2026.** Two keys were missing and are now added; the rest were wired as each task shipped.
>
> - **`analytics`** — the Insights workspace and its export. `docs/05` lists "trends dashboard" from Growth, so Starter is `false`: they keep Home, which answers "what needs doing today" for one branch. The page renders a locked card rather than redirecting — "not on your plan" is information, a bounce to Home is a mystery — and **the export route carries the same gate**, because a route that answers when the screen would not is a way to read a paid feature by URL.
> - **`seo_pages`** — its own key at last, **set to match today's behaviour rather than to change it**. `docs/05` prices widgets and the hosted page as one line, so it is on for every tier; the point of splitting it is that pricing them apart is now one `false` in `plans.ts` and nothing else. **That is a pricing decision and it is open** — see the note below.
> - Already wired: `widgets` + `max_widgets` (T0/T1), `scheduled_reports` (T5), `benchmarking` (T6).
> - `tests/lib/phase3-entitlements.test.ts` is what makes the DoD checkable rather than asserted: every surface has a key, every plan has a value for every key, the values read as the `docs/05` matrix, **packaging is monotonic** (a higher tier never takes a feature away), and an override moves a gate without touching a plan.
> - **A lapsed account keeps what it already published.** Cancelling drops Insights, reports and benchmarking; it does not drop `seo_pages` or `ai_replies`, because darkening an indexed page somebody linked to is a different kind of act from closing a dashboard.
>
> **Open question for pricing:** is the hosted review page a Starter feature? It is arguably the most valuable thing in the product for a one-location business with no website — and it is also an obvious Growth lever. It is `true` everywhere today because that is what `docs/05` says; changing it is one line.


### P3-T8 — Tests
**Public-endpoint tenancy isolation** (a widget/SEO page never exposes another org's or unapproved reviews) — the headline test; schema.org markup validity; analytics correctness; report generation; entitlement gates; i18n TR/EN; WCAG AA; mobile.
**Done when:** all pass; the public-leakage test is explicit and green.

> **Done 5 Aug 2026.** Most of the coverage landed with the task it belonged to; T8 added the two things that could only be written once the whole phase existed.
>
> - **`tests/db/public-leakage.test.ts` is the headline test**, and it is deliberately per-*surface* rather than per-module. Two organizations whose data is built to be confusable, one hostile fixture, and every public entry point walked with the first one's credentials: the widget JSON endpoint, the embed document, the badge document (which reads *wider* than the others by design, so it gets its own sweep), the hosted page's data, and the sitemap. Each is asserted clean by id, by review text, by author, by business name and by branch name — an id-only check would pass for a response carrying another business's words under the right id. The inverse is asserted too, so a surface that returned *nothing* cannot pass the file.
> - **It also catches the next leak, not just the known ones.** The last test enumerates the public route files on disk and fails when one appears that is not in its list. Every entry there was reasoned about — some serve tenant data through a key, some serve none — and pinning the set is what stops the *next* public surface arriving unexamined.
> - **Mobile**: `/insights` and `/widgets` at a real 390px. The Insights assertion is stricter than the shared `overflowing()` helper rather than looser — a comparison table is *deliberately* wider than the viewport, so the check is that anything overflowing is held by an ancestor that scrolls it, plus that the container really does scroll rather than the table having been quietly squeezed.
> - **WCAG**: the report PDF's palette was the last Phase 3 surface with literal hex and no test. Its colours are read *out of the module* rather than copied, so the test cannot pass while the document renders something else, and it checks that a delta's direction survives without colour (WCAG 1.4.1) since the values are signed strings.
> - Already covered by the tasks themselves: schema.org validity (`tests/lib/seo-jsonld.test.ts`, which asserts on keys and types rather than substrings — the canonical URL contains the word "reviews"), analytics correctness (`insights-trends`, `insights-facts`), report generation and idempotency (`report-period`, `scheduled-reports`), entitlement gates (`phase3-entitlements`), and i18n parity via `pnpm check:i18n`.


---

## Reminders (same standards)

Build missing aggregates **alongside the widget — never stub**; flag unsourceable metrics. Tokens/charts discipline (no hardcoded hex). Full **TR/EN**. **WCAG 2.1 AA.** **Mobile-first.** Widgets must be lightweight (they load on customers' sites — performance is a feature).

## Out of scope

Engagement — messaging / surveys / CRM / campaigns (Phase 4); real competitor data live-verification (post-company).

---

## Claude Code Kickoff Prompt

> Read `CLAUDE.md` and `docs/19-phase-3-build-plan.md`. Phases 0–2 are done. We're starting **Phase 3 — Showcase & Analyze**, on the mock connector, with competitor benchmarking built behind a flag (live data deferred to go-live). First update `CLAUDE.md`'s current-phase pointer to Phase 3, then restate the Definition of Done and the **public-endpoint security rule** (widgets/SEO pages expose only that org's approved reviews — no cross-org data, ever). Begin at **P3-T0** and proceed in order, pausing after each task for review. Build missing queries rather than stubbing; ask before adding any dependency not named in the plan.
