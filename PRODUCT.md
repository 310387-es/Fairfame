# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two confirmed audiences, both first-class.

**1. Any brand that has customers.** Vertical-agnostic by decision, not by indecision — the product is sold to any business that receives customer feedback, from a single café to a multi-branch chain. Within that, three recurring situations:

- **Owner-operator** — runs 1–3 local businesses (café, restaurant, clinic, salon, auto shop, retail). Non-technical, busy, phone-heavy, acts between customers. Wants more reviews, wants to know when something is wrong, wants to look responsive. Judges the product in the first session.
- **Marketing or ops manager** — owns reputation across many branches. Wants one place to compare locations, delegate replies, and report upward.
- **Team member** — replies and triages under a location scope, not the whole account.

**2. Agencies.** An agency operator runs many client businesses from one seat, white-labelled, with the client given a limited role. This is a buying audience in its own right and the highest-leverage distribution channel, not an afterthought tier.

Launch market is **Türkiye**; the product is built global-ready. Turkish and English are equals — not a translation of an English product.

## Product Purpose

Businesses connect their review and social sources and get, in one place: notification of every new review, AI analysis of what customers are saying, and a weekly **Action Digest** — a per-location briefing that names three specific things to do, each tied to the customer's own words as evidence, and reports next week whether last week's actions moved the number.

Six pillars, all built: **Collect** (review requests by email/WhatsApp/SMS/QR, compliant by construction), **Monitor** (unified queue across every connectable source), **Respond** (AI-drafted replies a human approves), **Showcase** (widgets, rating badge, hosted SEO review page), **Analyze** (sentiment, canonical themes, branch and staff performance, benchmarking, scheduled PDF reports), **Engage** (contacts/CRM, NPS/CSAT surveys, two-way messaging, broadcasts, agency white-label).

Success means a business connects a source, gets ongoing value from the notifications and the weekly briefing, and pays monthly to keep it. Time-to-first-value target: under ten minutes from sign-up.

## Positioning

The Action Digest is the differentiator. Competitors report numbers; this tells an owner what to do about them, with the quotes that justify it and a link to exactly the reviews cited. It is the retention engine and the reason someone opens the product weekly rather than when something goes wrong.

Four supporting pillars, each aimed at a structural weakness of the incumbents (Birdeye, Podium, Trustpilot, Yotpo, NiceJob):

1. **AI-native, not AI-bolted-on** — analysis, theme extraction and reply drafting are the workflow, not a sparkle button.
2. **Developer-grade** — API-first, embeddable widgets, clean seams. Nobody in SMB reviews treats agencies and developers as first-class.
3. **Transparent and self-serve** — public pricing, sign up and start, no forced sales demo.
4. **Compliant and trustworthy by design** — KVKK/İYS enforced in code, and **no review-gating anywhere**. This is deliberately the opposite of the grey "buy reviews" market.

**Honest capability labelling is part of the positioning.** Platforms limit what can truthfully be aggregated (Google is full-access with approval; Yelp, Meta, TripAdvisor, G2 and Amazon are gated, excerpt-only or closed). Every source is labelled *Live sync* / *Monitor only* / *Display only*. The product never claims two-way sync it cannot deliver, and marketing must not either.

**WhatsApp-native** is a concrete local advantage: it is the channel Turkish businesses already use, and review requests, notifications and two-way conversations all run over it.

## Operating Context

- **The account model is Organization → Locations → Connections → Reviews.** A location is the unit of pricing, permissions, reporting and every review. Roles are Owner / Admin / Member / Client, each scopable to specific locations.
- **Two rhythms.** A **daily loop**: a review arrives → notification → triage queue → AI-drafted reply → approve and post. A **weekly loop**: the Action Digest arrives in-app, by email and (once live) on WhatsApp → do the three actions → next week's digest closes the loop.
- **Phone-heavy usage.** Owners act from a phone between customers. Mobile is a primary context, verified at 390px; the app is installable as a PWA with push notifications.
- Thirteen rail entries in three groups (Work / Grow / Setup). The weekly plan is the habit surface; the review queue is the second home.
- Public, unauthenticated surfaces exist and are part of the product: embeddable widgets, the rating badge, hosted `/reviews/{slug}` location pages, the review-collection page, the public survey page, and the no-signup sample digest.

## Capabilities and Constraints

