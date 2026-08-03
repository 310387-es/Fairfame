# Revira — Planning Docs

Planning and design documentation for **Revira** *(provisional name)* — a review & customer-voice management SaaS. Launch market: Türkiye. Built global-ready.

> Source-of-truth planning docs. `CLAUDE.md` (repo root) gives Claude Code its project context. Build plans: `09` (Phase 0), `10` (Phase 1a), `11` (Phase 1b) — all built. `13` is what to do when credentials arrive.

## Index

| # | Doc | What it covers |
|---|-----|----------------|
| 01 | [Master Plan & Build Blueprint](./01-master-plan.md) | Vision, honest market take, API-access reality, roadmap, risks — the umbrella. |
| 02 | [Product Requirements (PRD)](./02-prd.md) | Personas, the core loop, features + acceptance criteria per phase, the Action Digest hero spec. |
| 03 | [Technical Architecture](./03-technical-architecture.md) | Stack, connector framework, mock-connector dev strategy, data model, entitlements, KVKK/İYS handling. |
| 04 | [Türkiye Market Analysis](./04-turkiye-market-analysis.md) | Local platforms & competitors, buyer behavior, compliance landscape, entry strategy. |
| 05 | [Business Model & GTM](./05-business-model-and-gtm.md) | Pricing tiers, feature × plan matrix, unit economics, go-to-market, naming. |
| 06 | [Product UX, Roles & Flows](./06-ux-roles-and-flows.md) | Org/location/team model, roles, navigation, and step-by-step user journeys. |
| 07 | [Ideas & Parking Lot](./07-ideas-parking-lot.md) | "Not now, don't forget" — premium-digest ideas, deferred bets, open decisions. |
| 08 | [Design Brief](./08-design-brief.md) | Brand, principles, screens, components, and flows to hand to the design phase. |
| 09 | [Phase 0 Build Plan](./09-phase-0-build-plan.md) | ✅ Done — foundations: tenancy/RLS, auth, entitlements, mock connector, vertical slice. |
| 10 | [Phase 1a Build Plan](./10-phase-1a-build-plan.md) | ✅ Done — AI analysis, notifications, AI replies, and the Action Digest, on the mock connector. |
| 11 | [Phase 1b Build Plan](./11-phase-1b-build-plan.md) | ✅ Built — real connectors against documented APIs + fixtures; credentials and live verification at go-live. |
| 12 | [AI Guardrail Validation](./12-ai-guardrail-validation.md) | What has actually been tested about the AI layer: threat model, structural defences, adversarial results, known gaps. |
| 13 | [Go-Live](./13-go-live.md) | Per-platform prerequisites and verification steps for when the company exists — plus what `pnpm golive` checks and what it deliberately does not. |

Repo root also has **`CLAUDE.md`** — project context + locked stack for Claude Code.

## Assets

- [`assets/revira-logo-concepts.svg`](./assets/revira-logo-concepts.svg) — three logo directions (monogram chosen).
- [`assets/revira-how-it-works.html`](./assets/revira-how-it-works.html) — visual product map (account model + user flows).

## Roadmap status

- **Phase 0 — Foundations:** ✅ done.
- **Phase 1a — AI layer & Action Digest (on mock):** ✅ done, and live-verified against a real model.
- **Phase 1b — real connectors:** ✅ code-complete. T1 first-party collection is live-tested; T0 infrastructure, T5 compliance and T6 the contract/go-live suite are done. **T2 Google, T3 WhatsApp and T4 Instagram are fixture-tested only** — credentials, platform approvals (Google Business Profile, Meta verification + app review, İYS) and live verification are gated on company formation. See [`13-go-live.md`](./13-go-live.md).

## Stack (locked)

Next.js + TypeScript · self-hosted Postgres + pgvector (Docker) · Drizzle · BetterAuth (org plugin) · Redis + BullMQ · Zod · next-intl (TR/EN) · LLM abstraction · Stripe skeleton.

*Working name "Revira" is provisional — pending domain + trademark verification.*
