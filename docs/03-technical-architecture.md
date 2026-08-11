# Technical Architecture — Review SaaS

*Working name: **Revira** (provisional) · v1 · August 2026 · Companion to the Master Plan & PRD*

> This document is the engineering source of truth: system design, the connector framework, the data model, infrastructure, and how we handle security and Türkiye compliance (KVKK / İYS) at the code level. It assumes a senior engineer building with Claude Code and favors boring, proven technology with clean module seams.

Table of Contents

* * *

## 1\. Architectural Principles

1. **Modular monolith first.** One deployable application with strong internal module boundaries. We split a module into its own service only when a real scaling or isolation need appears — not preemptively. This maximizes velocity for a solo/small team.
2. **One language end\-to\-end:** TypeScript across frontend, backend, and workers. Shared types for the API contract.
3. **The Connector is the core abstraction.** Every review source implements one interface. Adding a source must not touch the rest of the system.
4. **Canonical data model.** Every source normalizes into one `Review` shape; raw payloads are retained for re\-processing.
5. **Compliance is code, not policy.** İYS/KVKK constraints are enforced by the system, not left to user discipline.
6. **Multi\-tenant by construction.** `organization_id` on every tenant\-owned row, enforced at the data layer.

* * *

## 2\. High\-Level System Diagram (logical)

```
                    ┌─────────────────────────────┐
   Browser  ─────▶  │  Web App (Next.js, TR/EN)   │
   Widgets  ─────▶  │  + Public/Widget API + tRPC │
                    └───────────────┬─────────────┘
                                    │
                    ┌───────────────▼─────────────┐
                    │      Application Core        │
                    │  Auth · RBAC · Orgs · Billing│
                    │  Reviews · Replies · Insights│
                    │  Campaigns · Notifications   │
                    └───┬───────────┬───────────┬──┘
                        │           │           │
             ┌──────────▼──┐  ┌─────▼──────┐ ┌──▼─────────┐
             │ Connector   │  │  AI        │ │ Notification│
             │ Framework   │  │  Service   │ │  Service    │
             │ (workers)   │  │ (workers)  │ │ (email/SMS/ │
             │             │  │            │ │  WhatsApp)  │
             └──────┬──────┘  └─────┬──────┘ └──────┬─────┘
                    │               │               │
   External APIs ◀──┘        LLM/Embeddings   İYS · ESP · SMS
   (Google, Yandex,                            gateways
    Trustpilot, app stores…)

   Data plane:  PostgreSQL (+ pgvector)  ·  Redis (cache/queues)  ·  Object storage (media)
```

* * *

## 3\. Technology Stack (with rationale)

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | **Next.js (App Router) \+ React \+ TypeScript**, Tailwind \+ shadcn/ui | One framework for app \+ API routes; SSR for dashboards; huge ecosystem; great with Claude Code |
| Widget | Separate tiny **Preact/vanilla** bundle, CDN\-served | Must be lightweight and framework\-agnostic on customer sites |
| Internal API | **tRPC** (typed) | End\-to\-end type safety inside the monolith |
| Public API | **REST \+ webhooks**, OpenAPI spec | External/agency/integrations need a stable contract |
| Backend runtime | **Node.js** (Next route handlers; extract to Fastify/NestJS service if needed) | Same language; simple to operate |
| Database | **PostgreSQL** (managed: Supabase or Neon) | JSONB for raw payloads, full\-text search, `pgvector` for embeddings, RLS for tenancy — one DB does a lot |
| ORM | **Drizzle** or **Prisma** | Typed schema \+ migrations |
| Cache/Queues | **Redis** \+ **BullMQ** (or **Inngest** for scheduled/rate\-limited flows) | Sync scheduling, retries, backoff, fan\-out |
| Auth | **Auth.js** / Clerk / Supabase Auth | Org\-aware, OAuth\-capable |
| Payments | **Stripe** (subscriptions \+ metered usage) \+ **iyzico**/local for TRY | Stripe global; a local PSP for Turkish cards/invoicing |
| AI | Provider APIs (Claude / OpenAI) behind our own interface | Swap models; keep prompts \+ guardrails in one place |
| Email/SMS | ESP (Postmark/SES) \+ **Turkish SMS gateway with İYS integration** (e.g. Netgsm/İleti providers) | İYS compliance requires a gateway that checks the registry |
| Infra | **Railway** — web \+ worker as two services from one image, with Postgres \+ Redis | One artifact, two process types; the worker is long\-lived and Vercel has nowhere to run it |
| Storage/CDN | S3 / Cloudflare R2 \+ CDN | Review media \+ widget delivery |
| Observability | Sentry \+ structured logs \+ uptime/metrics | See failures before customers do |

