# CLAUDE.md — Revira

**Revira** *(provisional name)* is a review & customer-voice management SaaS: businesses connect their review and social sources and receive new-review notifications, AI analysis, and a weekly **Action Digest** (the hero feature). Launch market is Türkiye; the product is built global-ready (EN + TR). The full plan lives in `docs/` — read `docs/02-prd.md`, `docs/03-technical-architecture.md`, and `docs/06-ux-roles-and-flows.md` before building.

## Current state

**Everything planned is built.** Phases 0–4, the founder-audit remediation (Waves 1–5), and the post-test fix waves A–C. What remains is not code.

`docs/23-build-log.md` is the decision record — what was built, in what order, and **why each rule is the way it is**. It is long because most entries are an argument rather than a note. Read the relevant entry before reversing a decision; there is a fair chance the alternative was tried and the entry says what went wrong.

| | |
|---|---|
| Phase 0 — Foundations | `docs/09` |
| Phase 1a — AI layer & Action Digest | `docs/10`, guardrail evidence `docs/12` |
| Phase 1b — Real connectors | `docs/11` |
| Phase 2 — Unified inbox & team workflow | `docs/17`, a11y evidence `docs/18` |
| Phase 3 — Showcase & analyze | `docs/19` |
| Phase 4 — Engage (CRM, surveys, messaging, broadcasts, agency) | `docs/20` |
| Waves 1–5 — founder audit remediation | `docs/remediation-plan.md` |
| Waves A–C — post-test fixes | `docs/22` |

Migrations run to `0057`. Digest surfaces: `docs/14`.

### What is true about the build, and easy to overstate

- **Everything runs on the mock connector.** Google, WhatsApp and Instagram are **fixture- and mock-tested only** — no live platform traffic has ever run through them. Do not describe them as working. `pnpm mock:platform` serves a fake Google and a fake Meta over real HTTP with provider-correct error envelopes, pagination and rate limits; that proves the connectors talk to something that disagrees with them, and proves nothing about real quotas, undocumented payload quirks or OAuth consent.
- **No commercial message has ever left the machine.** `IYS_GATEWAY` and `SMS_GATEWAY` default to `none`, which refuses; `local`/`mock` accept without contacting anyone. `isRegisteredVia` and `isRealSmsGateway` have **empty allowlists**, which is the true answer until a real BSP adapter exists. Every accepted consent records `iys_uploaded_via`, so a `local` upload stays distinguishable from a registered one forever.
- **Gated on the company, not on code** (`docs/13`): a real İYS BSP, a messaging provider, live platform credentials, a competitor data source, and W5-4 / W5-10 / W5-11. `pnpm golive` reports readiness and makes no writes; "not configured" is its expected answer today.
- **The re-test gate is open.** Every wave has been driven by hand in Chrome — that is where most defects here were found — but nobody has sat down cold, with no knowledge of the build, and been watched. **Done means verified in-product, not committed**; two Wave A items were regressions of work already called done.

### Rules that came out of the build

These are load-bearing and are stated here because they constrain the *next* change. The reasoning is in `docs/23`.

- **A worker module must never import anything that reaches a request API.** The mirror of the `"use client"` rule below. `next/headers` reached the report pipeline through `lib/active-location.ts`; Vitest resolved it perfectly well, and only `pnpm worker` failed — at startup, in the process nobody is watching.
- **Anything with a delay between the decision and the act needs the entitlement asked twice.** A scheduled report or a queued broadcast can outlive the plan that authorised it.
- **Absence is `null`, never `0`.** A quiet week did not score nought stars; a branch nobody replied to is not the fastest. Null sorts last, never as zero.
- **A figure a reader cannot click through to is a figure they must take on trust.** If a count and the list behind it can disagree, they eventually will — derive both from one array.
- **Invented rows outlive the flag that produced them.** Prefer fetching at read time to storing a plausible number; `competitor_snapshots` is deliberately absent for this reason.
- **A completeness test is not a behaviour test, and both are needed.** Existing suites prove a door is locked; none notices a *new* door. Public routes, send paths, tenant tables, `useAction` call sites and senders are each enumerated from disk and fail when the list grows.
- **Two compliance rules are code, not policy.** (1) Every outbound commercial message goes through `checkSendAllowed`; a refusal is a named reason, never a silent drop. (2) **No review-gating** — a public-review invitation may never be computed from a rating, a sentiment or a predicted score, and no audience query may target one.

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

