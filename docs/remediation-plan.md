# Remediation & Build Plan — from the Founder Audit

*Revira · source: live founder product audit (Aug 2026, 215 seeded reviews, every screen at 1440/390px) · this sequences the audit into execution-ready waves for Claude Code.*

> **Strategic principle (the audit's closing, and it's right):** the engineering is good; the *product* is a broken first mile under four phases of platform. **Fix the first mile (Wave 1) in a week — none of it is hard — then spend three weeks making the two things we actually sell real: the Action Digest, and WhatsApp.** Everything else (IA, richness, features) comes after those two.
>
> **Work in order. Pause after each work package for review.** File pointers from the audit are preserved so you can go straight to the code. Build missing queries rather than stubbing.

---

## Wave 1 — Prototype → Software  *(target: ~1 week)*

The first-mile fixes. Individually small; together they move the product from "prototype" to "software." Do these before anything else.

**W1.1 — Sign-in lands returning users at "Create organization" (P0-1, critical).**
`auth/config.ts` never sets `session.activeOrganizationId`; `(app)/layout.tsx:44` then redirects to `/create-organization`. Add BetterAuth `databaseHooks.session.create.before` → set `activeOrganizationId` from `users.last_active_organization_id` (persist it) or the sole membership. Add an **org picker** to `/create-organization` when memberships exist.
*Done when:* a returning single-org user lands on the dashboard; multi-org users get a picker; the duplicate-org path is gone.

**W1.2 — One definition of "answered" (P0-4, kills 78 fake overdue).**
`inbox/page.tsx:200` derives owner-reply from `raw_payload.ownerReply`, but facets count only `replies` rows. Define once: `replies.id IS NOT NULL OR raw_payload ? 'ownerReply'`; apply in `inbox/queries.ts` facets, `slaState`, `computePriority`, and the Home hero. Backfill a `reviews.answered_at` column at ingest.
*Done when:* reviews answered on Google read as answered everywhere; the fake overdue count is gone.

**W1.3 — 217 unread notifications on a fresh account (P0-5).**
Suppress notifications for a connection's **first sync** (`lastSyncedAt IS NULL`); never notify for reviews whose `published_at` predates the connection. Cap badge at `9+`; add **mark-all-read**.
*Done when:* a fresh sync produces no notification flood; badge is sane.

**W1.4 — Remove the embarrassments (P0-2 button, P0-8 dev connectors).**
Gate `mock`/`fixture` connectors behind `NODE_ENV !== 'production'` + `?dev=1`. Remove the **"Connect WhatsApp Business"** button from the location source list (it throws `Provider "whatsapp" cannot read reviews` — WhatsApp is a channel, not a source; real fix in W2.2). Replace contradictory badge pairs ("Live sync" + "Sample data") with one honest chip: *Demo data / Connected / Needs attention*.
*Done when:* no dev/mock connectors or developer-English errors are visible to a customer.

**W1.5 — Forms fail silently; there is no toast system (P1-7).**
Add a global **toast** for every server-action result (success + failure). Wire **Zod → inline field errors + `aria-invalid` + focus first invalid field** on every form (sign-up, campaign, widget, etc.). Fix the double-submit artifact (`Ziyaret sonrasıZiyaret sonrası`, slug `…-wrccnq`).
*Done when:* no form fails silently; every action gives feedback.

**W1.6 — Digest anti-filler correctness (P0-3, the correctness half).**
Real output today is ASCII-folded Turkish filler with "0 reviews on" every action. (a) `AI_MODEL_DIGEST` is blank → falls back to the cheapest tier; **invert the tiers — spend on the once-a-week digest**, not on replies. (b) **Turkish diacritic validator**: reject+retry any `tr` output containing zero of `ıİşŞğĞçÇöÖüÜ` while the input quotes do (reuse the `analyze_review` trick). (c) **Refuse to compose filler**: if `themes.length === 0` or `analysedCount < 5`, render "Not enough analysed feedback this week" + a link to what's pending. (d) **Actions carry evidence**: require `action.reviewIds[]` in `digestSchema`; reject a response where any action cites nothing — "0 reviews on" must be impossible. (e) Force each action to name a concrete lever from a closed list (staffing / hours / menu item / reply-backlog / signage / process).
*Done when:* the digest never renders diacritic-less Turkish, never shows "0 reviews on," and honestly refuses when data is thin. *(The deeper quality pass is W2.1.)*

