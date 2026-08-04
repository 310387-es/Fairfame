# CLAUDE.md — Revira

**Revira** *(provisional name)* is a review & customer-voice management SaaS: businesses connect their review and social sources and receive new-review notifications, AI analysis, and a weekly **Action Digest** (the hero feature). Launch market is Türkiye; the product is built global-ready (EN + TR). The full plan lives in `docs/` — read `docs/02-prd.md`, `docs/03-technical-architecture.md`, and `docs/06-ux-roles-and-flows.md` before building.

## Current phase & roadmap

- **Phase 0 (Foundations): complete.** `docs/09-phase-0-build-plan.md`.
- **Phase 1a — AI Layer & Action Digest: complete (2 Aug 2026).** `docs/10-phase-1a-build-plan.md`. **T1**–**T11**, all live-verified against a real model: provider abstraction + guardrails, pgvector + insights, sentiment/theme extraction, analysis wired into ingestion, notifications, AI reply drafting, the Action Digest pipeline, the Home/Digest screen, Inbox enhancements, the public sample digest, and guardrail validation. Guardrail evidence: `docs/12-ai-guardrail-validation.md`.
- **Digest surfaces — D1/D2/D3 complete (3 Aug 2026).** `docs/14-digest-surfaces.md`. The weekly digest is emailed (`digest/delivery.ts`, idempotent via the `digest_deliveries` ledger, drains the `deferred` notification backlog) and archived at `/digest` + `/digest/[id]`. Digest copy now lives in `digest.*`, not `home.*`. **D4 (WhatsApp delivery) remains gated on go-live.**
- **Phase 1b — Real Connectors: code-complete (3 Aug 2026).** `docs/11-phase-1b-build-plan.md`. **T0** connector infrastructure (OAuth + encrypted token vault + provider flags + rate limiting/backoff), **T1** first-party collection (live-tested), **T2** Google, **T3** WhatsApp Business, **T4** Instagram, **T5** İYS/KVKK compliance layer (done, less the real registry adapter), **T6** contract tests + go-live suite.
- **Phase 1 is built. What remains is live verification, and it is gated on the company, not on code.** T3 and T4 are **fixture-tested only** — no live platform traffic has ever run through them. Do not describe them as working. **All three now also run against a fake platform over HTTP** (`src/connectors/mock-platform`, `pnpm mock:platform`): a fake Google and a fake Meta serving Instagram and WhatsApp from one Graph root, as the real API does. Real sockets, real pagination and `since` filtering, provider-correct error envelopes and codes, 401/403/429, reply and message posting, and new content arriving on a drip. That is not the same as live traffic — it cannot prove anything about real quotas, undocumented payload quirks or OAuth consent, and a mock built from my reading of the docs is wrong in the same direction as my reading — but it does mean every connector has now talked to something that disagrees with it. `docs/13-go-live.md` holds the per-platform prerequisites and verification steps; `pnpm golive` reports readiness and makes no writes. **The İYS consent loop is now closed (4 Aug 2026)**: the opt-in tick exists on the collection form, and the `iys_sweep` worker (`src/compliance/iys-upload.ts`, `src/jobs/workers/iys-upload.ts`, every 15 min) drains `pendingIysUploads` through the configured `IysGateway` — so a captured permission now reaches the registry, and `pnpm golive` blocks on any consent past its three-business-day deadline. **The gateway itself is still the seam, not an implementation**: `IYS_GATEWAY=none` refuses (correct before go-live) and `local` accepts without contacting anyone, which is why every accepted row records `iys_uploaded_via` — a `local` upload must stay distinguishable from a registered one forever. Nothing commercial can actually be sent until a real BSP adapter exists. **Instagram DMs are now ingested (4 Aug 2026)** — `item_type = 'dm'` from the `conversations` edge, with the business's own replies filtered out (`from.id` is the only signal) and no `url`, because a DM is private and there is nothing public to link to. The edge degrades alone: without `instagram_manage_messages` it is logged and skipped while comments and mentions still sync, though a rate limit still propagates so backoff survives. **Answering a DM is deliberately not built** — that is a send, needing the gate extended to Instagram plus Meta's 24-hour window; the Inbox refuses with that reason rather than a generic failure. `MOVABLE_HOLIDAYS` now covers **through 2030**, and `pnpm golive` warns under 12 months of runway and blocks once it lapses.
- **Phase 2 — Unified Inbox & Team Workflow: complete (4 Aug 2026).** `docs/17-phase-2-build-plan.md`. **T1**–**T9**: triage columns + derived priority/SLA, the unified filter/search/keyset query, quick filters + saved views, status/assignment/SLA with per-member location scope, reply templates, bulk actions, near-real-time + SLA alerts with backlog rollup, entitlements + scope enforcement, and the test pass. Migrations `0024`–`0028`, all additive. Still on the **mock connector** — nothing here needed a real platform API. Accessibility and mobile evidence: `docs/18-accessibility-verification.md`.
- **Browser tests exist as of 4 Aug 2026** — Playwright, `pnpm test:e2e`, deliberately **outside `pnpm verify`** because they need a live server and database. They cover the two things unit tests structurally cannot: mobile layout at a real 390px viewport, and keyboard/focus order. The suite signs up its own account through the product's own endpoints and ingests via the mock connector, so it never depends on seed data; `pnpm test:e2e:clean` removes the accounts it leaves behind. Evidence and the manual recipes: `docs/18-accessibility-verification.md`. VoiceOver, NVDA and JAWS were all checked by hand and work.

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

