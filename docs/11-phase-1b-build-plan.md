# Phase 1b — Real Connectors · Build Plan

*Fairfame (provisional) · the real-source sprint · companion to CLAUDE.md, `docs/03-technical-architecture.md` §4, and `docs/09-phase-0-build-plan.md` (Connector contract)*

> **Strategy:** implement every real connector **now**, against each platform's **documented API contract + recorded fixtures**, to the existing `Connector` interface — behind per-provider flags, with **MockConnector as the dev default**. What is gated on company formation is **credentials, platform approvals, and live verification** — not the code.
>
> **Honest caveat:** a connector built without live testing carries **rework risk** (real APIs have quirks the docs omit). Mitigate with strict interface adherence, fixtures, and the per-platform **Go-Live verification suite** that runs when credentials arrive.

## Definition of Done (two stages)

- **Code-complete (now):** each connector implements the `Connector` interface, is unit/fixture-tested, wired to OAuth + the encrypted token vault, and sits behind a provider flag. First-party collection is additionally **live-tested** (it needs no external keys).
- **Live-verified (at go-live, post-company):** real credentials set, platform approvals granted, the live-verification suite passes, the flag flips from mock → real per environment.

## What genuinely needs the company (the true hard gate)

OAuth **app registration and approvals**: Google Business Profile API access request (needs a verified business + website), Meta business verification + app review (WhatsApp/Instagram permissions), and İYS registration (commercial messaging). The **code** does not wait on these; the **live credentials** do.

---

## Status (3 Aug 2026; gaps closed 4 Aug; reviewed 5 Aug 2026) — **Phase 1b complete, code-complete stage**

Every task is built. **Nothing gated on a platform is live-verified**, and cannot be until the company exists — that is stage two of the Definition of Done, and `docs/13-go-live.md` is what to do when it arrives.

| Task | State |
| --- | --- |
| T1 first-party collection | **Done**, code-complete *and* live-tested |
| T0 connector infrastructure | **Done** — OAuth + PKCE, envelope-encrypted token vault with rotation, provider flags, per-provider rate limiting + backoff, capability-driven UI |
| T2 Google Business Profile | **Code-complete**, fixture-tested only — no live Google traffic yet |
| T3 WhatsApp Business | **Code-complete**, fixture-tested only — templates unsubmitted, no live send |
| T4 Instagram | **Code-complete**, fixture-tested only — permissions not app-reviewed |
| T5 İYS + KVKK | **Done**, less the real registry — the gateway adapter refuses by default |
| T6 fixtures, contract tests, go-live suite | **Done** — `pnpm golive` + `docs/13-go-live.md` |

### The gaps this section used to carry — all four closed

Recorded rather than deleted, because "we shipped without X" and "X was never needed" are different histories, and the second one is the version that gets rediscovered the hard way.

- **No browser/UI test layer**, so button→server-action wiring was unverified. **Closed 4 Aug 2026**: Playwright, `pnpm test:e2e`, deliberately outside `pnpm verify` because it needs a live server and database. Evidence: `docs/18-accessibility-verification.md`.
- **Instagram DMs not implemented.** **Closed 4 Aug 2026**: ingested as `item_type = 'dm'` from the `conversations` edge, with the business's own replies filtered out and no `url`, because a DM is private and there is nothing public to link to. **Answering one is still deliberately not built** — that is a *send*, needing the gate extended to Instagram plus Meta's 24-hour window, and `postReply` refuses with that reason rather than a generic failure.
- **No İYS opt-in tick and no worker draining `pendingIysUploads`**, so no first-party contact could lawfully be sent a commercial message. **Closed 4 Aug 2026**: the tick is on the collection form and the `iys_sweep` worker (`src/compliance/iys-upload.ts`, `src/jobs/workers/iys-upload.ts`, every 15 min) drains the queue through the configured gateway. `pnpm golive` now blocks on any consent past its three-business-day deadline. **The gateway is still the seam, not an implementation** — see T5.
- **`MOVABLE_HOLIDAYS` needed a refresh past 2027.** **Closed 4 Aug 2026**: `MOVABLE_HOLIDAYS_KNOWN_THROUGH` is now 2030, and `pnpm golive` warns under 12 months of runway and blocks once it lapses. Still an annual chore, now one the tooling nags about.

