# Go-Live

*Revira · what has to exist before each platform works, and how to verify it · P1b-T6*

Everything in Phase 1b was built against documented API contracts and recorded
fixtures. **None of it has run against a live platform**, because every platform
gates access behind things that need a registered company: a Google Cloud
project tied to a verified business, Meta business verification and app review,
a WhatsApp Business Account, and İYS registration.

This document is what to do when those exist. Run:

```
pnpm golive              # every platform
pnpm golive -- google    # one of them
```

It checks configuration, then makes a **read-only** call where it safely can.
Nothing in it writes: no reply is posted, no message is sent, no consent is
uploaded. The first run happens against a real business's account, and a
readiness check people are afraid to run is not one.

`·` means unconfigured — the expected state today. `✗` means something is
actively wrong: a platform someone believes is live and is not.

---

## The two-stage Definition of Done

Every Phase 1b task carries two states, and the difference is recorded per task
in `docs/11`:

1. **Code-complete, fixture-tested.** The client speaks the documented contract,
   errors are classified, the contract suite passes. This is where T2, T3 and T4
   sit today.
2. **Live-verified.** The steps below have been carried out and the checks pass
   against the real platform.

Nothing may be described as working until stage two. A connector that has never
seen a live response is a hypothesis with tests attached.

---

## Google Business Profile

**Before anything:** the business must be registered and verified in Google
Business Profile. API access is granted per Cloud project and takes days to
weeks.

1. Create a Google Cloud project.
2. Request access to the **Business Profile APIs** — a form naming the business
   and a website. Access is not automatic.
3. Enable: *My Business Account Management*, *My Business Business Information*,
   and *Google My Business* (v4, which still serves reviews).
4. Configure the OAuth consent screen; add the scope
   `https://www.googleapis.com/auth/business.manage`.
5. Create an OAuth 2.0 client (Web) and set the redirect to
   `{BETTER_AUTH_URL}/api/connect/google/callback`.
6. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_VAULT_KEYS`, and
   `CONNECTOR_GOOGLE_MODE=real`.
7. Connect an account from **Locations**, then map it to a Google location.

**Verify:** `pnpm golive -- google` should show a live read listing accounts.
Then, by hand: sync a location and confirm reviews appear in the Inbox; post one
reply from the Inbox and confirm it appears on the Google listing.

**Watch for:** quota. Google's default review quota is low and per-project;
`rateLimitFor("google")` paces us, but a large backfill on day one is the most
likely way to hit it.

---

## WhatsApp Business (Cloud API)

**Before anything:** a Meta Business account, business verification, a WhatsApp
Business Account, a phone number that is not already on consumer WhatsApp, and —
for Türkiye — İYS registration. Template approval takes hours to days per
template and can be rejected on wording.

1. Create the WABA and add a phone number; complete display-name review.
2. Create a system user and generate a **permanent** access token with
   `whatsapp_business_messaging` and `whatsapp_business_management`.
3. Submit the three templates in `src/connectors/whatsapp/templates.ts`. Submit
   the body **exactly as written there** — the file is the source of truth for
   what was submitted, and a divergence means a customer receives copy nobody
   reviewed.
4. When each is approved, set its `status: "approved"` in that file. The
   `pendingTemplates()` check in `pnpm golive` reads it.
5. Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` (the number *id*, not
   the display number), `WHATSAPP_VERIFY_TOKEN` (any secret string), and
   `WHATSAPP_APP_SECRET`.
6. Subscribe the webhook to `{BETTER_AUTH_URL}/api/webhooks/whatsapp` with the
   verify token, and subscribe to the `messages` field.

**Verify — manually, and in this order.** `pnpm golive` deliberately makes no
WhatsApp call: every endpoint is a write, and a failed send costs the number's
quality rating.

1. Webhook subscription succeeds (Meta echoes the challenge).
2. Send yourself a message *from* the business number's WhatsApp to open a
   session; confirm a `whatsapp_conversations` row appears.
3. Reply through `sendSessionReply`; confirm it arrives.
4. Record an İYS consent for a test contact, then send a template through
   `sendTemplateMessage`; confirm it arrives and a delivery status comes back.
5. Reply **STOP** from the test handset. Confirm the contact is unsubscribed
   *and* the consent record is revoked. This is the one that matters most.

**Blocked until İYS is wired:** with `IYS_GATEWAY=none`, step 4 refuses by
design. That is correct behaviour, not a bug.

---

## Instagram (Meta Graph)

**Before anything:** the same Meta app and business verification, plus app
review for each permission. App review needs a screencast of the feature in use,
which is a chicken-and-egg problem worth planning for.

1. Add the Instagram product to the Meta app.
2. Request `instagram_basic`, `instagram_manage_comments` and `pages_show_list`
   through app review. Add `instagram_manage_messages` if DM ingestion is
   wanted — it is a **separate** review item, and the connector is built to run
   without it (see below).
3. Set `META_APP_ID`, `META_APP_SECRET`, `INSTAGRAM_VERIFY_TOKEN`,
   `TOKEN_VAULT_KEYS`, and `CONNECTOR_INSTAGRAM_MODE=real`.
4. Subscribe the webhook to `{BETTER_AUTH_URL}/api/webhooks/instagram`, fields
   `comments` and `mentions`.
5. Connect an Instagram Business account from **Locations**.

