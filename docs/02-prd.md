# Product Requirements Document — Review SaaS

*Working name: **Revira** (provisional) · v1 · August 2026 · Owner: Omer · Companion to the Master Plan*

> This PRD defines **what** we build and **why**, and the acceptance criteria that tell us a feature is done. It does not prescribe implementation — that lives in the Technical Architecture document. Scope is organized by the phases in the Master Plan; we build them in order.

Table of Contents

* * *

## 1\. Overview & Goals

**Product:** A platform where any business connects its review sources, then receives new\-review notifications, AI analysis, and trend insights in one place — and, over time, collects, responds to, showcases, and acts on reviews.

**Primary goal (first 12 months):** Prove that a business will connect at least one source, get ongoing value from notifications \+ AI insights, and pay monthly to keep it. Launch market is Türkiye; the product is built global\-ready (English \+ Turkish, multi\-currency).

**Product goals:**

- Time\-to\-value under 10 minutes: sign up → connect a source → see real reviews and a first insight.
- Every new review surfaces to the right person fast, with an AI\-drafted response ready.
- Turn raw reviews into decisions: sentiment, themes, and trends a non\-analyst understands.
- Be provably compliant (KVKK, İYS, platform ToS) — a trust advantage, not an afterthought.

**Non\-goals (for now):** We are not building a review *network* (like Trustpilot), not buying/selling reviews, and not promising two\-way management of platforms whose APIs forbid it.

* * *

## 2\. Target Users & Personas

| Persona | Who | Core need | What success looks like for them |
| --- | --- | --- | --- |
| **Owner\-operator** ("Deniz") | Runs 1–3 local businesses (clinic, salon, café, auto shop) | More reviews, know when something's wrong, look responsive | Gets more Google reviews, never misses a bad one, replies in minutes |
| **Marketing manager** ("Elif") | Handles reputation for a multi\-location brand | One dashboard across locations, reporting to leadership | Compares locations, shows trend reports, delegates replies |
| **Agency operator** ("Can") | Manages reviews for many SMB clients | Manage many clients efficiently, white\-label | Runs 20 clients from one seat, branded to their agency |
| **Ops/CX lead** ("Aylin") | Owns customer experience at a growing company | Turn review feedback into product/ops fixes | Sees themes over time, exports insights, closes the loop |

The **owner\-operator** and **marketing manager** are the MVP focus. Agency and enterprise features come in later phases.

* * *

## 3\. Core Product Principles

1. **The connect flow is the product's front door** — it must be effortless and clearly communicate what each source can and can't do.
2. **Honest capability labeling** — every source is tagged *Live sync* / *Monitor only* / *Display only* so we never over\-promise (see Market/Architecture docs on API limits).
3. **AI assists, humans decide** — AI drafts replies and surfaces insights; a person approves anything that goes public (configurable auto\-mode later).
4. **Compliant by default** — review\-request flows cannot be configured in a non\-compliant way (no rating\-gating; İYS/KVKK consent enforced in\-product).
5. **Bilingual from day one** — full Turkish and English UI, Turkish\-first NLP quality for sentiment/themes.

* * *

## 4\. The Core Loop (MVP heart)

The loop every user experiences, and the one we must nail before anything else:

**Connect → Ingest → Notify → Analyze → Trend → Act**

1. **Connect** a source (OAuth for Google; add others as available). We show its capability level honestly.
2. **Ingest** existing \+ new reviews into a normalized store; keep syncing on schedule.
3. **Notify** the right people of new reviews (in\-app, email, later SMS/WhatsApp), prioritizing negative ones.
4. **Analyze** each review: sentiment, topics/themes, language — and draft an on\-brand reply.
5. **Trend** — roll analysis into dashboards: rating over time, sentiment shift, top themes, per\-location.
6. **Act** — reply (to reply\-capable sources), tag, assign, or export an insight.

* * *

## 5\. Functional Requirements by Phase

### Phase 0 — Foundations *(no end\-user features; enables everything)*

Multi\-tenant accounts (org → locations → members), authentication, role\-based access, Stripe billing scaffold, the canonical Review model, the Connector framework, background jobs, notifications infrastructure, audit logging, TR/EN i18n scaffold.

### Phase 1 — MVP: Connect \+ Collect \+ Notify \+ AI Digest *(the wedge)*