## Design system (in force)

**Every screen follows `docs/15-design-system.md`. Read it before building any UI.** One theme only — there is no dark mode and no `dark:` variant; never add one. Tokens live in `src/app/globals.css`; shared components in `src/components/ds`; `src/app/(app)/home` is the reference implementation. Never type a hex code, font size or corner radius — the value is already a token. Reach for `SectionCard`, `Eyebrow`, `Metric`, `IconTile`, `Meter`, `Stars` before writing a div. The shell (dark rail, top bar, page container) is app-wide, so a new page inherits the layout by existing.

## Architecture principles

- **Modular monolith.** One app, strong module boundaries. No microservices.
- **The `Connector` interface is the core abstraction** for every review/social source. Everything runs on the **MockConnector** by default; real connectors (Phase 1b) implement the same interface and swap in per flag/credentials with zero changes elsewhere.
- **Canonical `reviews` model.** Every source normalizes into it; always keep `raw_payload` (jsonb).
- **Multi-tenancy is non-negotiable.** Every tenant-owned row has `organization_id`, enforced with Postgres **Row-Level Security** + a per-request tenant context. **Never write a query that isn't tenant-scoped.**
- **Entitlements are a first-class primitive.** Feature access + limits come from plan config, checked **server-side** via `can(org, feature)` / `withinLimit(org, metric)`. Never hardcode `if plan === '...'`.
- **AI guardrails.** Review text is untrusted input (prompt-injection defense); never put another org's data in a prompt; AI replies never fabricate facts and are length-bounded; every AI action is audit-logged and metered.
- **Compliance is code.** No rating-gating anywhere. Commercial messages (Phase 1b) require consent + (Türkiye) İYS check before send. Reviews are personal data (KVKK/GDPR) → support export/delete.

## Repo conventions

- Core dirs: `src/db`, `src/auth`, `src/lib` (tenancy, entitlements, logger), `src/connectors`, `src/jobs`, `src/search`, `src/server`, `src/app`, `src/i18n`, `src/prompts`, `src/components/ds` (design system), `tests/`.
- TypeScript **strict**, no `any`. Validate all external input with **Zod**.
- **A `"use client"` file must never import a runtime value from a module that reaches the database.** `db/client` pulls in `pg`, which needs Node's `dns`, and the build fails on the missing built-in. Types are erased and safe; constants are not — put shared constants in a db-free module (`search/types.ts`, `notifications/types.ts`).
- Migrations explicit and reviewed; never destructive without a backfill.
- Every mutation of a tenant resource goes through the **tenant-scoped data layer**.
- Real connectors default to **mock in dev**; live only where credentials are present. Never commit secrets.
- Tests required for: **tenant isolation (RLS)**, connector sync (fixtures), entitlement checks, **AI guardrails**, digest reproducibility, and per-connector contract tests.