**Verify:** `pnpm golive -- instagram` should show a live read naming the
account. Then by hand: comment on one of the business's own posts from another
account and confirm it reaches the Inbox as a `comment` with no rating; reply
from the Inbox and confirm the reply appears on Instagram; tag the business from
another account and confirm a `mention` arrives.

**Direct messages: read, not answered.** DMs are ingested as `item_type = 'dm'`
from the `conversations` edge (`platform=instagram`, or the real API serves
Facebook Page threads instead). Three things about them differ from comments:

- The **business's own replies live in the same thread**, and `from.id` is the
  only thing distinguishing them. They are filtered in the client, or the
  product would analyse its own support answers as customer sentiment.
- A DM carries **no `url`** — it is private, and there is no page a colleague
  could open. It also means a digest must not quote one the way it quotes a
  public review.
- The edge **degrades on its own**. Without `instagram_manage_messages` — the
  normal state before that app-review item passes — the DM fetch is logged and
  skipped, and comments and mentions still sync. A rate limit still propagates,
  so backoff is not lost.

**Replying to a DM is not built.** It is a *send*, not a reply to public
content: it needs the send gate extended to Instagram, Meta's 24-hour
customer-service window, and the messaging scope. The Inbox shows an explicit
refusal saying so rather than a generic failure.

**Verify DMs by hand:** message the business from another account, confirm it
reaches the Inbox as a `dm` with no rating and no link; then reply *from
Instagram* and confirm that reply does **not** appear as a new inbox item.

---

## İYS (Türkiye commercial-message registry)

**Before anything:** İYS registration, which requires the company, and a BSP
(licensed gateway) through which permissions are read and uploaded.

1. Register the business with İYS.
2. Choose a BSP — in practice the same provider as the SMS/WhatsApp gateway.
3. Add an adapter beside `local` in `src/compliance/iys-gateway.ts` implementing
   `IysGateway.check` **and `IysGateway.upload`**, and a case in
   `installIysGateway`. Both are required: whichever BSP answers "does the
   registry hold this permission" is the one that put it there.
4. Set `IYS_GATEWAY` to the new adapter's name. Leave `IYS_REQUIRED=true`.

Steps 5 and 6 are **done** — the collection form has the opt-in tick, and the
`iys_sweep` job (`src/jobs/workers/iys-upload.ts`, every
`IYS_SWEEP_INTERVAL_MS`, default 15 min) drains `pendingIysUploads()` through
the gateway and records what it said. Only the adapter is outstanding.

**Writing the adapter — the contract:**

- Return one `IysUploadOutcome` per input. A record you say nothing about is
  treated as failed, not accepted: silence must never register a permission.
- `retryable: true` means "the registry was unreachable"; `false` means "the
  registry refused this recipient". Both leave the consent queued and unusable,
  but only the first will fix itself, and the queue is what an operator reads.
- Throwing is fine — every row stays queued and is retried next pass.
- `grantedAt` is the moment the customer ticked the box. Report that, never the
  upload time; a late upload of a timely consent is untidy, a re-dated consent
  is a false record.

**Verify:** `pnpm golive -- compliance` shows the gateway by name and reports the
upload backlog — it **blocks** on any consent past its three-business-day
deadline. Then: record a consent, confirm `iys_upload_due_at` is three business
days out, confirm the sweep clears it and stamps `iys_uploaded_via` with the new
adapter's name (not `local`), and confirm a revoked consent is *not* uploaded.

**Recurring maintenance:** `MOVABLE_HOLIDAYS` in
`src/compliance/business-days.ts` lists the religious public holidays, which
move each year. It currently covers through **2027**. Past that,
`beyondKnownHolidays()` warns and every deadline silently ignores four to seven
holidays a year. Put this in a calendar.

---

## What is verified without any credentials

These run today and gate every commit:

| Suite | What it establishes |
| --- | --- |
| `tests/lib/connector-contract.test.ts` | Every connector satisfies the shared `Connector` contract — capabilities match their descriptor, `postReply` exists exactly when the API supports it, `normalize` is pure and never targets another location, ids are unique, ratings are absent or 1–5 |
| `tests/lib/google-connector.test.ts` | Google's payloads, pagination, error classification |
| `tests/lib/whatsapp.test.ts` | Template rendering, send shapes, error classification, webhook signature verification |
| `tests/lib/instagram.test.ts` | Graph payloads, normalization, reply rules, webhook flattening |
| `tests/db/compliance-gate.test.ts` | No commercial message without consent; the 24-hour session window |
| `tests/db/compliance-t5.test.ts` | Consent capture, withdrawal, the upload queue, KVKK export and erasure |
| `tests/lib/business-days.test.ts` | The three-business-day deadline, including over Turkish holidays |
| `pnpm ai:eval`, `pnpm ai:redteam` | Analysis quality and the adversarial corpus — see `docs/12` |

Provider flags default to **mock**, and `resolveMode` demotes a provider asked
for `real` without credentials or a vault. There is no configuration in which a
missing credential results in an attempted live call.

---

## Order to go live in

1. **Google** — the fastest to value and the least entangled. One approval.
2. **İYS — registration, a BSP, and the adapter** — everything commercial is
   blocked until this is done, and it is the longest pole that does not depend
   on Meta. The opt-in tick and the upload worker are already built; what
   remains needs the company.
3. **WhatsApp** — needs İYS in place first, or step 4 of its verification cannot
   pass.
4. **Instagram** — the slowest approval and the least urgent; ingestion works
   without it.