**Every screen follows `docs/15-design-system.md`. Read it before building any UI.** One theme only — there is no dark mode and no `dark:` variant; never add one. Tokens live in `src/app/globals.css`; shared components in `src/components/ds`; `src/app/(app)/dashboard` is the reference implementation. Never type a hex code, font size or corner radius — the value is already a token. **Two files are exempt and both say why in their own comment:** `src/widgets/theme.ts`, because a widget renders on a stranger's site where `globals.css` does not exist, and `src/components/connections/provider-mark.tsx`, because a brand colour is a fact about another company rather than a value in our palette. Reach for `SectionCard`, `Eyebrow`, `Metric`, `IconTile`, `Meter`, `Stars` before writing a div. The shell (dark rail, top bar, page container) is app-wide, so a new page inherits the layout by existing.

## Architecture principles

- **Modular monolith.** One app, strong module boundaries. No microservices.
- **The `Connector` interface is the core abstraction** for every review/social source. Everything runs on the **MockConnector** by default; real connectors (Phase 1b) implement the same interface and swap in per flag/credentials with zero changes elsewhere.
- **Canonical `reviews` model.** Every source normalizes into it; always keep `raw_payload` (jsonb).
- **Multi-tenancy is non-negotiable.** Every tenant-owned row has `organization_id`, enforced with Postgres **Row-Level Security** + a per-request tenant context. **Never write a query that isn't tenant-scoped.**
- **Entitlements are a first-class primitive.** Feature access + limits come from plan config, checked **server-side** via `can(org, feature)` / `withinLimit(org, metric)`. Never hardcode `if plan === '...'`.
- **AI guardrails.** Review text is untrusted input (prompt-injection defense); never put another org's data in a prompt; AI replies never fabricate facts and are length-bounded; every AI action is audit-logged and metered.
- **The public surface is the hardest boundary in the product (Phase 3).** Widgets, badges and SEO pages are served **unauthenticated, to the open internet, with no session to scope by**. Three rules, all enforced in code and tested: (1) the tenant is resolved *from the key in the URL* — a caller-supplied `organization_id` is never accepted, anywhere; (2) after that resolution every read still goes through `withTenant()`, so RLS has the final say; (3) only reviews the organization has **explicitly approved for display** are ever returned, over an **allow-listed projection** — never `select *`, never `raw_payload`, never a triage field. A DM can never be published at all, and the database refuses it. No cross-org data, ever.
- **Compliance is code.** No rating-gating anywhere. Commercial messages (Phase 1b) require consent + (Türkiye) İYS check before send. Reviews are personal data (KVKK/GDPR) → support export/delete.

## Repo conventions

- Core dirs: `src/db`, `src/auth`, `src/lib` (tenancy, entitlements, logger), `src/connectors`, `src/channels` (messaging channels — *not* review sources), `src/jobs`, `src/search`, `src/server`, `src/app`, `src/i18n`, `src/prompts`, `src/components/ds` (design system), `tests/`.
- **Names: the URL and the folder follow the screen; the schema follows the domain (W3.1).** A screen's route, its nav label and its source directory say the same word, so nobody translates between "Inbox" in code and "Reviews" on screen. Tables and the types that mirror them do **not** follow — renaming a table is a destructive migration for no reader's benefit. Where the two disagree, the disagreement is deliberate and written down:
  - `src/reviews` (was `inbox`) serves `/reviews`; `src/analytics` (was `insights`) serves `/analytics` — and that rename also separates the *workspace* from the unrelated `review_insights` table.
  - `src/digest` keeps its name against a `/weekly-plan` route, because `digests`, `digest_actions`, `digest_deliveries` and `digest_sweep` all say digest. A module renamed out from under its own schema is a worse mismatch than the one it fixes.
  - `src/broadcasts` serves `/broadcasts`, and **the collision W3.1 introduced is resolved (8 Aug 2026)**. W3.1 renamed `/broadcasts` to `/campaigns` because campaign is the word a marketer scans for; what it did not weigh is that the word was taken. **`campaigns` is already a table** — the review-collection strategies behind `/get-reviews`, with `src/collect/campaigns.ts`, `/api/campaigns/{id}/qr` and the "New campaign" button on screen — so the product had two different objects one rail-click apart under one noun, and the broadcast form had to label its own field "Collection campaign" to say which sort it meant. **The screen that borrowed the word is the one that moved**: the table, the folder, the job (`broadcast_sweep`) and the Turkish copy ("Gönderimler", never "kampanya") all said broadcast already, so renaming it makes route, folder, table and label agree — the rule this section states. English copy changed; **Turkish needed almost none**. The `/campaigns` → `/broadcasts` redirect **replaces** the old pair rather than joining it, or the two would bounce off each other forever. `tests/lib/naming-collisions.test.ts` pins it: "campaign" may only appear in the namespaces that own the table.