## Key contracts

The `Connector` interface + entitlement keys: `docs/09-phase-0-build-plan.md`. The `review_insights` shape, Digest object, and AI guardrails: `docs/10-phase-1a-build-plan.md`. Per-platform connector go-live prerequisites and verification: `docs/13-go-live.md`. Implement exactly.

**Phase 2 contracts** live in code, each in exactly one module — go there before writing a second definition:

- **Inbox URL state** — `src/inbox/filters.ts`. The only place a filter becomes a query string and back. Db-free, so client components and `saved_views` share it. A new filter is one edit here, not three.
- **Derived triage values** — `src/inbox/workflow.ts`. `computePriority` (rating + sentiment + reply state; recency is applied in the ORDER BY, never stored) and `slaState`/`resolveSlaHours`. `refreshPriority` is called wherever an input changes.
- **Ordering, cursors and page location** — `src/inbox/queries.ts`. The sort is data (`sortKeys`), and the ORDER BY, the keyset cursor and `locateReview` are all derived from it so they cannot disagree.
- **Location scope** — `src/auth/scope.ts`. The only interpreter of `member_locations`, and the only writer (`setMemberLocations`, surfaced on `/team`). RLS enforces the *tenant*; this enforces the *location*. Screens call `listLocationsForActor`, never the unscoped reader.
- **Bulk guardrail** — `src/inbox/bulk.ts`. Bulk writes `draft` replies and nothing else: no connector import, no approval, no post. `tests/lib/bulk-guardrail.test.ts` fails if that changes.
- **Text contrast** — a table, not a token: the lightest legal ink depends on the surface (`--ink-400` on white, `--ink-350` on `--canvas`/`--surface-sunken`, `--ink-500` on `--surface-segmented`). `tests/lib/design-contrast.test.ts` enforces it; `docs/15` §Type states it.

## Run

`docker compose up -d` (Postgres + Redis + **Mailpit**, the maintained MailHog successor — dev inbox at `localhost:8025`) → `pnpm db:migrate` → `pnpm db:seed` → `pnpm dev`.

`pnpm verify` is the gate (lint, types, format, **i18n parity**, **dead code**, unit + DB tests, build). `pnpm check:i18n` fails on a key missing from any locale or defined-but-unused; `pnpm knip` fails on unused files or dependencies (`pnpm knip:all` also reports unused exports, which are not gated). See `docs/16-code-hygiene.md`. `pnpm golive` reports per-platform go-live readiness; it is read-only and "not configured" is its expected answer today. `pnpm test:e2e` runs the browser suite against a running dev server (`pnpm test:e2e:clean` tidies up after it). `pnpm mock:platform` starts a fake Google and a fake Meta that answer over HTTP and keep producing new content — point the connectors' base URLs at it to exercise T2/T3/T4 end to end without credentials.

AI operator commands: `pnpm ai:smoke` (one call, checks the key and model), `pnpm ai:analyze --org <slug> [--embeddings] [--recompute]` (batch analysis; cached, paced), `pnpm ai:eval` (scores the labelled TR/EN set against the configured provider and exits non-zero below threshold).

## Docs

`docs/` holds the full plan (01 master → 18). Read 02, 03, 06 before building; 09 (Phase 0), 10 (1a), 11 (1b) and 17 (Phase 2) are the build plans; 12 is the AI-guardrail evidence, 13 the go-live runbook, 14 the digest-surfaces plan, **15 the design system — read it before any UI work**, 16 code hygiene, 18 the accessibility and mobile evidence. `home-live-dashboard.md` is the superseded Home handoff, kept for its metric definitions.
