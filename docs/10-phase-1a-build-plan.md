# Phase 1a — AI Layer & Action Digest · Build Plan

*Revira (provisional) · the hero sprint · builds entirely on the MockConnector — no real platform APIs required · companion to CLAUDE.md, `docs/02-prd.md` §6, and `docs/03-technical-architecture.md` §6*

> **Goal:** turn ingested (mock) reviews into **AI insights, notifications, AI-drafted replies, and the weekly Action Digest** — the product's hero and its real differentiator. This is fully buildable now; it needs only an LLM API key, not the gated Google/Meta APIs.
>
> **Phase 1b (real connectors — Google / first-party / WhatsApp / Instagram, İYS/consent, live sends) is deferred until the company is formed and the product is otherwise finished. Do NOT start 1b work in this phase.**

## Definition of Done

A user with a connected **Mock** source: (1) sees every review auto-analyzed for **sentiment + themes** (Turkish and English), (2) is **notified** of new/negative reviews, (3) can **generate → edit → post (mock)** an on-brand AI reply, and (4) receives a weekly **Action Digest** on the Home screen — reputation pulse, what changed, themes with quotes, and **3 concrete actions** with ready-to-use assets — with the loop **closing week over week**.

## Prerequisites (added this phase)

- An **LLM API key** (Anthropic or OpenAI) in env — this is a normal dev account, not a gated business API.
- **pgvector** enabled in Postgres (for embeddings).
- A dev email transport (e.g. Mailhog in docker-compose, or a console transport) — no production ESP needed yet.

---

## Ordered Tasks

