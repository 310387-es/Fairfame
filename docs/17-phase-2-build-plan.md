# Phase 2 — Unified Inbox & Team Workflow · Build Plan

*Revira · turns the inbox into an operations tool · companion to `docs/02-prd.md` §5 (Phase 2) and `docs/06-ux-roles-and-flows.md`*

> **Builds on what exists.** Phase 1 already shipped a basic inbox (`src/components/inbox/{filter-bar,review-list,reply-composer}.tsx`, `src/inbox/queries.ts`) for the AI-reply flow. Phase 2 elevates it from "list + reply" into a real **team triage inbox**: unified across sources, with status, assignment, SLA, templates, saved views, bulk actions, and near-real-time updates. Still on the **mock connector** (real sources are 1b, gated on the company).

## Definition of Done

A team can triage every review and mention from **one inbox** — filter/search/save views, assign to a teammate, track status and SLA, reply with a template or AI, and act in bulk — all tenant- and location-scoped and role-aware. Nothing here needs a real platform API.

---

## Schema additions (Drizzle + RLS)

- **reviews**: `status` (`open` | `in_progress` | `done` | `ignored`, default `open`), `assignee_user_id` (nullable → memberships), `priority` (nullable, derived: negative + unanswered + recency), `first_response_at` (nullable), `sla_due_at` (nullable). Backfill existing rows to `open`.
- **reply_templates**: id, org_id, name, body, language (`tr`|`en`), tags[]. Tenant-scoped.
- **saved_views**: id, org_id, owner_user_id (null = shared), name, filters(jsonb), position.
- `audit_logs` already exists — log status changes, assignments, bulk actions.

---

## Ordered Tasks

### P2-T1 — Inbox schema + workflow fields
Migrations for the above; RLS on new tables; backfill `status='open'`. Derive `priority` and `sla_due_at` on ingest (SLA target from org/location settings).
**Done when:** migrations apply; existing reviews are `open`; new mock reviews get priority + SLA set.

### P2-T2 — Unified inbox query + filters
Extend `src/inbox/queries.ts`: filter by source, sentiment, rating, **status, assignee, theme**, date; **full-text search** on review text; keyset pagination / infinite scroll. One tenant+location-scoped query, same "facts" discipline as the dashboard (no divergent counts).
**Done when:** every filter combines correctly, scoped to the active location, paginated.

### P2-T3 — Filter bar + saved views
Extend `filter-bar.tsx`; add **quick filters** (Unanswered · Negative · Assigned to me · Overdue) and **saved views** (per-user + shared) persisted in `saved_views`. Filters live in the URL (shareable, server-readable).
**Done when:** a user saves a filtered view and returns to it; quick filters one-click work.

### P2-T4 — Status & assignment workflow
Set status (open→in_progress→done / ignored); assign/unassign to a member (respect **location scope + role** — a Member only sees/assigns within their locations); **SLA timer** with an overdue indicator; every action audit-logged; `first_response_at` set on first reply.
**Done when:** a review can be assigned, moved through statuses, and shows SLA state; permissions enforced server-side.

### P2-T5 — Reply templates
CRUD for `reply_templates`; insert-into-composer with variable substitution (name, location); keep the **AI draft** from Phase 1a and the `ai_replies` entitlement gate; language-aware (TR/EN). Post via the connector (mock now, real in 1b).
**Done when:** a user replies from a template or AI draft; templates are tenant-scoped and localized.

### P2-T6 — Bulk actions
Multi-select → assign, set status, apply a template/AI reply, or tag. **Guardrail:** no bulk *auto-post* of public replies without per-item review (protects the brand + platform ToS). Bulk actions audit-logged and authz-checked per item.
**Done when:** bulk assign/status/tag work on a selection; bulk public-reply requires review; authz holds.

### P2-T7 — Near-real-time + alerts
New/updated items appear without a manual refresh (revalidate/stream); **urgent** items (negative or SLA-breaching) raise alerts through the existing notifications system.
**Done when:** a new mock review surfaces in the open inbox and fires the right notification.

### P2-T8 — Entitlements & team scope
Gate **saved views / bulk actions / SLA** per plan config (config, not code — reuse `can()`/`withinLimit()`); enforce the location-scoped role rules everywhere in the inbox.
**Done when:** plan changes toggle these features with no code change; no cross-scope access.

### P2-T9 — Tests
Tenant isolation on inbox queries; assignment + role/scope enforcement; SLA computation; template rendering + substitution; bulk-action authz (esp. no unreviewed bulk public post); i18n TR/EN; WCAG AA; mobile triage layout.
**Done when:** all suites pass; the bulk-post guardrail has an explicit test.

---

## Reminders (same standards as Home)

Build any missing aggregate/query **alongside its widget — never stub**; flag anything unsourceable. Tokens/charts use the design tokens (no hardcoded hex). Full **TR/EN** parity. **WCAG 2.1 AA.** **Mobile-first** — owners triage from a phone between customers, so the inbox must be excellent on small screens.

## Out of scope

Real-connector live verification (Phase 1b, post-company); widgets/showcase + benchmarking (Phase 3); engagement — messaging/surveys/CRM (Phase 4).

---

## Claude Code Kickoff Prompt

> Read `CLAUDE.md` and `docs/17-phase-2-build-plan.md`. Phase 1 (foundations + AI/digest + live Home) is done. We're starting **Phase 2 — the unified inbox & team workflow**, building on the existing inbox (`src/components/inbox/*`, `src/inbox/queries.ts`), still on the mock connector. First, update `CLAUDE.md`'s current-phase pointer to Phase 2, then restate the Definition of Done. Begin at **P2-T1** and proceed in order, pausing after each task for review. Keep the locked stack; build missing queries rather than stubbing; ask before adding any dependency not named in the plan.
