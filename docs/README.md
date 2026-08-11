# Fairfame — Planning Docs

Planning and design documentation for **Fairfame** — a review & customer-voice management SaaS. Launch market: Türkiye. Built global-ready.

> Source-of-truth planning docs. `CLAUDE.md` (repo root) gives Claude Code its project context. Build plans: `09` (Phase 0), `10` (Phase 1a), `11` (Phase 1b), `17` (Phase 2), `19` (Phase 3) — all built; `20` (Phase 4) is planned and not started. `13` is what to do when credentials arrive.
>
> **Numbering is chronological, not thematic** — a doc keeps the number it was written under. `14` was briefly used twice; the Phase 4 plan now sits at `20`, after the phase plan before it.

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
| 14 | [Digest Surfaces](./14-digest-surfaces.md) | Where the weekly digest goes now Home is a live dashboard: email (D1), a `/weekly-plan` archive (D2), the copy move (D3), WhatsApp (D4) — and the weekly-vs-daily cadence decision. |
| 15 | [Design System](./15-design-system.md) | Tokens, type, components and layout rules. **Read before any UI work** — one theme, no dark mode, no literal hex. |
| 16 | [Code Hygiene](./16-code-hygiene.md) | What `pnpm knip` and `pnpm check:i18n` gate, and the standing exceptions — including what is unshipped rather than dead. |
| 17 | [Phase 2 Build Plan](./17-phase-2-build-plan.md) | ✅ Done — unified inbox, triage, assignment and SLA, saved views, bulk actions, team scope. |
| 18 | [Accessibility & Mobile Verification](./18-accessibility-verification.md) | Evidence for the WCAG AA and 390px requirements: what was automated, what was checked by hand, and with which screen readers. |
| 19 | [Phase 3 Build Plan](./19-phase-3-build-plan.md) | ✅ Done — widgets, rating badge, SEO review pages, the Insights workspace, scheduled PDF reports, competitor benchmarking. |
| 20 | [Phase 4 Build Plan](./20-phase-4-build-plan.md) | ✅ Done — contacts/CRM, surveys, two-way messaging, broadcasts, agency white-label. |
| 21 | [Visual Language](./21-visual-language.md) | ✅ In force — refines [15](./15-design-system.md) after judging the running app on real data at 1440px and 390px, EN and TR. Re-spaced type scale, elevation, the selection surface, and a prioritised list of what to elevate. **Read with 15; where they disagree, 21 wins.** |
| 22 | [Post-Test Fix Plan](./22-post-test-fix-plan.md) | ✅ Done — a cold café-owner run over 73 items, worked as Waves A (stop the bleeding), B (the first five minutes) and C (trust and polish). |
| 23 | [Build Log](./23-build-log.md) | **The decision record** — every phase and wave, with the argument behind each rule. Lived at the top of `CLAUDE.md` until that file passed the 150k-character agent limit. Read the relevant entry before reversing a decision. |
| 24 | [Brand Guidelines](./24-brand-guidelines.md) | The decided identity — the name **Fairfame**, the ff-ligature logo, colour and type rules, asset inventory in `brand/`. Two gates still open: trademark screening and the domain purchase. |
| — | [Remediation Plan](./remediation-plan.md) | The founder audit's prioritised fix list (Waves 1–5). Unnumbered because it cuts across phases rather than following one. |
| — | [Home — Live Dashboard](./home-live-dashboard.md) | Implementation handoff for the Home redesign: tokens, layout, the ten widgets, data notes. |

Repo root also has **`CLAUDE.md`** — project context + locked stack for Claude Code.

## Assets

- [`../brand/`](../brand/) — **the decided identity** (Fairfame ff-ligature): lockups, symbol, favicon, PNG exports. Rules in [`24-brand-guidelines.md`](./24-brand-guidelines.md).
- [`assets/revira-logo-concepts.svg`](./assets/revira-logo-concepts.svg) — three logo directions from the Revira era; superseded by `brand/`.
- [`assets/revira-how-it-works.html`](./assets/revira-how-it-works.html) — visual product map (account model + user flows).

## Roadmap status

- **Phase 0 — Foundations:** ✅ done.
- **Phase 1a — AI layer & Action Digest (on mock):** ✅ done, and live-verified against a real model.
- **Phase 1b — real connectors:** ✅ code-complete. T1 first-party collection is live-tested; T0 infrastructure, T5 compliance and T6 the contract/go-live suite are done. **T2 Google, T3 WhatsApp and T4 Instagram are fixture-tested only** — credentials, platform approvals (Google Business Profile, Meta verification + app review, İYS) and live verification are gated on company formation. See [`13-go-live.md`](./13-go-live.md).
- **Phase 2 — unified inbox & team workflow:** ✅ done, on the mock connector.
- **Phase 3 — showcase & analyze:** ✅ done, on the mock connector. Live competitor data is gated on go-live.
- **Phase 4 — engage:** ✅ done, on mock/fixtures. Outbound messaging is gated on credentials the way 1b is.
- **Founder audit remediation:** [`remediation-plan.md`](./remediation-plan.md). Waves 1–5 ✅ — the first mile, the two bets (Action Digest + WhatsApp), IA and naming, screen richness, and the missing-features backlog. Three W5 items (more sources, Google Q&A/Posts, real competitor data) are gated on a credential obtained through a commercial relationship that does not exist yet; see [`13-go-live.md`](./13-go-live.md).
- **Post-test fixes:** [`22-post-test-fix-plan.md`](./22-post-test-fix-plan.md). Waves A, B and C ✅, less one rename declined with its reasoning.
- **What remains is not code.** No live platform traffic has ever run through Google, WhatsApp or Instagram, and no commercial message has ever left the machine — both gateways default to refusing. The re-test gate is open: nobody has sat down cold in front of the build and been watched.

## Stack (locked)

Next.js + TypeScript · self-hosted Postgres + pgvector (Docker) · Drizzle · BetterAuth (org plugin) · Redis + BullMQ · Zod · next-intl (TR/EN) · LLM abstraction · Stripe skeleton.

*The name is decided: **Fairfame** (10 Aug 2026, [`24-brand-guidelines.md`](./24-brand-guidelines.md)) — adopted-at-risk pending trademark screening and the fairfame.com purchase. The display-name sweep has run: every surface a customer reads says Fairfame. "Revira" survives on purpose in three places — **identifiers** (cookie names, the `revira_app` database role, the `data-revira-widget` embed attribute, log fields, test hostnames), which are contracts rather than copy; **the dated headers of these planning docs**, which were written under the working name; and **three comments** that explain what was replaced and why. A rename that reaches into any of those buys nothing and breaks something.*