**What has not changed:** every platform connector is still fixture-tested only. No live Google, Meta or İYS traffic has ever run through this code. Since 4 Aug all three do run against a fake platform over HTTP (`src/connectors/mock-platform`, `pnpm mock:platform`) — real sockets, real pagination, provider-correct error envelopes — which is not live traffic and cannot prove anything about real quotas, undocumented payload quirks or OAuth consent, but does mean each connector has now talked to something that disagrees with it.

## Ordered Tasks

### P1b-T0 — Connector infrastructure *(done)*
OAuth 2.0 flow framework; **encrypted token vault** (envelope encryption on `connections.encrypted_tokens`) with auto-refresh; per-provider config/flags; capability-driven UI (reply box when `reply:'api'`, "Open on platform" when `reply:'none'`, *Monitor only* / *Live sync* badges); extend the Phase 0 sync scheduler with per-provider rate-limit handling + backoff.
**Done when:** a provider can be registered, tokens stored/refreshed securely, and the UI adapts to declared capabilities — all exercised via the mock + one fixture-backed provider.

### P1b-T1 — First-party collection *(done — code-complete and live-tested)*
Hosted review-request pages + a public submission endpoint; request **campaigns** (email via dev transport now; SMS/WhatsApp deferred to their connectors); **QR / short-links**; conversion tracking (sent → opened → submitted); compliant by construction (**no rating-gating UI**). No platform keys required.
**Done when:** an end-to-end first-party collection flow works and is fully tested locally.

### P1b-T2 — Google Business Profile connector *(code-complete; awaiting live verification)*
OAuth via a Google Cloud project; GBP API client; location mapping; `fetchReviews` (pagination + cursor); `postReply`; `normalize` → canonical `reviews`. Build against documented response schemas with **fixtures**.
**Go-live (post-company):** request Business Profile API access → configure OAuth consent → set env → run live verification (read + reply).

### P1b-T3 — WhatsApp Business (Cloud API) connector — **code-complete, fixture-tested only (3 Aug 2026)**
Template messages; sending (review requests, notifications, **digest delivery**); inbound webhook; **consent + İYS gate before every send** (via the compliance layer, T5). Fixtures for message/webhook payloads.
**Go-live:** Meta Business + WhatsApp Business Account + phone number + template approval + İYS registration → set env → live-verify.

**Nothing here has touched the live API.** A WhatsApp Business Account, a verified number and approved templates are all gated on the company existing. What is verified is that the client speaks Meta's documented contract against recorded payloads, that errors are classified usefully, and that the compliance gate refuses by default.

**The ordering was inverted on purpose.** T3's Definition of Done requires the İYS gate, which is T5's deliverable. Rather than defer it, T3 builds the gate and **enforces it deny-by-default**, and T5 fills in the registry. Today, with no gateway wired, every commercial send is refused with `iys_not_configured`. That is the correct behaviour, not a stub: the failure mode of a permissive default is a stranger's phone buzzing with a message they never agreed to receive, which is fineable under İYS and grounds for Meta to suspend the number. A gate that arrives after the sending code is a gate that was never really required.

**Two intents, because WhatsApp has two.** A business-initiated message needs prior opt-in; a reply inside the **24-hour customer service window** does not, because the customer started the conversation. Conflating them would either block legitimate support replies or wave marketing through as "support".

**New table: `whatsapp_conversations`** (migrations `0017`, `0018`). The window is a fact about a *conversation*, not a campaign. An earlier draft read `review_requests.opened_at`, which conflated "opened the review link we sent" with "sent us a WhatsApp message" — only the second opens the window, and a customer who messages first has no `review_requests` row at all, yet replying to them is exactly what Meta permits. The window is derived from `last_inbound_at` only: **a business cannot open its own window**, and a test pins that.

**The gate is enforced in the send function, not the client.** A client that checked consent would be bypassable by constructing another one; a send path that cannot reach the network without passing the gate is not. A test asserts the client is never called when the gate refuses.

**Consent is keyed on the contact id, never the phone number.** `consent_records.contact_ref` is documented as "a pointer to the contact, not the PII itself" and `contacts` is meant to be the only place a number lives, so a KVKK erasure is one row rather than a hunt.

**Templates are declared in code** (`src/connectors/whatsapp/templates.ts`) with their exact submitted body, because a wording change is a Meta review queue rather than a deploy, and a rejected or edited template must show up in a diff rather than in a customer's message. The review request is declared `MARKETING`, not `UTILITY` — it is unsolicited and promotes the business, and misdeclaring it to dodge opt-in is what gets a number banned. Every template is `status: "draft"`; `pendingTemplates()` is the go-live checklist.