**W1.7 — Every list screen is a permanently-open create form (P1-6).**
Build one shared `<ResourcePage>`: empty state (illustration + one line + one primary button); creation in a **Sheet/Dialog**; populated state = the list with "+ Add" in the header. Apply to **Locations, Requests, Surveys, Showcase, Broadcasts** (fix the double "save a segment first" box).
*Done when:* those five screens look finished whether empty or full.

**W1.8 — Settings promises billing and has none (P0-7).**
Add a **Plan** section: current plan, trial end, the four tiers + prices from `PLAN_CATALOG`, usage vs `requests_per_month` / `max_locations`, and an upgrade button. Then wire **Stripe Checkout**. The amber "Choose a plan" CTA must lead somewhere real.
*Done when:* the product can show plans and (via Stripe) take money.

**W1.9 — Team is unusable by a team (P0-6).**
Ship **invitations** (BetterAuth's invitation table/endpoints are wired — a form, the email infra you have, an accept route). Until then, **hide the assignee dropdown** (a permanently-"Unassigned" control on 86 cards is worse than none).
*Done when:* a teammate can be invited, accept, and be assigned reviews — or the assignee control is hidden.

**Fold in here:** mobile document-width overflow on `/requests` (595px) and `/locations` (401px) — `overflow-wrap:anywhere` + `min-width:0` on the link readout, and assert `scrollWidth === innerWidth` (P1-12).

---

## Wave 2 — The two bets  *(target: ~3 weeks)*

The differentiators, currently the weakest things in the build.

**W2.1 — Make the Action Digest genuinely good (P0-3 deep + Weekly Plan richness).**
On top of W1.6: **evidence-carrying action cards** (theme + count + two verbatim quotes + a button that filters Reviews to exactly those reviews); **completion tracking over time** ("7 of 12 actions done last month" — the retention hook, one column); **cover-page treatment** (real headline, pulse ring, three action cards); **compare-to-last-week**; share/export. **Redesign the digest email** to match the in-app quality (logo, stars, colour, theme bars) — it's the weekly touchpoint and currently the least-designed surface. Benchmark against the excellent hand-written fixture in `scripts/email-preview.mts:209` — that quality is the target.
*Done when:* a real generated digest reads at fixture quality; every action links to its exact reviews; completion trend shows; the email is designed.

**W2.2 — Make WhatsApp real (P0-2 full + P1-10).**
Introduce **Channels** as a first-class concept, separate from review **Sources**, with a messaging capability model (`canReceiveMessages`, not `canReadReviews`). Build the WhatsApp connect flow + status card there. Add **`whatsapp` and `sms`** to the review-request channel enum, routed through `sendMessage`/`checkSendAllowed` (the consent gate exists). Add **contact picker + CSV import** to the send box (replace the 200-address textarea) and a "Send a request" button on every contact. Enable broadcasts over WhatsApp.
*Gated:* live sends need Meta + İYS credentials (go-live). Build the flows, channel model, and gating **now on mock/fixtures**; flip to live at go-live.
*Done when:* WhatsApp connects (mock) without error; a review request can target WhatsApp/SMS through the consent gate; contact picker + CSV work.

**Fold in here:** the **İYS compliance surface** (P1-13) — a Settings "Compliance" card (İYS status, per-channel readiness from `pnpm golive`, plain-Turkish explanation), surfaced on first run, so a trial user who hits a send-refusal knows why.

---

## Wave 3 — IA, naming & data integrity  *(target: ~1 week; can overlap Wave 2)*

**W3.1 — IA + naming migration.** Adopt the audit's 9-item, 3-group rail (down from 15):
`WORK: Dashboard · Reviews · Conversations · Weekly Plan` · `GROW: Get Reviews · Contacts · Website Widgets · Analytics` · `SETUP: Locations & Connections · Team · Settings`.
Renames: Home→**Dashboard**, Inbox→**Reviews**, Digest→**Weekly Plan**, Messages→**Conversations**, Requests→**Get Reviews**, Broadcasts→**Campaigns** (tab under Contacts), Surveys→tab under Get Reviews, Showcase→**Website Widgets**, Clients→**Agency** (entitlement-hidden). **Promote Connections to top-level** (split out of Locations). Add route redirects.
*Done when:* nav is 9 owner-nouns; routes renamed with redirects.

**W3.2 — Canonical theme taxonomy (P1-2) + category select (P2).** Two fields: a **canonical theme** from a closed per-vertical taxonomy (`service_speed`, `food_quality`, `cleanliness`, `price`, `staff`, `ambience`, `parking`, `wait_time`…) — what you trend/chart/translate/benchmark — plus **free-text tags** for the long tail (shown as evidence). Promote `THEMES` from `mock-data.ts` to the real schema; make the model map to it. Make `location.category` a **taxonomy select** (drives theme vocabulary + digest phrasing + benchmark peers).
*Done when:* themes are canonical + translatable + trendable; tags carry the long tail; category is a select.

**W3.3 — Metric integrity (P1-5, P1-4).** **One Reputation score** — one name, one scale, one component — used on all surfaces (it appears as 70 / 72.3 / 63/100 / 4/100 today). Add a tooltip ("65% star rating, 35% how customers wrote, last 30 days"); **Bayesian smoothing** toward the 90-day mean with a minimum sample; show "not enough data yet" below ~10 reviews; drop the decimal. Replace **signed-float sentiment** (−0.27) everywhere with **positive/neutral/negative split bars** (reuse the Home component). Fix `pts` vs `pp` unit mixing.
*Done when:* the score is identical across surfaces and stable on small samples; no signed floats shown.

**Fold in here:** locale precedence (P1-11) — `user pref → org locale → browser → tr`; persist the top-bar toggle to `users.locale`; add locale/timezone/currency to Settings.

---

## Wave 4 — Screen richness  *(target: ~2–3 weeks — the "it looks poor" fixes)*

**W4.1 — Reviews: two-pane + keyboard triage (P1-8, highest productivity win).** Dense left list (~64px/row: author, stars, source glyph, snippet, priority dot, SLA chip) + right detail (full text, the AI analysis chips you already compute, contact history, reply composer with tone/template/regenerate/char-count). `j/k` move, `r` reply, `e` resolve. Saved views as a real left sidebar (All / Needs reply / Negative / Assigned to me / Overdue / custom). Mobile: dense list → full-screen detail. (Today the mobile inbox is 25,470px tall.)

**W4.2 — Connections + Locations (the two worst screens — exactly what Omer flagged).**
*Connections* (new top-level): a grid of provider cards with **real logos** (Google, Instagram, WhatsApp, Facebook, Trustpilot, Yemeksepeti, TripAdvisor), each showing account name, which locations it feeds, last sync (relative), 30-day volume sparkline, capability chips, health state (Healthy / Token expiring / Rate-limited / Reconnect). A **coverage bar** ("3 of 5 sources connected"). "Not connected yet" cards with a **Request this integration** button (captures roadmap demand).
*Locations*: a **table** (Branch · Address · Sources logo-row · Reviews 30d · Avg rating+trend · Unanswered · Public page state · ⋯) → row detail (map, business hours [which SLA needs], rating trend, top themes, QR poster, connections). Bulk actions.

**W4.3 — Dashboard richness (P1-1).** Define the score tile; **default to All-locations** with a **branch comparison strip** (rating, Δ, volume, unanswered, response time per branch, sortable, drill-in); response-time distribution; "Needs attention" as a real triage queue with sentiment/theme chips + inline one-click AI reply; Recent activity as a real avatar timeline. **Never auto-switch the active location on create.**

**W4.4 — Analytics richness.** Split bars (not floats); **theme × time heatmap** (canonical themes × weeks, colour = sentiment — the signature analytics view); rating histogram; response-time percentiles; source cohort. Move report control to a header **Export / Schedule** split button.

**W4.5 — Get Reviews richness.** Funnel across the top (Sent → Delivered → Opened → Clicked → Reviewed with conversion %); channel comparison (WhatsApp / SMS / Email / QR); a **QR poster / table-tent PDF generator** (branch name + logo) — *highest ROI-to-effort item in the audit for a Turkish café; consider pulling into Wave 2*; contact picker + CSV import.

**Fold in here (P2):** reply composer richness (tone/length/signature/regenerate/variants); notification prefs = one default + compact per-branch override table; reply templates moved into the composer with inline "Save as template"; real Recent-activity timeline; chart axis fixes (volume on its own right axis; clamp rating domains to `[min-0.3, max+0.3]`; hide a series rather than draw a fragment).

---

## Wave 5 — Missing-features backlog  *(ranked; after the fixes)*

1. **WhatsApp/SMS requests** (done in W2.2). 2. **Team invitations** (W1.9). 3. **Billing** (W1.8). 4. **More sources** — Facebook, Trustpilot, TripAdvisor, **Yemeksepeti / Getir / Trendyol Yemek** (the TR delivery platforms = the local moat), Google Q&A + Posts, App Store/Play. 5. **QR poster generator** (W4.5). 6. **Auto-reply rules** ("auto-post AI reply to 5★ with no text after 24h; queue the rest" — the AI-native time-saver, all pieces exist). 7. **Cross-source duplicate detection** (pgvector cosine + author/date window). 8. **Business hours + SLA calendar** (SLA counts weekends today). 9. **PWA + push** (owners live on their phone). 10. Google Q&A/Posts management. 11. Competitor benchmarking with real data (go-live). 12. Templates with variables + per-branch signatures. 13. CSV/POS import (Adisyo/Simpra). 14. **Onboarding wizard + demo workspace**. 15. Notification quiet hours.

---

## Positioning quick wins *(do inside Waves 1–2 — they make the wedge visible in the first 5 minutes)*

1. **Demo workspace on first login** ("Explore with sample data" → a fully-populated Kadıköy café with a real digest) — value visible before the connect flow.
2. **Digest-first onboarding** — connect Google → run analysis → compose a digest immediately over the backfill → land the user on it. Not "wait a week."
3. **Compliance page** (İYS status + KVKK tooling + the no-rating-gating statement) — then put it on the pricing page. It's the one claim a competitor can't copy in a quarter.

## Re-test gate

**After Wave 1, re-run BOTH persona sessions** (founder audit + cafe-owner) on the fixed product — that's when a naive-user test finally produces signal instead of "it broke."

## Deferred to go-live (post-company)

Real Google/Meta/İYS **credentials** and live verification: real WhatsApp/SMS sends, real competitor data, production billing beyond the Checkout scaffold. Build the flows now (mock/fixtures behind flags); flip at go-live.

---

## Claude Code Kickoff Prompt

> Read `CLAUDE.md` and `docs/remediation-plan.md`. This is a prioritized remediation plan from a founder product audit — the app has real first-mile bugs and its two differentiators (Action Digest, WhatsApp) are the weakest parts. Work **Wave 1 in order**, pausing after each work package (W1.1 … W1.9) for my review. Start by confirming you can reproduce W1.1 (sign-in → "Create organization"), then fix it. Keep the locked stack; build missing queries rather than stubbing; do not start Wave 2 until Wave 1 is reviewed and green. Report anything in the plan that no longer matches the code.