- TypeScript **strict**, no `any`. Validate all external input with **Zod**.
- **A `"use client"` file must never import a runtime value from a module that reaches the database.** `db/client` pulls in `pg`, which needs Node's `dns`, and the build fails on the missing built-in. Types are erased and safe; constants are not — put shared constants in a db-free module (`search/types.ts`, `notifications/types.ts`).
- Migrations explicit and reviewed; never destructive without a backfill.
- Every mutation of a tenant resource goes through the **tenant-scoped data layer**.
- Real connectors default to **mock in dev**; live only where credentials are present. Never commit secrets.
- Tests required for: **tenant isolation (RLS)**, connector sync (fixtures), entitlement checks, **AI guardrails**, digest reproducibility, and per-connector contract tests.

## Key contracts

The `Connector` interface + entitlement keys: `docs/09-phase-0-build-plan.md`. The `review_insights` shape, Digest object, and AI guardrails: `docs/10-phase-1a-build-plan.md`. Per-platform connector go-live prerequisites and verification: `docs/13-go-live.md`. Implement exactly.

**Phase 2 contracts** live in code, each in exactly one module — go there before writing a second definition:

- **Reviews URL state** — `src/reviews/filters.ts`. The only place a filter becomes a query string and back. Db-free, so client components and `saved_views` share it. A new filter is one edit here, not three. It also owns `pinnedReviewsHref` (W2.1) — the `?reviews=` link a digest action uses to open *exactly* the reviews it cited, built here rather than twice because the copy in the weekly email goes out once and cannot be corrected.
- **Derived triage values** — `src/reviews/workflow.ts`. `computePriority` (rating + sentiment + reply state; recency is applied in the ORDER BY, never stored) and `slaState`/`resolveSlaHours`. `refreshPriority` is called wherever an input changes.
- **Ordering, cursors and page location** — `src/reviews/queries.ts`. The sort is data (`sortKeys`), and the ORDER BY, the keyset cursor and `locateReview` are all derived from it so they cannot disagree.
- **Location scope** — `src/auth/scope.ts`. The only interpreter of `member_locations`, and the only writer (`setMemberLocations`, surfaced on `/team`). RLS enforces the *tenant*; this enforces the *location*. Screens call `listLocationsForActor`, never the unscoped reader.
- **Bulk guardrail** — `src/reviews/bulk.ts`. Bulk writes `draft` replies and nothing else: no connector import, no approval, no post. `tests/lib/bulk-guardrail.test.ts` fails if that changes.
**Phase 3 contracts** — same rule, one definition each:

- **What "in this widget's scope" means** — `src/widgets/scope.ts`. The public read, the aggregate beside it and the builder's approval list all build their WHERE clauses here. A builder that offered a review the widget would refuse is a support ticket reading "I approved it and it never appeared".
- **The widget config, and its URL form** — `src/widgets/config.ts`. Filters and style as Zod, db-free, plus `widgetConfigToParams`/`FromParams` — the only place a config becomes a query string, which is how the builder's live preview reaches the real renderer.
- **The widget's own stylesheet** — `src/widgets/theme.ts`. The one place literal hex is correct, because a widget renders on a stranger's site where `globals.css` does not exist. `tests/lib/widget-theme.test.ts` re-derives every contrast ratio it claims.
- **The embed document's CSP** — `src/widgets/csp.ts`. Derived **from the finished document**, never from the constants it was built out of: a hash pinned to a constant is a hash asserting against itself, and the widget silently stops resizing when they drift.
- **A hosted page's address** — `src/seo/slug.ts` (what a name becomes) and `src/seo/urls.ts` (where it lives). Db-free, so the locations screen and the badge can both build the URL. The slug is written once, on first publish, and every other module treats it as read-only — an indexed URL that moves is a page that loses what it earned.
- **Display approval** — `src/widgets/approval.ts`. Approval is a property of the *review*, not of a widget, so approving one approves it everywhere; the UI says so. Bulk approve records the filter it ran under, not just a count. A DM can never be approved — the database refuses it.
**Phase 4 contracts** — same rule, one definition each:

