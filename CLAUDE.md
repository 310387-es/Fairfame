# CLAUDE.md — Revira

**Revira** *(provisional name)* is a review & customer-voice management SaaS: businesses connect their review and social sources and receive new-review notifications, AI analysis, and a weekly **Action Digest** (the hero feature). Launch market is Türkiye; the product is built global-ready (EN + TR). The full plan lives in `docs/` — read `docs/02-prd.md`, `docs/03-technical-architecture.md`, and `docs/06-ux-roles-and-flows.md` before building.

## Current phase

**Phase 0 — Foundations.** Build plan: `docs/09-phase-0-build-plan.md`. Build **in the order defined there**, pausing after each task for review. Do **not** build end-user features beyond the Phase 0 vertical slice.

## Stack (locked — do not substitute)

- **Next.js** (App Router) + React + **TypeScript** (strict), Tailwind + shadcn/ui
- **PostgreSQL**, self-hosted via **Docker** (docker-compose)
- **Drizzle** ORM — schema in TS, explicit SQL migrations
- **BetterAuth** (organization plugin) — auth + orgs/roles, stored in our Postgres
- **Redis + BullMQ** — background jobs (Docker)
- **Zod** validation; **next-intl** i18n (`en`, `tr`)
- **Stripe** — skeleton only in Phase 0
- **pnpm**; **pino** logging

## Architecture principles

- **Modular monolith.** One app, strong module boundaries. No microservices.
- **The `Connector` interface is the core abstraction** for every review/social source. Build against a **MockConnector** first; real Google/Meta connectors come later and swap in with zero changes elsewhere.
- **Canonical `reviews` model.** Every source normalizes into it; always keep `raw_payload` (jsonb).
- **Multi-tenancy is non-negotiable.** Every tenant-owned row has `organization_id`. Enforce isolation with Postgres **Row-Level Security** + a per-request tenant context. **Never write a query that isn't tenant-scoped.**
- **Entitlements are a first-class primitive.** Feature access + limits come from plan config, checked **server-side** via `can(org, feature)` / `withinLimit(org, metric)`. Never hardcode `if plan === '...'`.
- **Compliance is code.** No rating-gating anywhere in the product. Commercial messages (SMS/email/WhatsApp) require consent + (Türkiye) İYS check before send. Reviews are personal data (KVKK/GDPR) → support export/delete.

## Repo conventions

- Folder structure: see the build plan. Core dirs: `src/db` (schema/client/migrations), `src/auth`, `src/lib` (tenancy, entitlements, logger), `src/connectors`, `src/jobs`, `src/server`, `src/app`, `src/i18n`, `tests/`.
- TypeScript **strict**, no `any`. Validate all external input with **Zod**.
- Migrations explicit and reviewed; never destructive without a backfill.
- Every mutation of a tenant resource goes through the **tenant-scoped data layer**.
- Tests required for: **tenant isolation (RLS)**, the connector sync, and entitlement checks.
- Secrets only in env (`.env`, gitignored); `.env.example` documents every var. **Never commit secrets.**
- Conventional commits; small, reviewable PRs/commits per task.

## Key contracts

The `Connector` interface, the entitlement keys, and the canonical `reviews` shape are defined in `docs/09-phase-0-build-plan.md`. Treat them as the source of truth and implement them exactly.

## Run

`docker compose up -d` (Postgres + Redis) → `pnpm db:migrate` → `pnpm db:seed` → `pnpm dev`.

## Definition of done for Phase 0

A user can **sign up → create an organization → add a location → connect the Mock source → see seeded reviews in the Inbox**, fully tenant-isolated (proven by an RLS test), with roles and entitlements enforced server-side. That vertical slice proves tenancy + auth + connector + canonical data model end to end.
