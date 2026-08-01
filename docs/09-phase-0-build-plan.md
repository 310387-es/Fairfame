# Phase 0 — Foundations · Build Plan

*Revira (provisional) · the first build sprint · companion to CLAUDE.md and `docs/03-technical-architecture.md`*

> **Goal:** stand up the multi-tenant foundation everything else hangs on, and prove it with one vertical slice. No real end-user features beyond that slice. Build the tasks **in order**; each has acceptance criteria. Pause after each task for review.

## Definition of Done

Sign up → create organization → add location → connect the **Mock** source → seeded reviews appear in the **Inbox** — fully tenant-isolated (RLS test passes), roles + entitlements enforced server-side.

## Prerequisites

Node 20+, pnpm, Docker + Docker Compose. Everything runs locally; no cloud accounts needed for Phase 0 (Stripe is a stub).

---

## Locked Stack

Next.js (App Router) + TS strict · self-hosted Postgres (Docker) · Drizzle · BetterAuth (org plugin) · Redis + BullMQ · Zod · next-intl (en/tr) · Stripe skeleton · pnpm · pino.

## Target Folder Structure

```
/ (repo root)
├── CLAUDE.md
├── docs/                     # planning docs (already present)
├── .env.example
├── docker-compose.yml        # postgres + redis
├── drizzle.config.ts
├── package.json
├── src/
│   ├── app/                  # Next.js routes: (auth) + (app) groups
│   ├── db/                   # schema.ts, client.ts, migrations/, seed.ts
│   ├── auth/                 # better-auth config + org plugin
│   ├── lib/                  # tenancy.ts, entitlements.ts, logger.ts
│   ├── connectors/           # types.ts (Connector), mock.ts, normalize.ts
│   ├── jobs/                 # queue.ts, workers/, schedules
│   ├── server/               # trpc routers / server actions
│   ├── i18n/                 # config + messages/en.json, tr.json
│   └── components/
└── tests/
```

---

## Ordered Tasks

### T1 — Project scaffold & tooling
Init Next.js (App Router, TS strict) + Tailwind + shadcn/ui + pnpm; ESLint/Prettier; pino logger; base `src/` structure.
**Done when:** `pnpm dev` serves a page; lint + typecheck pass in CI-ready scripts.

### T2 — Local infrastructure (Docker)
`docker-compose.yml` with **Postgres** and **Redis**; `.env.example` with all vars; app reads env via a typed config (Zod-validated).
**Done when:** `docker compose up -d` gives a reachable Postgres + Redis; the app connects to both.

### T3 — Drizzle + base schema + migrations
Drizzle setup (`drizzle.config.ts`, client, migration scripts `db:generate`/`db:migrate`). Implement the **Phase 0 schema** (below).
**Done when:** migrations create all tables; `pnpm db:migrate` is idempotent; a `db:seed` seeds plans + a demo org.

### T4 — Multi-tenancy: RLS + tenant context
Enable **Row-Level Security** on every tenant table; policies keyed on a session variable (e.g. `app.current_org`). A request-scoped helper sets the tenant context per authenticated request; a tenant-scoped DB accessor is the only sanctioned query path.
**Done when:** a query without tenant context returns nothing/denied; the RLS isolation test (T11) passes.

### T5 — Auth: BetterAuth + orgs/roles
BetterAuth with the **organization plugin** on our Postgres (Drizzle adapter): email signup/login, session, organization creation, memberships with roles **owner / admin / member / client**. Wire the authenticated session → tenant context (T4).
**Done when:** a user can sign up, create an org, and get an owner membership; role is available server-side for authz.

### T6 — Entitlements primitive + plan seed
Config-driven plans → entitlements. Implement `can(org, feature)` and `withinLimit(org, metric)` (server-side). Seed **Starter / Growth / Pro / Agency** with the keys below. Default new org → trial (top-tier entitlements) or Starter.
**Done when:** a gated action is allowed/denied purely by plan config; changing config changes behavior with no code change.

### T7 — Connector interface + MockConnector
Define the `Connector` interface (below). Implement **MockConnector** (`provider: 'mock'`, `read: 'full'`, `reply: 'api'`) that seeds realistic **TR + EN** reviews (varied rating/sentiment/themes; some with owner replies). Implement `normalize()` → canonical `reviews`, upsert with **dedup on (source, source_review_id)**.
**Done when:** connecting a Mock connection to a location ingests reviews into the canonical table, tenant-scoped, deduped.

### T8 — Background jobs (BullMQ)
BullMQ queues + workers on Redis; a **scheduled sync job** per active connection that calls `fetchReviews(since)` → normalize → upsert; retry with backoff; the Mock can **drip new items** to exercise this.
**Done when:** the sync runs on a schedule and on demand; new mock items appear without a manual DB write.