**Alternatives considered:** a Python service for NLP (rejected for MVP — provider LLMs \+ pgvector cover sentiment/themes without a separate ML stack; revisit if we train custom models). Microservices from day one (rejected — premature for our size).

* * *

## 4\. The Connector Framework *(the heart of the product)*

Every source implements one interface. Capabilities are declared, so the UI and scheduler adapt automatically.

```ts
interface Connector {
  provider: 'google' | 'yandex' | 'trustpilot' | 'appstore' | 'playstore' | 'firstparty' | ...
  capabilities: {
    read: 'full' | 'excerpt' | 'none'
    reply: 'api' | 'manual' | 'none'
    realtime: boolean
  }
  connect(orgId, config): Promise<Connection>       // OAuth / API key handshake
  fetchReviews(conn, since?): Promise<RawReview[]>   // pull; respect rate limits
  postReply?(conn, reviewId, text): Promise<Result>  // only if reply === 'api'
  normalize(raw: RawReview): CanonicalReview          // → canonical model
}
```

Supporting pieces:

- **Token vault:** OAuth tokens/API keys encrypted at rest (envelope encryption); auto\-refresh; per\-connection status.
- **Sync scheduler:** per\-connection cron respecting each platform's rate limits; incremental (`since` cursor) \+ periodic full reconcile; backoff on 429s.
- **Normalizer:** maps each provider's payload into `CanonicalReview`; keeps `raw_payload` (JSONB) for re\-processing when we improve mapping.
- **Capability\-driven UI:** a `reply: 'none'` source renders "Open on platform" instead of a reply box; a `read: 'excerpt'` source is labeled *Monitor only*.

**Source reality (drives the roadmap — see Market doc):** Google \= full read \+ API reply (gated approval); first\-party \= full/ours; app stores \= full for own apps; Trustpilot \= API; **Yandex** \= business\-managed, limited/no official reply API (monitor \+ deep\-link); Yelp/TripAdvisor/Meta \= excerpt/monitor only. We ship connectors in that order of accessibility.

* * *

### 4\.1 MVP Connectors & Platform Approvals

MVP ships four connectors: **Google Business Profile** (full read \+ API reply), **first\-party** (fully ours), **WhatsApp Business API** (collection \+ notifications \+ digest delivery), and **Instagram** via the **Meta Graph API** (comment/mention/DM ingestion; reply where permitted). Reality to plan around: **Google and Meta access are both approval\-gated with multi\-week lead times** — Meta requires app review \+ business verification, and WhatsApp additionally needs a BSP, template approval, and İYS. We therefore **apply for Google and Meta in parallel at project start**, and build in the order Google \+ first\-party \+ WhatsApp requests → Instagram ingestion as approval clears, so a slow Meta review cannot block launch. Social sources are modeled as ordinary `Connector`s — the abstraction already handles non\-review sources (mentions/comments/DMs become normalized items tagged by `source` and `type`).

### 4\.2 Mock Connector — Development Strategy

Real platform access (Google, Meta) is requested only after company formation, so **we develop against a `mock` connector first.** It implements the same `Connector` interface (`provider: 'mock'`, `read: 'full'`, `reply: 'api'`), so the real connectors swap in later with **zero changes** to ingestion, AI, notifications, digests, or UI.

The mock seeds realistic data mirroring live sources — Google\-style reviews (rating, author, text, date, owner reply), Instagram mentions/comments, and WhatsApp messages — in **Turkish and English**, across varied sentiment and recurring themes, so AI analysis and the Action Digest have genuine material. It can **drip new items on a schedule** (to exercise notifications), **inject on demand** (for demos), and **simulate rate limits / errors** (to test resilience). Net effect: the entire Core Loop and hero digest can be built, demoed, and shown to design\-partner prospects before any real API is live.

## 5\. Data Model

Core tables (all tenant\-owned rows carry `organization_id`):

