# CLAUDE.md — Revira

**Revira** *(provisional name)* is a review & customer-voice management SaaS: businesses connect their review and social sources and receive new-review notifications, AI analysis, and a weekly **Action Digest** (the hero feature). Launch market is Türkiye; the product is built global-ready (EN + TR). The full plan lives in `docs/` — read `docs/02-prd.md`, `docs/03-technical-architecture.md`, and `docs/06-ux-roles-and-flows.md` before building.

## Current phase & roadmap

- **Phase 0 (Foundations): complete.** `docs/09-phase-0-build-plan.md`.
- **Phase 1a — AI Layer & Action Digest: complete (2 Aug 2026).** `docs/10-phase-1a-build-plan.md`. **T1**–**T11**, all live-verified against a real model: provider abstraction + guardrails, pgvector + insights, sentiment/theme extraction, analysis wired into ingestion, notifications, AI reply drafting, the Action Digest pipeline, the Home/Digest screen, Inbox enhancements, the public sample digest, and guardrail validation. Guardrail evidence: `docs/12-ai-guardrail-validation.md`.
- **Phase 1b — Real Connectors: code-complete (3 Aug 2026).** `docs/11-phase-1b-build-plan.md`. **T0** connector infrastructure (OAuth + encrypted token vault + provider flags + rate limiting/backoff), **T1** first-party collection (live-tested), **T2** Google, **T3** WhatsApp Business, **T4** Instagram, **T5** İYS/KVKK compliance layer (done, less the real registry adapter), **T6** contract tests + go-live suite.
- **Phase 1 is built. What remains is live verification, and it is gated on the company, not on code.** T2, T3 and T4 are **fixture-tested only** — no live platform traffic has ever run through them. Do not describe them as working. `docs/13-go-live.md` holds the per-platform prerequisites and verification steps; `pnpm golive` reports readiness and makes no writes. Known gaps: Instagram DMs unimplemented; no İYS opt-in tick on the collection form and no worker draining `pendingIysUploads`, so nothing commercial can be sent yet; no browser/UI test layer by decision; `MOVABLE_HOLIDAYS` needs a yearly refresh past 2027.

Build tasks **in order** within a phase, pausing after each for review.

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
- **The `Connector` interface is the core abstraction** for every review/social source. Everything runs on the **MockConnector** by default; real connectors (Phase 1b) implement the same interface and swap in per flag/credentials with zero changes elsewhere.
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
- Real connectors default to **mock in dev**; live only where credentials are present. Never commit secrets.
- Tests required for: **tenant isolation (RLS)**, connector sync (fixtures), entitlement checks, **AI guardrails**, digest reproducibility, and per-connector contract tests.

## Key contracts

The `Connector` interface + entitlement keys: `docs/09-phase-0-build-plan.md`. The `review_insights` shape, Digest object, and AI guardrails: `docs/10-phase-1a-build-plan.md`. Per-platform connector go-live prerequisites and verification: `docs/13-go-live.md`. Implement exactly.

## Run

`docker compose up -d` (Postgres + Redis + **Mailpit**, the maintained MailHog successor — dev inbox at `localhost:8025`) → `pnpm db:migrate` → `pnpm db:seed` → `pnpm dev`.

`pnpm verify` is the gate (lint, types, unit + DB tests, build). `pnpm golive` reports per-platform go-live readiness; it is read-only and "not configured" is its expected answer today.

AI operator commands: `pnpm ai:smoke` (one call, checks the key and model), `pnpm ai:analyze --org <slug> [--embeddings] [--recompute]` (batch analysis; cached, paced), `pnpm ai:eval` (scores the labelled TR/EN set against the configured provider and exits non-zero below threshold).

## Docs

`docs/` holds the full plan (01 master → 14). Read 02, 03, 06 before building; 09/10/11 are the build plans; 12 is the AI-guardrail evidence, 13 the go-live runbook, 14 the digest-surfaces plan. `home-live-dashboard.md` is the active Home redesign handoff.