- **Contact URL state** — `src/contacts/filters.ts`. The only place a contact filter becomes a query string and back. Db-free, so client components and `contact_segments` share it — and a **segment is that query string with a name on it**, which means a round-trip that loses a value does not merely mis-render a list, it changes who a campaign gets sent to.
- **Who may see which contacts** — `src/contacts/scope.ts`. `contacts` has no `location_id`, so RLS enforces the *tenant* and this enforces the *location*. Empty scope means nothing, never everything. Every reader goes through it: the list, the segment counts, the profile, the timeline, and (P4-T4) a campaign's audience.
- **What a contact label is** — `src/contacts/tags.ts`. Slug normalisation (Turkish-aware, shared with `src/seo/slug.ts`) plus the label-adoption rule that keeps one word one tag without a vocabulary table.
- **Permission to send** — still `src/compliance/gate.ts`, and nothing in Phase 4 may add a second answer. A filter, a segment or a screen may narrow a list to plausible recipients; only `checkSendAllowed` decides whether a message leaves. **Surveys (P4-T2) are the first send path fully behind it.** Review requests on **WhatsApp and SMS** go through it too (W2.2) — a phone recipient is a `contactId`, never a raw number, because the gate is keyed on a person. Review-request **email** (P1b-T1) honours the opt-out but does *not* go through the gate: a pre-existing gap, flagged rather than changed, because closing it would stop review requests sending in every environment without a registry. `tests/db/request-channels.test.ts` pins that difference deliberately, so nobody tidies it away and takes the feature down.
- **What a survey answer means** — `src/surveys/scoring.ts`. The scale, the bands, and the arithmetic, pure and db-free so the public form, the results page and the Insights card cannot disagree. Absence is `null`; an NPS of 0 is a real score.
- **What a respondent sees afterwards** — `src/surveys/outcome.ts`. The public-review invitation is computed from the survey alone and is identical for every score; the private follow-up is the only thing the score decides, and it only ever adds. This is the module `docs/20`'s no-review-gating rule is about.
- **Every kind of token we mint** — `contactBehindToken` in `src/collect/public.ts`. One opt-out URL shape, one route, and one place that has to learn about a new token type — otherwise a compliance footer links somewhere that does nothing.
- **What basis a message rests on** — `intentFor` in `src/messaging/outbound.ts`. Derived from the channel and the content, never passed in. There is no `intent` parameter anywhere between a screen and the gate, which is what stops a surface declaring its own message exempt from consent.
- **The message log** — `src/messaging/messages.ts`, the only writer of `messages`. Records what happened, including when the answer was no; `whatsapp_conversations` stays separate because it holds a *legal* fact (when the customer last wrote) that the gate reads on every send.
- **Who a broadcast reaches** — `src/broadcasts/audience.ts`, built on `contactsWhere`. The same predicate that produced the number the business was shown when they saved the segment, so the count on the button and the list that goes out cannot differ. Scope is the creator's, resolved at send time.
- **Running a send** — `src/broadcasts/pipeline.ts`. One code path for "send now" and for the sweep, so the scheduled path is exercised every time somebody presses the button. The claim is the lock; the gate runs here for *every* kind.
- **The İYS gateway lives on `globalThis`** (`src/compliance/gate.ts`). Next bundles `instrumentation.ts` apart from the app, so a module-level singleton was two singletons — the boot log said one thing and the next send said another. There is one registry per deployment; a per-bundle variable was always the wrong container.

