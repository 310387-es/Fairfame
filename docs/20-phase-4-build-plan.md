# Phase 4 — Engage · Build Plan

*Revira · from "manage reviews" to "engage customers" · companion to `docs/02-prd.md` §5 (Phase 4) and `docs/01-master-plan.md` §7*

> **The platform phase.** Adds two-way messaging, NPS/CSAT surveys, contact profiles / light CRM, campaigns, and agency white-label. This is where Revira stops being a review tool and becomes the customer-voice + engagement layer (the long-term vision).
>
> **Gated like 1b:** outbound messaging over **WhatsApp/SMS** needs Meta + İYS credentials (post-company), so build it on **mock/fixtures behind provider flags**, live at go-live. Contacts/CRM, surveys-over-email, and campaign logic are fully buildable now. Reuses the İYS/consent compliance layer and the `contacts`/`consent_records` from earlier phases.

## Definition of Done

A business can hold a **two-way conversation** with a customer, send an **NPS/CSAT survey** and see the score feed insights, manage **contact profiles** with full history, run **campaigns**, and (Agency tier) operate **white-labeled across multiple clients** — all consent-compliant, tenant-scoped, and role-aware. Messaging/WhatsApp runs on fixtures until credentials land.

---

## Compliance — read first

Every outbound message and survey is a **commercial message**: İYS consent + KVKK notice enforced **before send** (reuse the Phase 1b compliance layer), opt-out honored, sends without consent blocked. **Do not build review-gating.** Routing a detractor to a private survey follow-up is fine; routing unhappy customers *away from leaving a public review* while steering happy ones to Google is the prohibited pattern — the survey flow must never gate public-review destinations by predicted sentiment. This gets a test.

---

## Ordered Tasks

### P4-T1 — Contacts / light CRM
Contact profiles (name, phone, email, tags, consent state) with a **timeline** — reviews, requests, messages, surveys in one view; segments (saved contact filters). Extend the existing `contacts`/`consent_records`.
**Done when:** a contact page shows their full history; segments filter contacts; tenant-scoped.

### P4-T2 — Surveys (NPS / CSAT)
Survey builder (NPS + CSAT templates); send via **email now** (SMS/WhatsApp behind flags); collect + score responses; feed scores/sentiment into insights; a compliant **detractor follow-up** (private thank-you/resolution — never a public-review gate).
**Done when:** a survey sends, responses score, results appear in analytics; the detractor flow has no public-review gating.

### P4-T3 — Two-way messaging
A conversations inbox with customers over **WhatsApp/SMS**, built on **mock/fixtures behind provider flags** (same pattern as 1b): inbound webhook + outbound (consent + İYS gated), tied to contacts, templates for outbound.
**Done when:** a mock conversation round-trips; outbound is consent-gated; ties to the contact timeline.

### P4-T4 — Campaigns
Unified outbound campaigns (review requests — extend Phase 1 — plus surveys and messages): audience via segments, scheduling, templates, İYS-compliant, metered sends (SMS/WhatsApp credits).
**Done when:** a campaign targets a segment, schedules, sends (mock), and tracks delivery/conversion; sends are metered + consent-gated.

### P4-T5 — Agency / white-label
Agency operating across **multiple client orgs**: white-label branding (logo, colors, custom domain), the **client role** scoping (already in roles), and bulk multi-location management.
**Done when:** an agency manages ≥2 client orgs from one console, branded; clients see only their own scope.

### P4-T6 — Entitlements
Gate per plan config (reuse `can()`/`withinLimit()`): messaging + surveys + CRM (Growth/Pro), campaigns, white-label + agency console (Agency tier). Config, not code.
**Done when:** plan changes toggle engagement features with no code change.

### P4-T7 — Tests
Tenant + contact isolation; **İYS/consent gate on every outbound** (no send without valid consent) + the **no-review-gating** test; survey scoring; white-label + client-scope isolation; metering; i18n TR/EN; WCAG AA; mobile.
**Done when:** all pass; the consent-gate and no-review-gating tests are explicit and green.

---

## Amendments (recorded while building, 5 Aug 2026)

**Broadcasts are priced at Growth, and that is a reading rather than a
decision.** P4-T6 above says "messaging + surveys + CRM (Growth/Pro), campaigns,
white-label + agency console (Agency tier)" — the parentheticals attach to the
first and last groups, leaving campaigns between them without one. They are
grouped with Growth, because they are plainly not inside the Agency
parenthetical. A broadcast is the *scale* feature, though, which is a fair
argument for Pro. **Open, deliberately deferred by the owner.** Moving it is one
`false` in `src/lib/plans.ts`; `tests/lib/phase4-entitlements.test.ts` asserts
the current value and says why, so changing it means editing an assertion that
explains itself.

**"Bulk multi-location management" (P4-T5) is a read, not a write.** The agency
console shows a roster, every client's locations in one table, and a switcher.
A screen that *wrote* across tenants could not go through `withTenant()`, and a
query that is not tenant-scoped is the one shape this architecture has refused
since Phase 0. Managing a client's locations means being in that client's
account — one click away rather than zero.

**One outbound path is still ungated, and it is a go-live step.** Review-request
email (`src/collect/requests.ts`, P1b-T1) honours the opt-out but does not pass
`checkSendAllowed`. Gating it today would stop review requests sending in every
deployment without an İYS registry, which is all of them; the same send *inside
a broadcast* is gated. Named rather than hidden in
`tests/lib/outbound-consent.test.ts`, and written up as a step in
`docs/13-go-live.md` § İYS.

---

## Reminders (same standards)

Build missing queries **alongside the feature — never stub**. Tokens/charts discipline. Full **TR/EN**. **WCAG 2.1 AA.** **Mobile-first.** WhatsApp is dominant in Türkiye — the messaging UX should feel native to it.

## Out of scope

Nothing beyond this — Phase 4 completes the planned roadmap. Real messaging credentials + live verification happen at go-live (post-company), not here.

---

## Claude Code Kickoff Prompt

> Read `CLAUDE.md` and `docs/20-phase-4-build-plan.md`. Phases 0–3 (incl. 1b connectors) are done. We're starting **Phase 4 — Engage** (contacts/CRM, surveys, two-way messaging, campaigns, agency white-label), on mock/fixtures behind provider flags for anything needing WhatsApp/SMS credentials. First update `CLAUDE.md`'s current-phase pointer, then restate the Definition of Done and the two compliance rules: **İYS/consent before every outbound**, and **no review-gating** (survey detractor flows must never gate public-review destinations by sentiment). Begin at **P4-T1** and proceed in order, pausing after each task for review. Build missing queries rather than stubbing; ask before adding any dependency not named in the plan.