### P1a-T1 — AI provider abstraction + guardrails
Provider-agnostic LLM client behind an interface (swap Anthropic/OpenAI), env-configured; retries, timeouts, and **cost/usage logging**. A central `prompts/` module. Baseline **guardrails**: treat all review text as untrusted (prompt-injection defense), strict **tenant scoping** (never put another org's data in a prompt), every AI action audit-logged.
**Done when:** a single `analyze(text)` / `draft(...)` call works through the abstraction, is logged, and a prompt-injection attempt in a review body cannot change system behavior.

### P1a-T2 — pgvector + insights schema
Enable `pgvector`. Add **`review_insights`** (review_id, organization_id, sentiment, sentiment_score, topics text[], embedding vector) and a `tags` table. Migration + RLS on new tenant tables.
**Done when:** migrations apply; insights rows are tenant-scoped; embeddings column stores/searches vectors.

### P1a-T3 — Sentiment + theme extraction
For each review, produce sentiment (pos/neu/neg + score) and 1–N topic tags, in the review's language, with **comparable TR and EN quality**. Batch + cache; provide a **recompute** path. Ship a small **labeled TR/EN eval set** + a script that reports accuracy so we can measure and defend quality.
**Done when:** analysis populates `review_insights` for all reviews; the eval script runs and reports metrics above an agreed threshold.

### P1a-T4 — Wire analysis into ingestion
When the Mock sync upserts a review, enqueue a BullMQ **analysis job** → insights populate automatically; backfill existing reviews.
**Done when:** connecting/syncing a Mock source yields analyzed reviews with zero manual steps.

### P1a-T5 — Notifications
Notification model + service: **in-app feed + email** (dev transport). Trigger on new review; **negative (≤3★ or negative sentiment) flagged urgent**. Per-user, per-location **preferences** (all / negative only / off; instant vs digest).
**Done when:** a new mock review produces the right notifications per the user's prefs; negatives are prioritized.

### P1a-T6 — AI reply drafting
Action that drafts a reply in the review's language + a configurable **brand tone**; guardrails (bounded length, **no fabricated facts/offers**). Review-detail UI: **draft → edit → approve → post** via `MockConnector.postReply`. Audit-logged. Gate behind the `ai_replies` entitlement + increment the usage counter.
**Done when:** a user drafts, edits, and posts (mock) an AI reply end to end; entitlement + usage enforced; guardrails hold.

### P1a-T7 — Action Digest pipeline *(the hero)*
Scheduled per-location BullMQ **repeatable job** implementing the pipeline (see Architecture §6.1): gather the window's reviews + insights → **cluster themes via embeddings** + count praise/complaints → compute **reputation pulse + deltas** vs prior window → attribute **staff/location** mentions → LLM composes a **localized briefing + 3 evidence-linked actions** → attach assets (**draft replies for open negatives + one social post from the top review**) → **persist digest + prior-action outcomes** so the next one closes the loop.
**Done when:** a digest object is generated per location on schedule and on demand, is reproducible from stored data, and includes exactly 3 concrete, evidence-linked actions + assets.

### P1a-T8 — Home / Digest screen *(make it feel great)*
Render the latest digest as **Home**: reputation pulse + delta, what changed, themes with real quotes, the **3 actions** (each actionable), and attached assets; on-demand "generate now"; localized TR/EN. This is the emotional peak of the product — treat the design bar accordingly (assistant handing you a plan, not a report).
**Done when:** Home shows a compelling, localized digest; the 3 actions are clickable/usable; a fresh digest can be generated on demand.

### P1a-T9 — Inbox enhancements
Review cards show **sentiment + theme tags**; filters by source/sentiment/status; review detail shows insights + the reply composer from T6.
**Done when:** the Inbox is filterable by sentiment/theme and every card reflects its analysis.

### P1a-T10 — Sample digest (lead-gen path)
Run the digest pipeline over a **demo/mock dataset** to produce a no-signup **sample digest** (the real public-Google source version is a 1b item).
**Done when:** a sample digest renders from demo data without an account.

### P1a-T11 — Tests + guardrail validation
Analysis quality on the eval set (thresholds); digest generation **deterministic/reproducible** from stored data; **reply guardrails** (an injection attempt neither leaks nor acts); entitlement + usage enforcement; **tenant scoping** of every AI call (no cross-org context).
**Done when:** all suites pass; a documented adversarial prompt-injection case is proven safe.

---

## Key Contracts

**`review_insights`** — review_id, organization_id, sentiment(`pos|neu|neg`), sentiment_score(float), topics(text[]), embedding(vector).

**Digest object** — location_id, period, pulse{score, delta}, changes[], themes[{label, count, sentiment, quotes[]}], callouts[], actions[3]{text, evidence_ref}, assets{reply_drafts[], social_post}, prior_actions_outcome.

**AI guardrail rules** — review text is untrusted input; no cross-tenant data in prompts; replies never fabricate facts/offers and are length-bounded; every AI action is audit-logged; usage metered against plan.

**Entitlements used** — `ai_replies` (feature), `ai_analyses_per_month` (limit); enforced server-side via `can()` / `withinLimit()`.

## Env additions

```
# LLM (dev account — NOT a gated platform API)
ANTHROPIC_API_KEY=      # or OPENAI_API_KEY
# Dev email transport
SMTP_URL=smtp://localhost:1025   # e.g. Mailhog
```

## Out of Scope — Deferred to Phase 1b (post-company)

Real connectors (Google, first-party, WhatsApp, Instagram); İYS/consent flows and live SMS/WhatsApp/production email sends; WhatsApp digest delivery (needs Meta); public-Google sample digest; widgets, benchmarking, competitor watch (Phase 3). **Do not begin these until the company is formed and 1a is complete.**

---

## Claude Code Kickoff Prompt

> Read `CLAUDE.md` and `docs/10-phase-1a-build-plan.md`. Phase 0 is complete. We're starting **Phase 1a** — the AI layer and Action Digest, built entirely on the existing MockConnector. Restate the Phase 1a Definition of Done and confirm you will NOT touch any Phase 1b / real-connector work. Then begin at **P1a-T1** and proceed in order, stopping after each task for my review. Keep the locked stack; ask before adding any dependency not named in the plan.