- **Text contrast** — a table, not a token: the lightest legal ink depends on the surface (`--ink-400` on white, `--ink-350` on `--canvas`/`--surface-sunken`, `--ink-500` on `--surface-segmented`). `tests/lib/design-contrast.test.ts` enforces it; `docs/15` §Type states it.

**Remediation contracts (Waves 1–3)** — same rule, one definition each:

- **What "answered" means** — `src/reviews/answered.ts` (W1.2). There were four opinions: a `replies` row, `first_response_at`, and a `raw_payload` sniff for `ownerReply` that only ever matched the mock (Google writes `reviewReply`). A review the owner had answered on Google showed "answered on Google" *and* counted unanswered *and* accrued an overdue badge. Connectors normalise into `reviews.owner_replied_at` at ingest; every reader asks one column.
- **Which organization a session opens in** — `src/auth/active-organization.ts` (W1.1). Reads `users.last_active_organization_id`, **re-checks membership**, falls back to a sole membership, else null. Nothing else may decide it.
- **Whether a review is news** — `IS_NEWS` in `src/notifications/service.ts` (W1.3). A backfill is history, not 217 things that happened on Tuesday.
- **Reporting an action's outcome** — `useAction` in `src/components/ui/use-action.ts` (W1.5). Every mutation reports through it; `tests/lib/action-feedback.test.ts` enumerates the call sites and makes each exemption name itself. A read that queries as you type may be exempt; a mutation may not, and neither may a failure caught into a component's own state.
- **What a channel is, and whether it may carry a message** — `src/channels/registry.ts` (db-free) and `src/channels/status.ts` (W2.2). A **source** is polled and answers "can it read reviews"; a **channel** is pushed down and answers "may this carry a message right now". A provider can be both; none is today. Credentials live in `channel_connections` through `src/channels/store.ts` alone, sealed to `channelContext` so a channel token cannot be opened in a source's slot.
- **Whether a source is well** — `src/connections/health.ts` (W4.2). Pure, db-free, six states each naming a *different act*. The only reader of `connections.last_error_kind`, and the only place that decides what "reconnect" means. A screen may render a badge; nothing else may compute one.
- **What we have not built** — `src/connectors/roadmap.ts` (W4.2). The sources on the Connections screen with no connector behind them. It has **no descriptor** and must never gain one: `PROVIDERS` is read by the registry, the connect flow, the sync scheduler and `pnpm golive`, all of which assume a descriptor means a connector exists.
- **When a branch is open, and what that does to a deadline** — `src/locations/opening-hours.ts` (W5-8). Pure, db-free, Europe/Istanbul. `slaDueAt` is its only consumer, and **no hours means no change** — the round-the-clock clock is what a location that has never configured one keeps. National holidays are deliberately *not* applied here, though `src/compliance/business-days.ts` knows them: an İYS deadline is a legal one, and a café is open on 29 October.
- **When a phone may be woken** — `src/notifications/quiet-hours.ts` (W5-15). The window wraps midnight, holds the email and never the in-app row, and has **no exception for urgent**. `notifications.send_after` is written at creation and read identically by the email sender and by push, which is what stops a second channel undoing it.
- **What a lock screen may say** — `pushMessageFor` in `src/notifications/push.ts` (W5-9). The stored excerpt, never a full review: a lock screen is readable by whoever is standing next to the phone.
- **Whether two reviews are one review** — `src/reviews/duplicates.ts` (W5-7). Three signals, all required. It links and **changes no aggregate**, deliberately — the number a business is judged by is the one on their listing.
- **What an auto-reply may say** — `src/replies/auto.ts` (W5-6). A template the business wrote, to a wordless five-star review, and nothing else. The model is not in this path; read this module before widening anything about it.
- **How a reply should sound and sign off** — `src/replies/style.ts` (W4 fold-in, W5-12). No imports at all, so the composer and the prompt builder share one list. Tone is a stance toward one review and does *not* replace `locations.brand_tone`; `appendSignature` is idempotent because regeneration lands on text that already carries one.
- **What a digest says when it leaves the app** — `src/digest/shareable.ts` (W2.1). The seam between what a week said (the payload) and how it is written (`next-intl` + `Intl`). The PDF and the WhatsApp text both render from it, so the file an owner prints and the message they paste cannot disagree.