### T9 — App shell + i18n + navigation
Authenticated layout with left-rail nav (Home/Inbox/Locations/Team/Settings as placeholders), a top-bar **location switcher**, and **next-intl** wired with `en` + `tr` messages.
**Done when:** an authed user sees the shell, can switch locale (TR/EN) and active location.

### T10 — Vertical slice: connect Mock → Inbox
Wire the loop end to end: **Locations** (add/list), **connect Mock source** to a location, and an **Inbox** listing that location's ingested reviews (author, rating, text, date, source).
**Done when:** the Definition of Done is met in the UI.

### T11 — Tests, logging, health
Tests: **tenant isolation (RLS)** — org A cannot read org B's reviews; connector sync (fixtures); entitlement allow/deny. Structured pino logs; a `/health` endpoint.
**Done when:** the three test suites pass; health returns OK; logs are structured.

### T12 — Billing skeleton (Stripe stub)
Stripe client behind an interface (no live checkout in Phase 0); `subscriptions` table links org → plan; plan changes flip entitlements. A local PSP (iyzico) adapter is stubbed for later TRY billing.
**Done when:** assigning a plan to an org changes its entitlements; no real payment flow required yet.

---

## Phase 0 Schema (Drizzle)

Tenant-owned tables carry `organization_id` and have RLS. Timestamps (`created_at`, `updated_at`) on all.

- **organizations** — id, name, slug, plan_id, locale, currency, settings(jsonb)
- **users** — id, email (unique), name, locale *(BetterAuth-managed core; extend as needed)*
- **memberships** — id, organization_id, user_id, role(`owner|admin|member|client`), unique(org,user)
- **locations** — id, organization_id, name, address, category, locale
- **connections** — id, organization_id, location_id, provider, status, capabilities(jsonb), encrypted_tokens, cursor
- **reviews** *(canonical)* — id, organization_id, location_id, source, source_review_id, author_name, rating, text, language, posted_at, url, raw_payload(jsonb), **unique(source, source_review_id)**
- **plans** — id, key(`starter|growth|pro|agency`), name, price_month, interval, entitlements(jsonb), provider_price_id
- **subscriptions** — id, organization_id, plan_id, status, current_period_end, overrides(jsonb)
- **usage_counters** — id, organization_id, metric, period, count
- **audit_logs** — id, organization_id, actor_user_id, action, entity, meta(jsonb), at
- **consent_records** *(stub for later)* — id, organization_id, contact_ref, type(`kvkk|iys`), granted_at, proof_ref

*Insights, replies, requests, contacts, widgets, webhooks: later phases — do not build now.*

## Connector Interface (contract)

```ts
type Capability = {
  read: 'full' | 'excerpt' | 'none'
  reply: 'api' | 'manual' | 'none'
  realtime: boolean
}

interface Connector {
  provider: string                 // 'mock' | 'google' | 'instagram' | 'whatsapp' | 'firstparty' | ...
  capabilities: Capability
  connect(orgId: string, config: unknown): Promise<Connection>
  fetchReviews(conn: Connection, since?: Date): Promise<RawReview[]>
  postReply?(conn: Connection, reviewId: string, text: string): Promise<Result>
  normalize(raw: RawReview): CanonicalReview   // → canonical `reviews` row shape
}
```

MockConnector: `provider: 'mock'`, `capabilities: { read: 'full', reply: 'api', realtime: false }`. Seeds ~30–50 realistic reviews per location across TR + EN, varied sentiment and recurring themes; supports on-demand inject + scheduled drip + simulated errors.

## Entitlement Keys (seed)

- **Feature flags:** `ai_replies`, `social_sources`, `competitor_watch`, `widgets`, `api_access`, `white_label`, `benchmarking`
- **Limits:** `max_locations`, `max_team_members`, `requests_per_month`, `ai_analyses_per_month`
- **Metered add-ons:** `sms_credits`, `whatsapp_conversations`, `ai_tokens`

Seed values per plan mirror `docs/05-business-model-and-gtm.md` §2.1 (config, not code).

## .env.example (create in T2)

```
DATABASE_URL=postgres://revira:revira@localhost:5432/revira
REDIS_URL=redis://localhost:6379
BETTER_AUTH_SECRET=change-me
BETTER_AUTH_URL=http://localhost:3000
NODE_ENV=development
# Stripe (stub in Phase 0)
STRIPE_SECRET_KEY=
```

## Out of Scope for Phase 0

Real platform connectors (Google/Meta), AI analysis + Action Digest, notifications, review requests, widgets, insights/benchmarking, live billing/checkout, agency/white-label UI. These are Phase 1+.

---

## Claude Code Kickoff Prompt

> Read `CLAUDE.md` and `docs/09-phase-0-build-plan.md`. We're starting **Phase 0** of Revira. First, restate the locked stack and the Phase 0 Definition of Done back to me so I know we're aligned. Then begin at **T1** and proceed **in order**, stopping after each task for my review. Use the locked stack exactly — no substitutions. Ask before introducing any dependency not named in the plan.