| Table | Key columns | Notes |
| --- | --- | --- |
| `organizations` | id, name, plan, locale, currency | The tenant |
| `users` | id, email, auth\_id, locale |  |
| `memberships` | org\_id, user\_id, role | owner/admin/member/client |
| `locations` | id, org\_id, name, address, geo | A managed business/place |
| `connections` | id, org\_id, location\_id, provider, status, capabilities, encrypted\_tokens, cursor | One per linked source |
| `reviews` | id, org\_id, location\_id, source, source\_review\_id (unique per source), author\_name, rating, text, language, posted\_at, url, raw\_payload(JSONB) | **Canonical**; dedup on (source, source\_review\_id) |
| `review_insights` | review\_id, sentiment, sentiment\_score, topics(text\[\]), embedding(vector) | AI output; pgvector for search/clustering |
| `replies` | id, review\_id, author\_user\_id, text, ai\_generated(bool), status, posted\_at | Draft → approved → posted |
| `contacts` | id, org\_id, name, email, phone, consent\_state, iys\_status | Customers we may message |
| `review_requests` | id, org\_id, contact\_id, channel, campaign\_id, status, sent\_at, converted\_at | Outbound asks |
| `campaigns` | id, org\_id, channel, template, routing, schedule | Collection strategy |
| `widgets` | id, org\_id, public\_key, filters, style | Embeddable display |
| `webhooks` | id, org\_id, url, events(text\[\]), secret | Public API events |
| `subscriptions` | org\_id, stripe\_ids, tier, usage\_counters | Billing state |
| `audit_logs` | org\_id, actor, action, entity, meta, at | Security/compliance trail |
| `consent_records` | contact\_id, type (kvkk/iys), source, granted\_at, proof\_ref | **Compliance evidence** |

**Relationships:** `organization` 1—\* `locations` 1—\* `connections` 1—\* `reviews` 1—\* `replies`; `reviews` 1—1 `review_insights`; `organization` 1—\* `contacts` 1—\* `review_requests`.

**Design rules:** normalize aggressively but never discard `raw_payload`; enforce dedup at the DB level; sentiment/embeddings are derived data we can recompute.

* * *

## 6\. AI Layer

- **Reply drafting:** prompt with review text \+ brand tone \+ guardrails; output in the review's language; never fabricates facts (no invented offers/claims); length\-bounded.
- **Sentiment \+ theme extraction:** per\-review classification \+ topic tagging; Turkish\-quality is a first\-class requirement (evaluate models on Turkish review samples; keep a labeled test set).
- **Embeddings \+ semantic search:** store review embeddings in `pgvector` for "find similar complaints," theme clustering, and trend detection.
- **Guardrails:** treat all review text as untrusted input (prompt\-injection defense); strict tenant scoping (no cross\-org context in a prompt); every AI action audit\-logged; model provider abstracted so we can swap/route.
- **Cost control:** batch analysis; cache; meter heavy usage against plan limits.

* * *

### 6\.1 The Action Digest Pipeline *(hero feature)*

The weekly Action Digest is generated by a scheduled per\-location job: (1) gather the window's reviews \+ social items \+ their insights; (2) cluster themes via embeddings (pgvector) and quantify praise/complaint counts; (3) compute the reputation pulse and deltas vs the prior window; (4) attribute staff/location mentions; (5) an LLM composes a localized briefing with **3 evidence\-linked actions**, plus draft replies for open negatives and one social post from the top review; (6) persist the digest and prior\-action outcomes so the next one can close the loop; (7) deliver via in\-app \+ email \+ WhatsApp. A public **sample\-digest** path runs the same pipeline over a prospect's public Google reviews for lead\-gen. Guardrails and tenant\-scoping from §6 apply; the digest is fully reproducible from stored data.

## 7\. Multi\-Tenancy & Security

- **Isolation:** shared DB/schema, `organization_id` on every row, enforced via Postgres **Row\-Level Security** (natural on Supabase) or a strict repository layer that injects the tenant scope on every query. Escalate to per\-tenant schema only for a future enterprise requirement.
- **AuthZ:** RBAC (owner/admin/member/client); agency "client" role sees only its scope.
- **Secrets:** OAuth tokens and PII encrypted at rest; envelope encryption; secrets in a managed vault, never in code.
- **Auditing:** append\-only `audit_logs` for security\-relevant actions.
- **Least privilege:** request the minimum OAuth scopes each platform allows.

* * *

### 7\.1 Plans, Entitlements & Feature\-Gating

Different plans unlock different features and limits, so **entitlements are a first\-class primitive built in Phase 0** — retrofitting feature\-gating into a codebase that assumed "everyone gets everything" is painful.

**Model (config\-driven, not hardcoded):**

- `plans` — id, name, price, interval, provider price id.
- **Entitlements per plan** — a set of keys: *feature flags* (`ai_replies`, `social_sources`, `competitor_watch`, `widgets`, `api_access`, `white_label`, `benchmarking`), *numeric limits* (`max_locations`, `max_team_members`, `requests_per_month`, `ai_analyses_per_month`), and *metered add\-ons* (`sms_credits`, `whatsapp_conversations`, `ai_tokens`).
- `subscriptions` — org\_id, plan\_id, status, current\_period, plus per\-org **overrides** (custom deals, comps, agency pricing, grandfathered plans).
- `usage_counters` — org\_id, metric, period, count.

**Enforcement:** a single entitlements service exposes `can(org, feature)` and `withinLimit(org, metric)`. Checks run **server\-side on every gated action** (never trust the client); the UI mirrors them by locking features and showing a contextual upgrade prompt at the exact moment a limit is hit. Metered counters increment on use and reset each billing period.