## Run

`docker compose up -d` (Postgres + Redis + **Mailpit**, the maintained MailHog successor — dev inbox at `localhost:8025`) → `pnpm db:migrate` → `pnpm db:seed` → `pnpm dev`.

`pnpm verify` is the gate (lint, types, format, **i18n parity**, **dead code**, unit + DB tests, build). `pnpm check:i18n` fails on a key missing from any locale or defined-but-unused; `pnpm knip` fails on unused files or dependencies (`pnpm knip:all` also reports unused exports, which are not gated). See `docs/16-code-hygiene.md`. `pnpm golive` reports per-platform go-live readiness; it is read-only and "not configured" is its expected answer today. `pnpm test:e2e` runs the browser suite against a running dev server (`pnpm test:e2e:clean` tidies up after it). `pnpm mock:platform` starts a fake Google and a fake Meta that answer over HTTP and keep producing new content — point the connectors' base URLs at it to exercise T2/T3/T4 end to end without credentials.

`pnpm email:preview` sends one of **every** outbound email — request, new-review (ordinary/urgent/assigned), both rollups, the digest, and the scheduled report **with its PDF attached** — to Mailpit in both languages, rendered by the real template functions (`--locale tr` narrows it). It exists because an email is the one surface with no way to look at it: a template only renders when the event behind it happens, which is how a rollup shipped with blank fields and a link to `/reviews?review=undefined`. It refuses to run against a non-local SMTP host. **Adding a template means adding it to `scripts/email-preview.mts`** — the file is the inventory of what the product can put in someone's inbox.

AI operator commands: `pnpm ai:smoke` (one call, checks the key and model), `pnpm ai:analyze --org <slug> [--embeddings] [--recompute]` (batch analysis; cached, paced), `pnpm ai:eval` (scores the labelled TR/EN set against the configured provider and exits non-zero below threshold).

Other operator commands: `pnpm reviews:rescore` recomputes derived triage after a change to `computePriority` or the SLA rules (W1.2 — it was `inbox:rescore`); `pnpm mock:billing` drives a Stripe-shaped webhook without Stripe; `pnpm mock:inbound` signs a real Meta envelope and POSTs it at `/api/webhooks/whatsapp`, so the signature check, the dedup index and the opt-out branch are all exercised rather than bypassed.

**`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` are optional** (W5-9): generate with `npx web-push generate-vapid-keys`. Absent is the ordinary state — the Settings card simply says push is not configured here and email carries on. The subject defaults to this deployment's origin and is rewritten to a `mailto:` when that is `http:`, which `web-push` rejects.

**`TOKEN_VAULT_KEYS` must be set, even in development.** Without it nothing that stores a credential can work — no OAuth connector, and no channel connection — and the failure is a `VaultError` that names the variable and prints the command to generate a key. `.env.example` documents it; a local `.env` that predates the connectors will not have one.

## Docs

`docs/` holds the full plan (01 master → 23; `docs/README.md` is the index). Read 02, 03, 06 before building; 09 (Phase 0), 10 (1a), 11 (1b), 17 (Phase 2), 19 (Phase 3) and 20 (Phase 4) are the build plans; 12 is the AI-guardrail evidence, 13 the go-live runbook, 14 the digest-surfaces plan, **15 the design system — read it before any UI work**, 16 code hygiene, 18 the accessibility and mobile evidence, 21 the visual language, 22 the post-test fix plan. Numbering is chronological, so a build plan's number is not its phase number.

**`docs/23-build-log.md` is the decision record** — every phase and wave, with the argument behind each rule. It was the top of this file until 9 Aug 2026, when `CLAUDE.md` passed the 150k-character limit the agent tooling enforces; 135k of its 160k was that one section. Moved rather than trimmed, because the arguments are what stop a rule being quietly re-litigated by somebody who only sees the code it produced. **This file keeps the rules; 23 keeps the reasons.**

**`remediation-plan.md` is the founder audit's prioritised fix list** (Waves 1–5) — unnumbered because it cuts across phases rather than following one. `home-live-dashboard.md` is the superseded Home handoff, kept for its metric definitions.