**Built and working:** everything through Phase 4 plus the founder-audit remediation and post-test fix waves. Reviews, AI analysis and reply drafting, the Action Digest (in-app, email, PDF, WhatsApp-shareable text), unified triage with SLA and assignment, widgets/badge/SEO pages, the analytics workspace with scheduled PDF reports, contacts, surveys, two-way messaging, broadcasts, agency white-label, PWA + push, auto-reply for wordless five-star reviews, duplicate detection, CSV/POS contact import.

**Constraints that are true today and must not be overstated:**

- **Everything runs on the mock connector.** Google, WhatsApp and Instagram are fixture- and mock-tested only. No live platform traffic has ever run through them.
- **No commercial message has ever left the machine.** İYS and SMS gateways default to refusing. A `local` consent upload is not a national-registry registration and is recorded as distinguishable forever.
- **What is gated on the company, not on code:** a real İYS BSP adapter, a messaging provider, live Google/Meta credentials, a competitor data source, and additional Turkish sources (Yemeksepeti, Getir, Trendyol Yemek, Trustpilot, Tripadvisor, Facebook) which are shown on the roadmap and deliberately have no connector behind them.
- **No star rich snippets, ever.** Google's review-snippet policy makes a business's own reviews on its own site ineligible, and forbids aggregating other sites' ratings. The hosted page carries `LocalBusiness` markup only. Sales material must never promise stars in search results.
- **No review-gating exists and none may be added** — a public-review invitation may never be computed from a rating, a sentiment or a predicted score, and no audience query may target one.
- **Reviews are personal data.** KVKK/GDPR export and erasure are built and reachable.
- Multi-tenancy is enforced by Postgres row-level security plus per-request tenant context. Location scope is a second, separate boundary that RLS cannot express.

**Terminology (use these words, they are load-bearing):** a **location** is a branch; a **source** is polled and read; a **channel** is pushed to and may carry a message; a **campaign** is a review-collection strategy; a **broadcast** is an outbound send to an audience; the **Action Digest** / weekly plan is the briefing; **Reputation score** is the one name for the composite figure.

**Open product decisions** (recorded, not resolved): whether the hosted review page stays a Starter feature; whether broadcasts belong at Growth or Pro; whether auto-reply widens beyond wordless five-star reviews.

## Brand Commitments