The Core Loop end\-to\-end across **Google Business Profile, first\-party collection, WhatsApp, and Instagram**, with notifications, AI analysis, AI reply drafting, and — as the flagship — the **AI Action Digest** (Voice of Customer). Because Google *and* Meta (Instagram \+ WhatsApp Business API) access are approval\-gated with multi\-week lead times, we **apply for both in parallel at project start** and sequence the build as Google \+ first\-party \+ WhatsApp requests first (fastest to value), with Instagram ingestion landing as Meta approval clears — so a slow review cannot stall launch. Detailed specs in §6.
**Done when:** a paying customer connects Google \+ at least one social source, collects reviews (including via WhatsApp), and receives a weekly AI Action Digest that tells them what to do — end to end.

### Phase 2 — Monitor \+ Respond

Add every connectable source into a unified inbox (live\-sync where allowed, monitor\-only elsewhere), team workflow (assign, status, SLA), reply templates, saved filters, real\-time alerts.

### Phase 3 — Showcase \+ Analyze

Embeddable review widgets/badges, auto\-generated SEO review pages with `LocalBusiness` schema.org markup (**not** review or rating markup — see below), deeper analytics (theme trends, per\-location/staff performance, competitor benchmarking), scheduled report exports (PDF/email).

> **Corrected 5 Aug 2026 — no star snippets.** Earlier drafts of this document and of `docs/01` implied review rich snippets. Google's review\-snippet policy makes a business's own reviews on its own site ineligible for the star feature, and separately forbids aggregating other sites' ratings — which is what we ingest. The hosted page therefore carries `LocalBusiness` markup only, and the widget and badge carry none. Rationale and source: the P3\-T3 amendment in `docs/19`. **Do not promise stars in search results anywhere in sales material.**

### Phase 4 — Engage

Two\-way messaging (WhatsApp/SMS), NPS/CSAT surveys, contact profiles / light CRM, campaigns, plus agency white\-label and multi\-location bulk management.

* * *

## 6\. MVP Detailed Specifications

User stories with acceptance criteria. "AC" \= acceptance criteria; a story is done only when all are met.

### 6\.1 Onboarding & Connect

| \# | User story | Acceptance criteria |
| --- | --- | --- |
| C1 | As an owner, I can sign up and create my organization and first location in minutes. | Email/OAuth signup; org \+ location created; TR or EN chosen; lands on an empty\-state dashboard that guides me to connect a source. |
| C2 | As an owner, I can connect my Google Business Profile via secure OAuth. | Google OAuth completes; locations listed and mapped; tokens stored encrypted; status shows *Live sync*; localized error on failure. |
| C3 | As an owner, I can connect Instagram and WhatsApp. | Instagram (Meta Graph) connects for comment/mention/DM ingestion; WhatsApp Business connects for requests \+ notifications; capability \+ approval status shown honestly; graceful state while Meta approval is pending. |
| C4 | As an owner, I understand what each source can do before/after connecting. | Each source shows a capability badge (*Live sync* / *Monitor only* / *Display only*) and a one\-line explanation. |
| C5 | As an owner, my existing reviews and social items import automatically after connecting. | Historical items backfilled within minutes; progress shown; visible in the inbox with author, rating/type, text, date, source. |

### 6\.2 Notifications

| \# | User story | Acceptance criteria |
| --- | --- | --- |
| N1 | As an owner, I'm notified of new reviews without checking the app. | New review triggers in\-app \+ email notification within the sync interval; negative reviews (≤3★ or negative sentiment) flagged urgent. |
| N2 | As a user, I can control what/when I'm notified. | Per\-user, per\-location notification preferences (all / negative only / off); digest vs. instant; changes take effect immediately. |

### 6\.3 AI Analysis

| \# | User story | Acceptance criteria |
| --- | --- | --- |
| A1 | As a user, each review is auto\-analyzed for sentiment and themes. | Every ingested review gets a sentiment label (pos/neu/neg \+ score) and 1–N topic tags; Turkish and English handled with comparable quality; results stored and filterable. |
| A2 | As a user, I get an AI\-drafted reply I can edit before posting. | Draft reply generated in the review's language, in a configurable brand tone; I can edit; nothing posts without my action (MVP); drafts respect a max length \+ no fabricated facts. |
| A3 | As a user, I trust the AI isn't making things up or leaking data. | Prompt\-injection guardrails on review text; no cross\-tenant data in prompts; AI actions are audit\-logged. |

### 6\.4 Trends Dashboard

