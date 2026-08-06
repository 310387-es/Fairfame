# Digest Surfaces — Email, Archive, and the Cadence Question

*Revira · where the weekly Action Digest goes now that Home is a live dashboard · companion to `docs/10-phase-1a-build-plan.md` (T7/T8) and `docs/home-live-dashboard.md` §6*

> **Why this doc exists.** The Home redesign moved the digest off the screen it was built for. `docs/home-live-dashboard.md` §6 records the intent in one paragraph — "email + a `/weekly-plan` archive, not this task" — which was enough to keep that task honest and is not enough to build from. This is the plan.

---

## 1. What is true today

> **Status — D1, D2 and D3 are done (3 Aug 2026).** The digest has a surface again: it is emailed on the hourly sweep and archived at `/weekly-plan`. What §1 describes below is the state this plan was written against, kept because the reasoning still explains why the design is what it is. D4 (WhatsApp) remains gated on go-live.

**What shipped.** `digest_deliveries` (migration `0023`, RLS'd like every tenant table) records one row per (digest, recipient, channel), which is what makes the hourly sweep safe to re-run — a partial failure retries only the addresses that failed. `messaging/templates.ts` gained `renderDigestEmail`, carrying the whole briefing rather than a link to it; `digest/delivery.ts` resolves recipients, skips the ledger, and discharges the deferred alerts; `digest_deliver` is the ninth job kind, fanned out by the existing `digest_sweep`. `/weekly-plan` lists past weeks and `/weekly-plan/[id]` renders one through the components that were orphaned. The copy moved from `home.*` to `digest.*`, and Home's AI strip links out to the archive when nothing is waiting in the Inbox. Verified against Mailpit in both languages.

---

### The state this plan was written against

**The digest was headless.** `digest_sweep` ran hourly, composed one digest per location per completed week, spent model tokens on the briefing, the three actions, the themes and the reply drafts — and nothing rendered the result. After the Home redesign:

| Thing | Callers |
| --- | --- |
| `DigestView`, `PulseTile`, `ActionCard` | none |
| `latestDigest`, `listDigests` | none |
| `GenerateDigestButton`, `digestProgressAction` | none |
| `digests` / `digest_actions` rows | written hourly, read by nobody |

`/sample` was not a counter-example: it renders `getSampleDigest` through its own markup, so it neither exercised nor protected the real components.

**And a gap that predated the redesign.** `notification_preferences.delivery` accepts `"digest"`, and `notifications/service.ts` marks those emails `deferred` rather than sending them — deliberately, because the digest was to carry them. Nothing drained that status. Anyone who chose digest delivery got the in-app feed and **no email at all**. `docs/05` calls the digest email the retention loop; it was an enum value with no consumer.

That was the strongest argument for **D1 first**: not a new surface, but the delivery half of a feature that had been running incomplete.

---

## 2. The cadence decision — settle before D1

Everything today is weekly, and it is weekly in three places at once: `weekWindow()` computes a completed Monday-to-Monday window, `digests` is unique on `(location_id, period_start)`, and the sweep asks "does this location have a digest for the last completed week".

A **daily** digest is not a scheduling change on top of that. A daily and a weekly digest for the same location can share a `period_start`, so the unique key collides, and `latestDigest` — "newest ready row" — would return whichever ran last.

Two ways out:

1. **`period_kind` column** (`'weekly' | 'daily'`), unique on `(location_id, period_kind, period_start)`, cadence stored per location or per subscriber. Honest, migratable, and makes "which digest is this" answerable everywhere.
2. **Weekly only**, and let the daily need be served by the live dashboard plus per-review notifications, which already exist.

**Recommendation: (2) until someone asks for daily.** The digest's value is that it is a considered weekly briefing with three actions — a daily version competes with the notification email it would sit beside, and doubles model spend. If daily is wanted, do (1) as its own migration before D1 rather than bolting a second cadence onto a schema that assumes one.

---

## 3. Tasks

### D1 — Digest email + delivery — **done**

The weekly email built from the stored payload, and the job that sends it. Also drains `notifications.email_status = 'deferred'` for the period, since that is what those rows were waiting for.

Reuse `messaging/templates.ts` and the existing transport (Mailpit in dev). The email is its own rendering — an HTML email cannot reuse React components that assume Tailwind — so `DigestView` is the reference for *content order*, not the implementation.

**Done when:** a location with a ready digest receives one email per period at most; deferred notifications for that window are marked sent and appear in it; the send is idempotent under re-run; opt-out is honoured; TR/EN; verified against Mailpit.

**How it came out.** `digest/delivery.ts` + `messaging/templates.ts:renderDigestEmail`, mailed by the `digest_deliver` job that `digest_sweep` fans out per organization. Idempotency is `digest_deliveries`, unique on `(digest_id, user_id, channel)` — a `sent` row closes a recipient out, a `failed` row is updated in place on retry. A quiet week still sends, because silence and a broken pipeline must not look identical from the recipient's inbox. Covered by `tests/lib/digest-email.test.ts` (16) and `tests/db/digest-delivery.test.ts` (12); both languages verified in Mailpit.

### D2 — `/weekly-plan` archive — **done**

List of past digests for the active location (`listDigests`), and a detail view rendering one through `DigestView` / `PulseTile` / `ActionCard`. The Home AI strip's "View weekly digest" links here — **until this exists that link has no destination and is deliberately absent from the strip.**

`GenerateDigestButton` moves here, with the compose-progress polling it already has. Marking an action done must keep working: `setDigestActionStatusAction` is what closes the digest loop, and the next digest reads those statuses.

**Done when:** past digests are listed newest-first, one opens in full, actions can be marked done/dismissed, compose works with its progress state, empty state for a location with no digests yet, TR/EN.

**How it came out.** `/weekly-plan` lists weeks with the pulse as a plain number rather than twelve stacked gauges; a pending or failed week is listed but not linked, since there is no briefing behind it. `/weekly-plan/[id]` renders `DigestView` unchanged and reaches a non-ready week deliberately — saying "this could not be composed" beats a 404 implying the week never existed. `digestById` is tenant-scoped, so another organization's id is indistinguishable from one that does not exist. The rail gained a Digest entry under Daily, and the Home strip now links here when nothing is waiting in the Inbox — one call to action, and "reply to these four people" outranks "read last week".

### D3 — Move the copy out of `home.*` — **done**

Digest strings lived in the `home` namespace because Home was the digest, and the rest were read by components that no longer belonged to Home.

**Done when:** `digest.*` holds every digest string, `home.*` holds only dashboard copy, TR/EN parity, no unused keys in either.

**How it came out.** 55 keys under `digest.*` in both locales. `home.title`/`subtitle` became `digest.archiveTitle`/`archiveSubtitle`; `regenerate` and `period` were dropped as consumerless; `generate` and `composing` were reworded to stop taking a `{period}` argument the archive header already supplies. Home kept its own `noLocation`, reworded to stop promising a weekly plan. `check:i18n` passes at 481 keys.

### D4 — WhatsApp delivery *(gated on go-live)*

The same payload through the `weekly_digest_v1` template that already exists in `connectors/whatsapp/templates.ts`. Blocked on İYS + template approval — see `docs/13-go-live.md`.

**Done when:** consented recipients receive the digest through the compliance gate, refusals are logged rather than swallowed, and it is live-verified against a real number.

---

## 4. What this does not change

The **pipeline stays exactly as it is**. Generation, `computePulse`, theme clustering, the three actions, reply drafts, digest reproducibility and their tests are Phase 1a work that passed and is not in scope here. This is a delivery change: the same payload, rendered somewhere a person will see it.

---

## 5. Order

1. ~~**D1** — closes a live gap; nothing depends on it.~~ **Done 3 Aug 2026.**
2. ~~**D2 + D3** — after the Home dashboard lands, so the archive inherits the same shell and tokens.~~ **Done 3 Aug 2026**, in the same pass as D1.
3. **D4** — whenever WhatsApp goes live. The `whatsapp` value already exists in `digest_channel`, so the ledger takes it without a migration.