**Billing:** each plan maps to a Stripe Price (metered add\-ons → usage\-based prices); a local PSP (**iyzico**) handles TRY. Provider webhooks keep `subscriptions` in sync — created / updated / canceled, and **payment failed → dunning → downgrade**. The 14\-day trial grants top\-tier entitlements, then downgrades on expiry; proration is handled by the billing provider.

**Why now:** once this exists, every new feature simply declares its entitlement key and calls `can()`. Packaging changes, pricing experiments, and grandfathering become configuration, not code — exactly what we want when the plans will evolve.

## 8\. Türkiye Compliance — Technical Handling *(KVKK & İYS)*

This is a build requirement, not a legal footnote.

**İYS (İleti Yönetim Sistemi):** any commercial SMS/email — including review\-request messages — legally requires prior consent registered in İYS. Implementation:

- Integrate a **Turkish SMS/message gateway that is İYS\-connected**; before any send, check the recipient's İYS consent state via the gateway/API.
- Capture consent through İYS\-compliant opt\-in, store a `consent_record` with proof, and **upload new consent to İYS within 3 business days** (manual or API).
- Enforce **opt\-out** immediately and honor it on subsequent sends.
- **Block** any send lacking valid consent, with a clear in\-product reason.

**KVKK (data protection):** reviews contain personal data. Implementation:

- Present KVKK notices alongside İYS consent (they are separate obligations — one does not replace the other).
- Data\-subject rights: export and delete flows; retention policy; a DPA for customers.
- Consider **data residency** (Türkiye/EU region hosting) as a selling point and a possible requirement.

**Platform ToS:** never scrape where prohibited; use official APIs; clearly separate ourselves from the "buy reviews" grey market (a compliance *and* brand stance).

* * *

### 8\.1 WhatsApp & Meta — Consent Specifics

WhatsApp Business messaging (digests, notifications, review requests) requires recipient opt\-in and pre\-approved message templates under Meta's rules, **and** İYS consent for commercial messages in Türkiye — both are enforced before any send. Instagram/Meta data access is limited to permitted scopes granted through Meta app review; we request the minimum and never scrape. WhatsApp consent state is tracked in `consent_records` alongside İYS/KVKK.

## 9\. Public API & Extensibility

- REST API (OpenAPI) for reviews, insights, requests, and widget data — enables agencies and integrations.
- **Webhooks** for events (`review.created`, `review.negative`, `reply.posted`) with signed payloads.
- Marketplace\-ready: a Shopify app and WordPress plugin wrap the same API in later phases.

* * *

## 10\. Environments, CI/CD, Testing

- **Environments:** local → staging → production; seeded demo data. Staging builds with `NODE_ENV=production` like production does, so it sets `NEXT_PUBLIC_SENTRY_ENVIRONMENT=staging` explicitly — without it, staging's errors are indistinguishable from a customer's in every alert.
- **Deployment shape (Railway):** **two services from one image**, differing only in their start command — `web` runs `next start`, `worker` runs `node scripts/worker.mts`. One artifact deliberately: it is what guarantees the worker and the web app run identical code against identical schema, and separate images drift into jobs failing against a table the worker has not learned about yet. They scale on different signals — web on request latency, worker on **queue depth**, which is also the alert that catches a dead worker. Nothing background runs without the worker service, and its absence is silent: the queue keeps accepting jobs nobody consumes.
- **CI/CD:** GitHub Actions — lint, typecheck, test, migrate, deploy. CI builds only to prove the build compiles and holds **no** Sentry credentials; source maps upload from the deploy, never from a pull request.
- **Testing:** unit (business logic, normalizers), integration (connectors against recorded fixtures), e2e (the Core Loop), and an **NLP eval set** for Turkish/English sentiment quality.
- **Migrations:** versioned, reversible; never destructive without a backfill.

* * *

## 11\. Build Order (maps to PRD phases)

1. **Phase 0:** app scaffold, auth, tenancy \+ RLS, `Review` model \+ `Connector` interface, jobs, billing skeleton, i18n, observability.
2. **Phase 1:** Google connector \+ first\-party collection, ingestion/sync, notifications, AI analysis \+ reply drafting, trends dashboard, İYS/KVKK enforcement.
3. **Phase 2:** more connectors (capability\-driven), unified inbox, team workflow, public API \+ webhooks.
4. **Phase 3:** widgets \+ SEO pages, deeper analytics, benchmarking, exports.
5. **Phase 4:** engagement (messaging/surveys/CRM), white\-label/agency.

*Companion documents: Master Plan, PRD, Türkiye Market Analysis, Business & GTM.*