- **Name: Fairfame** (decided 10 Aug 2026, replacing the provisional "Revira"). One word, capital F, in English and Turkish alike — never `FairFame`, never `Fair Fame`, never all-lowercase. "Fair fame" is a real English phrase meaning **good reputation, honourably earned**: the name says what the customer gets, not what the software reads. Turkish suffixes take an apostrophe — Fairfame'e, Fairfame'in. Rationale: `docs/05-business-model-and-gtm.md` §6.
- **Adopted at risk — two gates are open.** TÜRKPATENT + EUIPO (classes 9, 35, 42) screening has not run, and `fairfame.com` has not been bought (HugeDomains fixed-price listing). Both clear before any public use. The name is internal until then.
- **The mark: a seal, not a sticker.** The two f's of *fair* and *fame* share a single crossbar — two words fused — inside a solid circular seal. The shared crossbar *is* the identity; a redraw giving each f its own bar has drawn a different logo. **Embed the shipped SVGs; never redraw.** Primary lockup `brand/fairfame-lockup.svg`; on ink `brand/fairfame-lockup-on-dark.svg`; seal alone `brand/fairfame-symbol.svg` (holds at 16px), on ink `brand/fairfame-symbol-on-dark.svg`. The wordmark ends in an amber full stop — the last word on a reputation.
- **Four brand colours** (`docs/24-brand-guidelines.md` §3): **paper `#FAF7F0`** (marketing and document background — warm on purpose; the app's cool canvas stays in the app), **ink `#10193A`** (text, seal, buttons), **amber `#F5A524`** (the brand's temperature: the full stop, ratings, the murmur's accent words — the only decorative colour the brand has), **indigo `#3D5AF1`** (links and interaction only, never decorative). Flat colour throughout; no gradients, no shadows.
- **Display type is Lora** (editorial serif) for marketing headlines and pull-quotes; **Geist runs everything else**, unchanged. Serif says it, sans runs it — and the brand never re-types UI.
- **The brand stops at the product's edge.** Paper, Lora, the murmur texture and the seal belong to marketing, documents, email chrome, social and print. Inside the app, `docs/15-design-system.md` and `docs/21` are untouched: cool canvas, Geist only, no texture. The two share ink, amber, indigo and the seal — which is what keeps them one company.
- **Superseded mark:** the "R" monogram tile with a live-notification dot (`src/app/icon.svg`, `src/components/brand/logo.tsx`); concepts in `docs/assets/revira-logo-concepts.svg`. Kept as history only.
- **Personality:** trustworthy, clear, calm, professional, AI-native. Confidence through clarity, not decoration. Deliberately the opposite of both the sleazy grey-market review sellers and the cluttered legacy tools.
- **Voice:** plain and specific. The product states what it cannot do rather than hiding it — refusals name a reason, absent data says so in a sentence rather than a dash, and figures name their window. Turkish copy is written in Turkish, not translated from English (`işletme`, never `organizasyon`).
- An in-force design system exists at `docs/15-design-system.md` with a visual language in `docs/21`. It is the incumbent visual authority for the app.

## Evidence on Hand

Real and usable:

- **The running product itself** — screenshots of any built screen are legitimate proof.
- **The public sample digest** (no sign-up) and the sample workspace, which composes a real briefing over vertical-appropriate sample data. Usable as a live demo and lead magnet.
- **Compliance posture as proof** — KVKK export/erasure, İYS consent capture with the registry gap stated honestly, the `/compliance` page, and the structural impossibility of review-gating. This is trust evidence the incumbents cannot easily copy.
- **Accessibility and mobile verification** — `docs/18`, including screen-reader passes.

Real but not yet captured:

- **Named design partners / pilot users exist.** Their names, quotes and permission have not been recorded here. **Ask the owner for the specifics before any of it appears on a page** — do not paraphrase, invent, or compose a representative quote.

Explicitly absent — must never be fabricated: customer logos, testimonials, case studies, review counts, uplift percentages, ROI figures, press mentions, user numbers, uptime claims, security certifications, or any claim that a platform integration is live.

## Product Principles

1. **Tell them what to do, not just what happened.** The briefing, not the chart, is the product. Every number should be actionable and clickable through to the rows behind it.
2. **Say what is true, including what does not work.** Honest capability labels, named refusal reasons, stated absences. A figure a reader cannot verify is a figure they must take on trust.
3. **Compliance is code, not policy.** Consent is checked before every commercial send; review-gating is structurally impossible rather than merely forbidden.
4. **AI assists, a human decides.** Nothing reaches a customer without a person's action, except the one narrow auto-reply case a business explicitly configures.
5. **Turkish and English are equals, and the phone is a primary screen.** Design for longer Turkish strings and for a thumb between customers.
6. **A location is the unit of everything** — pricing, permissions, reporting, and every review.

## Commercial Facts

- **Billing unit:** per location, per month. Seats included; SMS/WhatsApp sends and heavy AI usage are metered add-ons because they are real cost.
- **Public pricing** (TRY, launch market; **use these figures, and expect them to change** — they are repriced for inflation and validated with the first cohort): Starter ₺1.299, Growth ₺3.499, Pro ₺8.999 per location/month; Agency quoted per deal (per-seat + per-location).
- **14-day full-feature trial**, not a crippled free tier. The trial grants top-tier entitlements.
- **Transparent public pricing is a positioning pillar** — a pricing page that hides numbers behind a demo request contradicts the product.
- Entitlements are configuration, not code: packaging changes are one edit to the plan catalog.

## Surfaces in Scope

- **The application** — the signed-in product, thirteen rail entries in three groups.
- **Public product surfaces** — widgets, rating badge, hosted SEO review pages, collection pages, public surveys, the sample digest.
- **A public marketing site — confirmed in scope for this repository.** Landing and pricing belong here. Today `/` only redirects to sign-in and no marketing surface exists. This is a Persuade surface and does not yet have a brief.

## Accessibility & Inclusion

- **WCAG 2.1 AA** is the stated target for the app and the public widgets, and is treated as a requirement rather than an aspiration — contrast is enforced by test against a surface-aware table, not by eye.
- Keyboard and focus order are covered by a browser suite; VoiceOver, NVDA and JAWS have been checked by hand.
- Mobile is verified at a real 390px viewport, with 44px touch targets.
- One theme only — there is no dark mode and none is wanted.
- Users are non-technical and often reading a second language. Jargon, unexplained figures and untranslated strings are accessibility failures here, not cosmetic ones.