| \# | User story | Acceptance criteria |
| --- | --- | --- |
| T1 | As a manager, I see rating and sentiment trends over time. | Dashboard shows average rating and sentiment by week/month, per location, with source filter; loads in \<2s for a typical account. |
| T2 | As a manager, I see what customers talk about most. | Top themes ranked with volume \+ sentiment; click a theme to see its reviews; time\-range selectable. |
| T3 | As a manager, I can export a summary. | One\-click export (PDF/CSV) of the current view; localized; includes date range and location. |

### 6\.5 Collect (first\-party requests) — *compliance\-critical*

| \# | User story | Acceptance criteria |
| --- | --- | --- |
| R1 | As an owner, I can request reviews from customers by email/SMS. | Create a request campaign; send via email/SMS; message localized; delivery status tracked. |
| R2 | As an owner, requests are compliant by construction. | In Türkiye, SMS/email requests require captured consent \+ İYS check before send; KVKK notice attached; opt\-out honored; **no rating\-based gating option exists in the UI**; sends without valid consent are blocked with a clear reason. |
| R3 | As an owner, I can route requests to the right destination. | Configure destination (Google, first\-party page); QR/short\-link generation; conversions tracked (sent → opened → left review). |

* * *

### 6\.6 AI Action Digest — the hero *(retention engine)*

The flagship feature: a weekly (and on\-demand) per\-location briefing that turns all reviews \+ social into decisions, delivered in\-app, by email, and via WhatsApp.

| \# | User story | Acceptance criteria |
| --- | --- | --- |
| D1 | As an owner, I get a weekly digest that tells me what to do, not just numbers. | Per\-location digest with: reputation pulse (score \+ weekly delta); what changed vs last week; recurring praise/complaint themes with counts \+ real quotes; staff/location callouts; and **3 prioritized, specific actions**, each tied to evidence. Localized TR/EN. |
| D2 | As an owner, the digest hands me ready\-to\-use assets. | Includes draft replies for open negative reviews and one social post generated from the week's best review; one click to use each. |
| D3 | As an owner, the digest closes the loop. | The next digest reports whether the prior week's actions moved the metric (e.g., wait\-time complaints down). |
| D4 | As an owner, I receive it where I work. | Delivered in\-app \+ email \+ WhatsApp (İYS\-compliant); frequency configurable; easily forwardable to my team. |
| D5 | As a prospect, I can preview value before signing up. | A public, no\-signup **sample digest** can be generated from a business's public Google reviews as a lead magnet. |

## 7\. Non\-Functional Requirements

- **Localization:** Full TR \+ EN UI; locale\-correct dates/numbers/currency; Turkish\-quality NLP for sentiment/themes; architecture ready for more languages.
- **Performance:** Dashboard \<2s typical; new review visible within the source's sync interval; ingestion resilient to rate limits.
- **Security:** Encryption at rest for OAuth tokens/PII; strict tenant isolation; RBAC; full audit log; least\-privilege OAuth scopes.
- **Compliance:** KVKK (data subject rights: export/delete, DPA, data residency consideration), İYS for commercial messaging, and each platform's ToS. GDPR\-ready for global expansion.
- **Reliability:** Background jobs retry with backoff; connector failures degrade gracefully and alert the user; no data loss on partial syncs.
- **Observability:** Error tracking, structured logs, sync health per connection surfaced to the user.
- **Accessibility:** WCAG 2.1 AA target for the app and public widgets.

* * *

## 8\. Out of Scope (v1)

Buying/generating fake reviews (ever); guaranteed two\-way sync for closed platforms; a public review network; native mobile apps (responsive web first); advanced CRM/marketing automation (Phase 4\+).

* * *

## 9\. Success Metrics

- **Activation:** % of signups that connect ≥1 source and view an insight within 24h (target: high).
- **Value:** weekly active accounts viewing notifications/trends; AI replies used per account.
- **Retention:** month\-3 logo retention; source stays connected.
- **Compliance integrity:** zero non\-compliant sends; zero rating\-gating incidents.
- **Business:** trial→paid conversion; MRR; churn.

* * *

## 10\. Open Questions

- Which non\-Google sources do TR customers most want first (Yandex? sector sites)? Validate with the first 10 customers.
- Auto\-reply (no human approval) — offer as an opt\-in in Phase 2, or hold longer for trust?
- Do we need WhatsApp for requests at MVP given its dominance in Türkiye, or is SMS/email enough to start?

*Companion documents: Master Plan, Technical Architecture, Türkiye Market Analysis, Business & GTM.*
