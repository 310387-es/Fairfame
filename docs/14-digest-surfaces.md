# Digest Surfaces — Email, Archive, and the Cadence Question

*Revira · where the weekly Action Digest goes now that Home is a live dashboard · companion to `docs/10-phase-1a-build-plan.md` (T7/T8) and `docs/home-live-dashboard.md` §6*

> **Why this doc exists.** The Home redesign moved the digest off the screen it was built for. `docs/home-live-dashboard.md` §6 records the intent in one paragraph — "email + a `/digest` archive, not this task" — which was enough to keep that task honest and is not enough to build from. This is the plan.

---

## 1. What is true today (3 Aug 2026)

**The digest is headless.** `digest_sweep` still runs hourly, still composes one digest per location per completed week, still spends model tokens on the briefing, the three actions, the themes and the reply drafts — and nothing renders the result. After the Home redesign:

| Thing | Callers |
| --- | --- |
| `DigestView`, `PulseTile`, `ActionCard` | none |
| `latestDigest`, `listDigests` | none |
| `GenerateDigestButton`, `digestProgressAction` | none |
| `digests` / `digest_actions` rows | written hourly, read by nobody |

`/sample` is not a counter-example: it renders `getSampleDigest` through its own markup, so it neither exercises nor protects the real components.

**And a gap that predates the redesign.** `notification_preferences.delivery` accepts `"digest"`, and `notifications/service.ts` marks those emails `deferred` rather than sending them — deliberately, because the digest was to carry them. Nothing drains that status. Anyone who chose digest delivery has been getting the in-app feed and **no email at all**. `docs/05` calls the digest email the retention loop; today it is an enum value with no consumer.

That is the strongest argument for **D1 first**: it is not a new surface, it is the delivery half of a feature that has been running incomplete.

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

### D1 — Digest email + delivery *(independent; do first)*

The weekly email built from the stored payload, and the job that sends it. Also drains `notifications.email_status = 'deferred'` for the period, since that is what those rows were waiting for.

Reuse `messaging/templates.ts` and the existing transport (Mailpit in dev). The email is its own rendering — an HTML email cannot reuse React components that assume Tailwind — so `DigestView` is the reference for *content order*, not the implementation.

**Done when:** a location with a ready digest receives one email per period at most; deferred notifications for that window are marked sent and appear in it; the send is idempotent under re-run; opt-out is honoured; TR/EN; verified against Mailpit.

### D2 — `/digest` archive

List of past digests for the active location (`listDigests`), and a detail view rendering one through `DigestView` / `PulseTile` / `ActionCard`. The Home AI strip's "View weekly digest" links here — **until this exists that link has no destination and is deliberately absent from the strip.**

`GenerateDigestButton` moves here, with the compose-progress polling it already has. Marking an action done must keep working: `setDigestActionStatusAction` is what closes the digest loop, and the next digest reads those statuses.

**Done when:** past digests are listed newest-first, one opens in full, actions can be marked done/dismissed, compose works with its progress state, empty state for a location with no digests yet, TR/EN.

### D3 — Move the copy out of `home.*`

Digest strings live in the `home` namespace because Home was the digest. Nine are already unused (`generate`, `regenerate`, `generateHint`, `composeSlow`, `composeFailed`, `titleWeek`, `emptyBody`, …) and the rest are read by components that no longer belong to Home.

Do it **with D2**, not before: moving keys whose consumer is about to move is two edits to the same lines.

**Done when:** `digest.*` holds every digest string, `home.*` holds only dashboard copy, TR/EN parity, no unused keys in either.

### D4 — WhatsApp delivery *(gated on go-live)*

The same payload through the `weekly_digest_v1` template that already exists in `connectors/whatsapp/templates.ts`. Blocked on İYS + template approval — see `docs/13-go-live.md`.

**Done when:** consented recipients receive the digest through the compliance gate, refusals are logged rather than swallowed, and it is live-verified against a real number.

---

## 4. What this does not change

The **pipeline stays exactly as it is**. Generation, `computePulse`, theme clustering, the three actions, reply drafts, digest reproducibility and their tests are Phase 1a work that passed and is not in scope here. This is a delivery change: the same payload, rendered somewhere a person will see it.

---

## 5. Order

1. **D1** — closes a live gap; nothing depends on it.
2. **D2 + D3** — after the Home dashboard lands, so the archive inherits the same shell and tokens.
3. **D4** — whenever WhatsApp goes live.
