# CLAUDE.md — Revira

**Revira** *(provisional name)* is a review & customer-voice management SaaS: businesses connect their review and social sources and receive new-review notifications, AI analysis, and a weekly **Action Digest** (the hero feature). Launch market is Türkiye; the product is built global-ready (EN + TR). The full plan lives in `docs/` — read `docs/02-prd.md`, `docs/03-technical-architecture.md`, and `docs/06-ux-roles-and-flows.md` before building.

## Current phase

**Phase 1a — AI Layer & Action Digest.** Build plan: `docs/10-phase-1a-build-plan.md`. Builds entirely on the existing **MockConnector** (needs an LLM API key, not the gated platform APIs). Build **in order**, pausing after each task for review.

- **Phase 0 (Foundations): complete.** Plan retained at `docs/09-phase-0-build-plan.md`.
- **Phase 1b (real Google / first-party / WhatsApp / Instagram connectors, İYS/consent, live sends): deferred** until the company is formed and the product is otherwise finished. **Do not start 1b work.**

## Stack (locked — do not substitute)

- **Next.js** (App Router) + React + **TypeScript** (strict), Tailwind + shadcn/ui
- **PostgreSQL**, self-hosted via **Docker** (docker-compose); **pgvector** for embeddings
- **Drizzle** ORM — schema in TS, explicit SQL migrations
- **BetterAuth** (organization plugin) — auth + orgs/roles, stored in our Postgres
- **Redis + BullMQ** — background jobs (Docker)
- **Zod** validation; **next-intl** i18n (`en`, `tr`)
- **LLM** via a provider-agnostic abstraction (Anthropic/OpenAI); **Stripe** skeleton
- **pnpm**; **pino** logging

## Architecture principles

- **Modular monolith.** One app, strong module boundaries. No microservices.
- **The `Connector` interface is the core abstraction** for every review/social source. Everything is built against the **MockConnector**; real Google/Meta connectors (Phase 1b) swap in with zero changes elsewhere.
- **Canonical `reviews` model.** Every source normalizes into it; always keep `raw_payload` (jsonb).
- **Multi-tenancy is non-negotiable.** Every tenant-owned row has `organization_id`, enforced with Postgres **Row-Level Security** + a per-request tenant context. **Never write a query that isn't tenant-scoped.**
- **Entitlements are a first-class primitive.** Feature access + limits come from plan config, checked **server-side** via `can(org, feature)` / `withinLimit(org, metric)`. Never hardcode `if plan === '...'`.
- **AI guardrails.** Review text is untrusted input (prompt-injection defense); never put another org's data in a prompt; AI replies never fabricate facts and are length-bounded; every AI action is audit-logged and metered.
- **Compliance is code.** No rating-gating anywhere. Commercial messages (Phase 1b) require consent + (Türkiye) İYS check before send. Reviews are personal data (KVKK/GDPR) → support export/delete.

## Repo conventions

- Core dirs: `src/db`, `src/auth`, `src/lib` (tenancy, entitlements, logger), `src/connectors`, `src/jobs`, `src/server`, `src/app`, `src/i18n`, `src/prompts`, `tests/`.
- TypeScript **strict**, no `any`. Validate all external input with **Zod**.
- Migrations explicit and reviewed; never destructive without a backfill.
- Every mutation of a tenant resource goes through the **tenant-scoped data layer**.
- Tests required for: **tenant isolation (RLS)**, connector sync, entitlement checks, **AI guardrails**, and digest reproducibility.
- Secrets only in env (`.env`, gitignored); `.env.example` documents every var. **Never commit secrets.**

## Key contracts

The `Connector` interface and entitlement keys are in `docs/09-phase-0-build-plan.md`; the `review_insights` shape, the Digest object, and AI guardrail rules are in `docs/10-phase-1a-build-plan.md`. Treat them as the source of truth and implement exactly.

## Run

`docker compose up -d` (Postgres + Redis + Mailhog) → `pnpm db:migrate` → `pnpm db:seed` → `pnpm dev`.

## Docs

`docs/` holds the full plan (01 master → 10 Phase 1a). Read 02, 03, 06 before building; 09/10 are the active build plans.