**Bug caught by a test:** the error-code table was keyed in camelCase (`rateLimit`) while the branch compared `"rate_limit"`. Nothing failed to compile — a WhatsApp rate limit simply never triggered backoff and came back as a generic failure. The keys are now the returned type.

**Still to do at go-live:** submit the three templates and record their approval status; set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`; register the webhook and confirm the challenge; wire the İYS gateway (**T5**) — until then commercial sends refuse; then live-verify a send, a delivery receipt, an inbound message and an opt-out.

### P1b-T4 — Instagram (Meta Graph) connector — **code-complete, fixture-tested only (3 Aug 2026)**
Ingest comments / mentions / DMs; inbound webhook; reply where permitted; `normalize` into `reviews` (tagged by `source` + `type`). Fixtures for Graph payloads.
**Go-live:** Meta app + business verification + permissions via app review → set env → live-verify.

**Nothing has touched the live Graph API.** `instagram_manage_comments` and the rest come through Meta app review, which needs business verification, which needs the company.

**Instagram is the first source whose items are not reviews**, and that drove the one schema change: `reviews.item_type` (`review` | `comment` | `mention` | `dm`, migration `0019`). One canonical table means one Inbox, one analysis path and one digest for rows that differ in a single column — a separate table would have meant two of each. The type is a column rather than an inference because the difference is real: a comment carries no rating, and a DM is **not public**, which changes what may be quoted in a digest or a social post.

**It never invents a rating**, and the database agrees: `reviews_rating_only_on_reviews` refuses a rating on anything that is not a review. Mapping enthusiasm to stars would put a number nobody gave into the reputation pulse. A test attempts the update directly and asserts Postgres rejects it — the application never does this, which is exactly why the constraint is worth having.

**It skips the business's own replies.** They come back in the same comments list, and ingesting them would have the product analysing its own words as customer feedback.

**Comment and mention ids live in separate namespaces** (`comment:` / `mention:`). Both are opaque Meta strings that could collide, and the dedup key on `(organization, source, source_review_id)` has to stay unambiguous; the prefix also tells `postReply` what it is replying to without another lookup.

**Replying to a mention is refused**, because Instagram offers no endpoint for it — the business does not own the post. The capability view already sends the owner to the platform; the connector is the backstop.

**The webhook is a signal, not data.** Meta's change events carry different fields depending on permission and object type, so the route enqueues a sync and lets the connector re-read through the Graph API. One normalization path to test rather than two — and a replayed event could at worst cause a redundant read, never an injected comment. It reuses the WhatsApp signature verifier: one Meta app, one secret, and a second constant-time comparison would be a second place to get it wrong.

**Errors are separated by what an operator must do.** A missing permission is an app-review problem, an expired token is a reconnect, a rate limit is neither — and the messages say so rather than repeating Meta's "Application does not have permission for this action".

**Still to do at go-live:** create the Meta app and complete business verification; obtain `instagram_basic`, `instagram_manage_comments` and `pages_show_list` through app review; set `META_APP_ID`, `META_APP_SECRET`, `INSTAGRAM_VERIFY_TOKEN` and `CONNECTOR_INSTAGRAM_MODE=real`; subscribe the webhook and confirm the challenge; then live-verify a comment ingest, a mention ingest, a reply, and a webhook round trip. **DMs are ingested as of 4 Aug 2026** and need `instagram_manage_messages`, which is a separate app-review item — without it the DM edge is logged and skipped while comments and mentions still sync, though a rate limit still propagates so backoff survives. **Answering a DM is deliberately not built**: it is a send, not a reply to public content, and needs the send gate plus Meta's 24-hour customer-service window.

### P1b-T5 — İYS + KVKK compliance layer — **done, less the real registry (3 Aug 2026)**
Consent capture + storage (`consent_records`); an **İYS check-before-send** integration point (gateway adapter — stubbed now, real İYS-connected gateway wired at go-live); opt-out handling; the **3-business-day** consent-upload logic; KVKK data-subject **export/delete**. All commercial sends (T3, and SMS later) pass through this gate.
**Done when:** no commercial message can be sent without a valid consent record; export/delete works; the gateway adapter is swappable.

**What shipped.** `src/compliance/` — `business-days.ts` (the deadline arithmetic), `consent.ts` (capture, withdrawal, the upload queue), `iys-gateway.ts` (the swappable adapter), `subject-rights.ts` (KVKK export and erasure) — plus migration `0020` extending `consent_records`, and the gate from T3 tightened.

**KVKK and İYS consent are not the same thing, and the gate now says so.** KVKK consent is permission to *process* someone's data; İYS consent is permission to *send them a commercial message*, per channel. Where İYS applies, the İYS record is what authorises a send. Treating a review form's data-processing tick as marketing permission is precisely the conflation the registry was created to stop, and a test asserts the gate refuses it.

**Two real bugs came out of writing this**, both in the gate T3 shipped:

- **`revoked_at` was ignored.** The gate read only `granted_at`, so a withdrawn consent still reported as granted — and since withdrawal deliberately never deletes the row, someone who had said stop could be messaged again. This is the most serious defect found in the whole of Phase 1b.
- **A WhatsApp opt-out unsubscribed the contact but left the consent record standing.** "STOP" now revokes consent as well, so our state and the İYS record agree; otherwise a permission the person had withdrawn stayed on file, which is the state a regulator would ask about.

**Consent is per channel.** İYS records permission as (recipient, channel, status): someone may accept messages and refuse calls. One blanket row would mean either over-claiming a permission never given or under-using one that was.

**Withdrawal never deletes.** It sets `revoked_at`, and re-withdrawing keeps the first date — the obligation is to prove the state of a permission over time, and a deleted row proves nothing, including that the person said no.

**The three business days are computed, not approximated.** `business-days.ts` excludes weekends, the seven fixed national holidays and the religious holidays, in Europe/Istanbul. Over Kurban Bayramı the correct deadline is *nine calendar days* out — a naive three-day calculation would be six days early, exactly when a backlog builds. The religious dates are a hard-coded list because there is no rule reliable enough to compute them; `MOVABLE_HOLIDAYS_KNOWN_THROUGH` is **2030** (extended 4 Aug 2026) and `beyondKnownHolidays()` warns rather than being quietly wrong. **This list needs updating annually** — `pnpm golive` warns under 12 months of runway and blocks once it lapses, so the chore is nagged about rather than remembered.

**The deadline is stored, not derived**, so a later calendar correction cannot move a deadline that has already elapsed or been reported. Overdue rows stay in the queue: an obligation that has been missed still has to be discharged, and hiding it would make the queue look healthy precisely when it is not.

**The gateway adapter is swappable and defaults to refusing.** `IYS_GATEWAY=none` (the default) refuses every commercial send. `local` trusts our own consent records for development and **refuses outright in production** — İYS is the system of record, and "we will remember to change the env var before launch" is not a control. A real BSP-backed adapter is one `case` at go-live.

**Erasure anonymises the review rather than deleting it.** Deleting would not unpublish anything, would corrupt every metric that counted it, and would misrepresent the business's own history — so the rating and the fact of the review survive while the author name, the text and the raw payload go. The text goes because a review can identify its author by content alone ("the couple who came in on my birthday with the dog"); keeping it would defeat the request while looking compliant. Insights and their embeddings go too, since an embedding can partially reconstruct the text it came from. Consent records are kept and revoked: `contact_ref` then points at a row that no longer exists, so it identifies nobody while still proving what was granted and withdrawn.

**Export covers what can honestly be attributed.** A first-party submission links to a contact through `review_requests.review_id`; a review left directly on a platform carries no contact id, and matching on a display name would be guesswork that could hand one person another's words.

**Built since (4 Aug 2026):** the İYS opt-in tick is on the collection form, and the `iys_sweep` worker drains `pendingIysUploads` through the configured gateway every 15 minutes — so a captured permission now reaches the registry rather than sitting in a queue nothing read.

**Still to do at go-live:** choose a BSP and add its adapter beside `local`; register with İYS and obtain credentials; set `IYS_GATEWAY` accordingly; and refresh the movable-holiday list each year. **The gateway remains the seam, not an implementation** — `none` refuses (correct before go-live) and `local` accepts without contacting anyone, which is why every accepted row records `iys_uploaded_via`: a `local` upload must stay distinguishable from a registered one forever. Nothing commercial can actually be sent until a real BSP adapter exists.

### P1b-T6 — Fixtures, tests & Go-Live suite — **done (3 Aug 2026)**
Recorded fixtures per platform; contract tests per connector; a documented **live-verification suite** to run when credentials arrive; provider flags default to **mock in dev**, real only where creds are present.
**Done when:** all connectors pass fixture/contract tests; the go-live suite exists and is documented per platform.

**What shipped.** `tests/lib/connector-contract.test.ts` (the shared contract, run over every readable connector), `tests/lib/provider-flags.test.ts` (mock-by-default, over every provider), `scripts/golive.mts` + `pnpm golive`, and `docs/13-go-live.md`.

**The contract suite is the real new coverage here.** Fixtures already existed per platform, and each connector already had a suite testing what makes it *different*. What was missing was a test of what makes them the *same* — and the `Connector` interface is the product's central abstraction, so ingestion, dedup, the Inbox, analysis, the digest and the capability-driven UI all lean on properties the compiler cannot check. `postReply` is present exactly when `capabilities.reply === "api"` is the clearest of them: `postReply?` is optional to every implementation, and the Inbox chooses between a composer and an "Open on platform" link purely on the capability, so a connector that disagreed with its own descriptor would offer an action it cannot perform. Alongside it: `normalize` is pure (digest reproducibility rests on this), no connector produces a row for a location other than the connection's own, ids are unique within a fetch (dedup is on `(organization, source, source_review_id)`), ratings are absent or 1–5 and only ever on an actual review, `raw_payload` survives, and a cursor is never advanced on an empty page. **Adding a connector means adding a row to `CONNECTORS`** — a new source cannot ship without meeting the same bar.

**Mock-by-default is asserted as a system property, not a per-connector one.** The flag test walks the whole registry rather than the connectors that happen to have suites, so a provider added without a default is caught rather than discovered in production. The invariant that matters is the negative one: **there is no configuration in which a missing credential results in an attempted live call** — `real` without credentials, or without a usable vault, demotes to mock with the reason recorded so the Locations screen can say *why* a source is still on sample data.

**`pnpm golive` makes no writes.** It checks configuration, then makes a read-only call where it safely can — listing Google accounts, reading the Instagram account. Nothing posts a reply, sends a message or uploads a consent. The first run happens against a real business's account, and a readiness check people are afraid to run is not one.

**WhatsApp is deliberately verified by hand.** There is no read-only WhatsApp endpoint worth the risk: every call touches a number Meta rate-limits and quality-scores, and a failed send on a fresh number costs its quality rating. So the script reports what it can check statically — tokens, the app secret, template approval status read from `templates.ts` — and points at the manual sequence in `docs/13`, of which the one that matters most is that **STOP** both unsubscribes the contact and revokes the consent record.

**"Not configured" is a normal answer.** The expected state today is that every platform is unconfigured, so the exit code reflects whether something is *broken* — a platform someone believes is live and is not — rather than whether everything is ready. `IYS_GATEWAY=none` outside production is the intended pre-launch default and reports as unconfigured; in production it blocks.

**Still to do at go-live:** everything in `docs/13-go-live.md`, per platform, in the order given there (Google → İYS → WhatsApp → Instagram). The collection opt-in that used to sit in that chain is built; what remains on the İYS step is the BSP adapter and the registry credentials.

---

## Per-Platform Go-Live Checklist *(run when the company exists)*

- **Google:** create GCP project → request Business Profile API access (verified business + website) → OAuth consent screen → set env keys → live-verify read + reply + quotas.
- **Meta (WhatsApp + Instagram):** create Meta app + Business Manager → complete business verification → app review for required permissions → WhatsApp: WABA + number + approved templates → set env → live-verify each.
- **İYS:** register as a sender → connect an İYS-integrated messaging gateway → verify consent capture, check-before-send, and opt-out end to end.
- Flip each provider flag mock → real per environment; keep mock for local dev.

## Recommended Order

Finish **Phase 1a** (the hero — fully verifiable) first or in parallel. Within 1b, do **first-party (T1)** early (it's fully testable and real value), then T0 infra, then the gated connectors (T2–T4) against fixtures, then compliance (T5). Expect a verification/rework pass at go-live for T2–T4.

## Out of Scope

Widgets / showcase, competitor benchmarking, insights beyond the digest (Phase 3+).

---

## Claude Code Kickoff Prompt

> Read `CLAUDE.md` and `docs/11-phase-1b-build-plan.md`. We're building **Phase 1b** real connectors against documented API contracts + fixtures — no live credentials yet; keep MockConnector the dev default and every real connector behind a provider flag. Restate the two-stage Definition of Done (code-complete now vs live-verified at go-live). Start with **P1b-T1 (first-party, fully testable)**, then T0, then the gated connectors. Stop after each task for review; ask before adding any dependency not named in the plan.
