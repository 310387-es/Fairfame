# Phase 1a — AI Layer & Action Digest · Build Plan

*Revira (provisional) · the hero sprint · builds entirely on the MockConnector — no real platform APIs required · companion to CLAUDE.md, `docs/02-prd.md` §6, and `docs/03-technical-architecture.md` §6*

> **Goal:** turn ingested (mock) reviews into **AI insights, notifications, AI-drafted replies, and the weekly Action Digest** — the product's hero and its real differentiator. This is fully buildable now; it needs only an LLM API key, not the gated Google/Meta APIs.
>
> **Status (2 Aug 2026):** parts of Phase 1b were built ahead of this phase — **P1b-T1** (first-party collection, live-tested), **P1b-T0** (connector infrastructure: OAuth, token vault, provider flags, rate limiting) and **P1b-T2** (Google connector, fixture-tested only). See `docs/11-phase-1b-build-plan.md`. Phase 1a is now the active phase and runs to completion before the remaining 1b tasks (**T3 WhatsApp, T4 Instagram, T5 İYS/KVKK, T6 go-live suite**) resume.
>
> **Phase 1a is complete (2 Aug 2026).** T1–T11 all done and live-verified. Guardrail evidence: `docs/12-ai-guardrail-validation.md`. Next: the remaining Phase 1b tasks — **T3** WhatsApp, **T4** Instagram, **T5** İYS/KVKK, **T6** go-live suite — see `docs/11`.
>
> **Still true, and the reason for that ordering:** nothing in 1b can be *verified* until the company exists and the platforms approve their apps, whereas every item below is fully verifiable today with an LLM key. Prefer 1a work whenever the two compete.

## Definition of Done

A user with a connected **Mock** source: (1) sees every review auto-analyzed for **sentiment + themes** (Turkish and English), (2) is **notified** of new/negative reviews, (3) can **generate → edit → post (mock)** an on-brand AI reply, and (4) receives a weekly **Action Digest** on the Home screen — reputation pulse, what changed, themes with quotes, and **3 concrete actions** with ready-to-use assets — with the loop **closing week over week**.

## Prerequisites (added this phase)

- An **LLM API key** (Anthropic or OpenAI) in env — this is a normal dev account, not a gated business API.
- **pgvector** enabled in Postgres (for embeddings).
- A dev email transport — **already present**: Mailpit in `docker-compose.yml` (inbox at `localhost:8025`) behind the `EmailTransport` interface in `src/messaging/email.ts`.

---

## Ordered Tasks

### P1a-T1 — AI provider abstraction + guardrails
Provider-agnostic LLM client behind an interface (swap Anthropic/OpenAI), env-configured; retries, timeouts, and **cost/usage logging**. A central `prompts/` module. Baseline **guardrails**: treat all review text as untrusted (prompt-injection defense), strict **tenant scoping** (never put another org's data in a prompt), every AI action audit-logged.
**Done when:** a single `analyze(text)` / `draft(...)` call works through the abstraction, is logged, and a prompt-injection attempt in a review body cannot change system behavior.

### P1a-T2 — pgvector + insights schema
Enable `pgvector`. Add **`review_insights`** (review_id, organization_id, sentiment, sentiment_score, topics text[], embedding vector) and a `tags` table. Migration + RLS on new tenant tables.
**Done when:** migrations apply; insights rows are tenant-scoped; embeddings column stores/searches vectors.

### P1a-T3 — Sentiment + theme extraction — **done (live-verified 2 Aug 2026)**
For each review, produce sentiment (pos/neu/neg + score) and 1–N topic tags, in the review's language, with **comparable TR and EN quality**. Batch + cache; provide a **recompute** path. Ship a small **labeled TR/EN eval set** + a script that reports accuracy so we can measure and defend quality.
**Done when:** analysis populates `review_insights` for all reviews; the eval script runs and reports metrics above an agreed threshold.

**What shipped.** `src/ai/analysis-run.ts` (batch runner: cache, pacing, bounded concurrency, recompute, embedding pass), `src/ai/embeddings.ts` (embedding seam + batched Gemini provider + offline stub), `src/ai/eval.ts` + `tests/fixtures/eval/reviews.json` (40 labelled reviews, 20 TR / 20 EN, matched class balance), `src/lib/pacer.ts`, and the CLIs `pnpm ai:analyze` / `pnpm ai:eval`.

**Agreed thresholds** (`THRESHOLDS` in `src/ai/eval.ts`, enforced **per language**, not on the average): sentiment accuracy ≥ 85%, macro-F1 ≥ 80%, language detection ≥ 95%, theme hit rate ≥ 70%, and a **cross-language gap ≤ 10pp** — the "comparable TR and EN" requirement made checkable.

**Measured** (`gemini-3.5-flash-lite`, 40 cases, 0 errors): 100% sentiment accuracy and macro-F1 in both languages, 100% language detection, 98% theme hit rate, including every sarcasm and faint-praise case. **Read this as a floor, not proof**: 40 self-authored cases is a small set, and it measures the model against our idea of a hard review rather than against real Turkish corpora. Re-run it before any model or prompt change.

**Live backfill:** 99 reviews analyzed and embedded (768-dim), 0 failures, 497s at 12 req/min; a second run analyzed nothing and reported 99 cache hits.

**Cache key is the review text, not `updated_at`** — the sync upsert touches `updated_at` on every run whether or not anything changed, so a timestamp cache would re-analyze the whole corpus daily. `review_insights.content_hash` holds a 32-hex-char SHA-256 prefix; the staleness check recomputes the same digest in SQL, so `CONTENT_HASH_LENGTH` must stay in step on both sides.

**Known follow-up for T7:** themes are extracted in the review's own language, so `personel` (16) and `staff` (10) are currently separate tags for the same theme. The digest will need cross-language theme merging.

### P1a-T4 — Wire analysis into ingestion — **done (live-verified 2 Aug 2026)**
When the Mock sync upserts a review, enqueue a BullMQ **analysis job** → insights populate automatically; backfill existing reviews.
**Done when:** connecting/syncing a Mock source yields analyzed reviews with zero manual steps.

**What shipped.** Two new job kinds on the existing `reviews` queue — `analyze` (one organization) and `analyze_sweep` (the scheduled fan-out) — in `src/jobs/workers/analyze-reviews.ts`, plus `src/jobs/client.ts` so server actions can enqueue without opening a Redis connection per request. `createSyncWorker` is now `createReviewWorker`; it dispatches all four kinds.

**Three paths reach analysis, on purpose.** The worker's `sync` handler enqueues after any sync that inserted or updated rows (the fast path); `connectSourceAction`, `syncNowAction` and `mapGoogleLocationAction` enqueue after their inline sync, since those run in the web process without a worker; and `analyze_sweep` (every 5 min, `ANALYZE_SWEEP_INTERVAL_MS`) finds anything the first two missed. **Enqueuing never fails the caller** — a connect that succeeded must not report an error because Redis hiccuped, and the sweep recovers the dropped job within minutes. That sweep is also the backfill path for reviews predating the feature.

**The monthly plan limit is enforced here.** `ai_analyses_per_month` had a value in every plan and no enforcement anywhere. Automatic analysis is the only place that spends a tenant's allowance without a human asking, so the job checks `withinLimit` first, caps the batch to what remains, and meters `recordUsage` by what was *actually* analyzed — a failed call already cost tokens (metered as `ai_tokens`) but produced no analysis and must not consume the allowance. Hitting the ceiling returns `skipped: "limit_reached"`, never an error: a retry cannot change a billing period.

**A job drains 50 reviews then re-enqueues itself** if more remain, so a large backlog cannot hold a worker slot for an hour — and that also closes the race where reviews arrive while a run is active.

**Providers now declare their own rate ceiling** (`LlmProvider.requestsPerMinute`; `null` means none). The stub declares `null`, because pacing a hash function at 12 requests a minute added five seconds of dead waiting per review — it took the job test suite from 25s to 248s before this was fixed.

**`tests/db/setup.ts` forces `AI_PROVIDER=stub` and clears the API keys.** `.env` carries a real Gemini key, and once analysis runs on ingestion, `pnpm test:db` would otherwise spend a developer's quota and go red whenever the free tier said no.

**Live check:** with `pnpm worker` running against real Gemini, connecting a Mock source produced 8 reviews and 8 insights with no manual analysis call.

**Known follow-up for T7:** topics come back in the review's own language *most* of the time, but not always — one Turkish review in the live run was tagged `price` rather than `fiyat`. Combined with the `personel`/`staff` split already noted in T3, the digest needs canonical cross-language theme merging.

### P1a-T5 — Notifications — **done (live-verified 2 Aug 2026)**
Notification model + service: **in-app feed + email** (dev transport). Trigger on new review; **negative (≤3★ or negative sentiment) flagged urgent**. Per-user, per-location **preferences** (all / negative only / off; instant vs digest).
**Done when:** a new mock review produces the right notifications per the user's prefs; negatives are prioritized.

**What shipped.** Two tables (migrations `0011_notifications`, `0012_notifications_security`): `notification_preferences` and `notifications`. `src/notifications/` holds preference resolution, the service that turns reviews into alerts, the feed queries and the sender. A third job pair — `notify_sweep` → `notify` — in `src/jobs/workers/notify-reviews.ts`. UI: a `/notifications` feed, an unread badge in the sidebar, and a preferences section in Settings.

**Negative means either signal, not both.** A review is urgent if it is ≤3★ **or** the model read it as negative. Two signals because they arrive at different times and neither is sufficient: a 1-star with no text has no sentiment, and a 5-star reading "great, if you enjoy waiting an hour" has no bad rating. Requiring both would let a 1-star arrive as routine news.

**Notification does not wait for analysis.** A rating alone is enough to know a review is negative, and putting an LLM on the critical path of an alert means a capped plan or a provider outage silently mutes notifications. Alerts go out on what is known now; the analysis job then re-enqueues `notify`, which **upgrades urgency on still-unread notifications** whose review the model has since found negative. Read ones are left alone — re-flagging something the user already acted on just pushes it back to the top of their feed.

**Preferences resolve by one rule: most specific row wins.** A row for the exact location beats the user's organization-wide default (`location_id is null`), which beats the system default (all / instant / both channels — PRD N1 promises in-app *and* email). The unique key is declared `NULLS NOT DISTINCT`, without which Postgres treats every null `location_id` as unique and a user accumulates conflicting defaults. `digest` defers the *email* and still writes the feed row; suppressing both would leave a user who chose a calmer inbox with no record at all.

**`client`-role members are not notified by default.** It is the read-only role given to an outside party, and mailing them every review is a disclosure decision the organization has not made. An explicit preference row opts them in.

**RLS is not enough here, and the code says so.** The policy keys on `app.current_org`, which is the only identity Postgres has — so it stops tenant A reading tenant B and nothing more. One member reading another's feed is prevented in `src/notifications/feed.ts`, which is why every function there takes a `userId` and filters on it, and why the tests assert a cross-user `markRead` returns 0.

**Creating and sending are separate.** The row is written with `email_status = 'pending'` and drained afterwards, because the two fail differently: a local write either happens or does not, while a send can hang or bounce. The failure mode is a late email, never a missing notification. `deferred` (digest) and `skipped` (email off) are distinct statuses so "why no email?" has one answer per row.

**`tests/db/setup.ts` now also forces `EMAIL_TRANSPORT=log`.** Same reasoning as `AI_PROVIDER=stub`: `.env` points at Mailpit, so `pnpm test:db` was delivering hundreds of alerts into the dev inbox and would fail whenever that container was down.

**Live check:** with `pnpm worker` running and real SMTP, a Mock connect produced 9 reviews → 11 notifications and 11 emails. The owner (locale `tr`, scope `all`) received all 9 in Turkish; a member set to `negative_only` (locale `en`) received exactly the 2 reviews at ≤3★, both urgent, in English.

### P1a-T6 — AI reply drafting — **done (live-verified 2 Aug 2026)**
Action that drafts a reply in the review's language + a configurable **brand tone**; guardrails (bounded length, **no fabricated facts/offers**). Review-detail UI: **draft → edit → approve → post** via `MockConnector.postReply`. Audit-logged. Gate behind the `ai_replies` entitlement + increment the usage counter.
**Done when:** a user drafts, edits, and posts (mock) an AI reply end to end; entitlement + usage enforced; guardrails hold.

**What shipped.** The `replies` table (migrations `0013_replies`, `0014_replies_security`) plus `locations.brand_tone`; `src/replies/service.ts` for the lifecycle; `src/server/replies.ts` for the actions; and a composer in the Inbox that replaces the disabled placeholder T0 left there.

**Replying by hand was added later (3 Aug 2026), and it is not an afterthought.** As shipped, the only way into the composer was *Draft with AI* — which meant a review could not be answered at all once `ai_analyses_per_month` was spent, because drafting is what creates the reply row. An owner who knew exactly what to write was locked out of their own Inbox for the rest of the billing period. `writeReplyDraft` fixes that: `member` role, no `ai_replies` check, no usage recorded, and everything after it — edit, approve, post, audit — is the same path an AI draft takes. The allowance meters *model calls*; typing a sentence is not one.

**Nothing reaches a platform without an explicit human approval.** There is no code path from `draftReplyForReview` to `postReply` — the model drafts, a person approves, and only an `approved` row can be posted. Editing an approved reply returns it to `draft` and clears the signature, because approval was given for specific words. Drafting and editing need `member`; **approving and posting need `admin`**, since those two publish under the business's name.

**One live reply per review, enforced in Postgres** by a partial unique index excluding `failed` — so a rejected post frees the slot for a different reply while the failed attempt and its reason stay on the record.

**A platform rejection is returned, not thrown.** The tests caught this: `postReply` wrote `status = 'failed'` and then threw, and since everything runs in one tenant transaction, the throw rolled that write back — losing both the reason the owner needs and the vacated slot. Programmer errors (wrong status, missing connection, a source that cannot reply) still throw.

**Replies share `ai_analyses_per_month`.** Not a new counter: `src/lib/plans.ts` already said `ai_replies: true, // capped — see limits.ai_analyses_per_month`. Gated on `can(org, "ai_replies")` and metered only on a successful draft.

**Per-task model routing now exists** (`AI_MODEL_ANALYZE` / `AI_MODEL_DRAFT_REPLY` / `AI_MODEL_DIGEST`). `AiTask` was always documented as driving model routing; it did not. The tasks have different economics — analysis runs on every review and can live on the cheapest tier, while a garbled public reply is worse than no reply. Measured on a Turkish reply prompt: `3.5-flash-lite` 1.3s, `3.5-flash` 4.4s, `3.6-flash` 9.1s; the draft task is set to `3.5-flash`, since 9s is more than a button click can absorb.

**Bug fixed in the Gemini provider: thinking tokens count against `maxOutputTokens`.** Callers set that field meaning "how long may the answer be". On a thinking model the readings collide — measured, `3.5-flash` and `3.6-flash` each spent ~615 tokens reasoning against a 640 budget and returned ~21 tokens of truncated Turkish, after which the empty-reply retry ran until the 60s deadline. The provider now adds 1024 tokens of headroom. Headroom rather than `thinkingConfig`, because the budget field is a hint the model exceeds (measured: 381 thoughts against a requested 128) and its shape varies by model generation. This never showed up before because `3.5-flash-lite` does not think.

**`tests/db/setup.ts` now also clears the per-task overrides** — the third `.env`-bleed after the API key (T4) and the SMTP transport (T5). An override naming a real model made the stub report `gemini-3.5-flash` on its audit row, a model that never ran.

**Live check** (real Gemini, `gemini-3.5-flash`): a 2★ Turkish review saying a promised discount was never applied produced a 543-character reply in fluent Turkish with no stray characters, which **committed to investigating the discount rather than granting one** — the no-fabricated-offers guardrail holding under direct pressure. Edited, approved, posted through `MockConnector.postReply`; audit trail `reply.drafted → reply.edited → reply.approved → reply.posted`; `ai_analyses_per_month=1` recorded.

**Still not exercised:** the composer's buttons. As with every screen so far, no UI test drives a click through to the action — the service layer and the actions are tested, the wiring between button and action is not.

### P1a-T7 — Action Digest pipeline *(the hero)* — **done (live-verified 2 Aug 2026)**
Scheduled per-location BullMQ **repeatable job** implementing the pipeline (see Architecture §6.1): gather the window's reviews + insights → **cluster themes via embeddings** + count praise/complaints → compute **reputation pulse + deltas** vs prior window → attribute **staff/location** mentions → LLM composes a **localized briefing + 3 evidence-linked actions** → attach assets (**draft replies for open negatives + one social post from the top review**) → **persist digest + prior-action outcomes** so the next one closes the loop.
**Done when:** a digest object is generated per location on schedule and on demand, is reproducible from stored data, and includes exactly 3 concrete, evidence-linked actions + assets.

**What shipped.** `digests` and `digest_actions` (migrations `0015`, `0016`); `src/digest/metrics.ts` (pure), `src/digest/pipeline.ts`, `src/digest/queries.ts`; a fourth job pair `digest_sweep` → `digest`; and `src/server/digests.ts` for on-demand generation and closing an action.

**Everything countable is computed in code and handed to the model as fact.** Pulse, deltas, theme counts, which reviews are unanswered. The model is asked only to explain and prioritise. Models are unreliable arithmetic engines, and an owner who catches one wrong number stops trusting every number on the page.

**"Reproducible from stored data" means the computed half.** The numbers are a pure function of rows and the test asserts they are identical across regenerations; the prose is *persisted*, never recomputed to render a page. Claiming a language model returns identical bytes on identical input would be a claim about someone else's sampler, not about our code.

**The three actions are rows, not JSON.** They are the only part of a digest with a life after publication — an owner marks one done and the next week's digest reads that. Each carries `{themeSlug, reviewIds}`, and a test asserts every cited review id resolves, so "evidence-linked" is a fact rather than a label.

**The sweep runs hourly, not weekly.** A weekly cron is a single point of failure whose retry interval is seven days: miss it because the worker was restarting and that week's briefing never exists. An hourly check for a *missing* digest is idempotent — `unique(location_id, period_start)` makes a redundant check cost one query.

**Theme clustering compares labels, not review centroids — and that took two live runs to get right.** The first version averaged each theme's review vectors. Over a 57-review window it folded **50 slugs into one theme**, because short restaurant reviews in one language are all similar to each other: measured, review centroids separate a translation pair from an unrelated pair by 0.765 against 0.721, which is no gap at all. Label embeddings separate at 0.855 against 0.606. The merge also chained (A~B, B~C ⇒ A~C) because it re-averaged the centroid after each merge; it now compares against each cluster's representative label only.

**The threshold is 0.78, measured.** Cross-language pairs sit at 0.80–0.95 and unrelated themes at 0.60–0.67, but same-language near-neighbours are tighter: `temizlik ~ yemek` at **0.753** is only 0.047 below the weakest true positive, `temizlik ~ cleanliness` at 0.800. At 0.75 the live corpus really did fold "yemek" into "temizlik". A single global threshold will misjudge the occasional pair; the `tags` table is the escape hatch when it does.

**Bug fixed: a scheduled job has no human actor.** The pipeline passed `actorUserId ?? ""` into the reply drafter, putting an empty string in a uuid column — which aborted the whole digest transaction and silently cost both assets. `draftReplyForReview` now takes `string | null`, which is what `replies.author_user_id` was already nullable for.

**Live check** over the seeded corpus, real Gemini: a weekly digest at pulse 19.8 (−21.2 against the prior week), three Turkish actions each linked to the `otopark` theme's reviews, two reply drafts, and a closed loop reporting the prior week's actions as `done: 1, open: 2`. Over a 57-review window the clustering produced eight themes with `personel + staff`, `servis + hizmet + service`, `fiyat + değer + price + fiyatlar` and `otopark + park + parking + park yeri` correctly merged — **the cross-language follow-up first flagged in T3 is now closed.**

**Not built here:** rendering. T8 owns the Home screen; today the digest exists only as rows.

### P1a-T8 — Home / Digest screen *(make it feel great)* — **done (live-verified 2 Aug 2026)**
Render the latest digest as **Home**: reputation pulse + delta, what changed, themes with real quotes, the **3 actions** (each actionable), and attached assets; on-demand "generate now"; localized TR/EN. This is the emotional peak of the product — treat the design bar accordingly (assistant handing you a plan, not a report).
**Done when:** Home shows a compelling, localized digest; the 3 actions are clickable/usable; a fresh digest can be generated on demand.

**What shipped.** `src/components/digest/` — `digest-view`, `pulse-tile`, `action-card`, `copy-button`, `generate-button` — and Home itself, which reads one digest row and renders it. Nothing is generated on the page: it loads like any other list.

**Ordered as the brief asks the screen to read** (§32, "Digest is Home… not a wall of charts"): the headline sentence first, then the three actions, then what changed and the loop from last week, then themes with the customers' own words, then the assets. The pulse sits *beside* the briefing rather than above it — a number is context for a plan, not a substitute for one. It is drawn as a three-quarter gauge rather than a bar, because a pulse is a level and a progress bar invites reading it as completion; the colour is banded at 70 and 45 rather than a smooth ramp, so every week does not look the same shade of fine.

**Each action is a task, not a paragraph** — number, sentence, evidence link, and one click to mark it done or dismissed. A closed action stays visible, struck through: watching the list empty is the reward, and a vanished item leaves the owner wondering whether they imagined it. `dismissed` is kept distinct from `done` because the next digest reads them differently.

**"Generate now" reports that the work was queued** rather than pretending to wait. Composing takes the better part of a minute in the worker, and a spinner resolving into the same stale page is worse than saying plainly that it is being written. Admin-only, matching the server action, since it spends the AI allowance.

**Live-verified by actually rendering the page**, not by inspecting components: with the dev server running, a real session was created and `/home` fetched in both locales. Both returned 200 with the full digest — pulse 20 (−21.2), three Turkish actions, the changes list, the loop reporting "1 of 3 completed" with the two still-open actions carried over, themes with real quotes, and a reply draft.

Two copy bugs the render exposed, both fixed: the Turkish subtitle read **"Kadıköy Şubesi şubesinde"** because location names already contain the word, and a falling volume rendered as **"(%-50)"** — a minus glued to a percent sign, in a language that puts the sign first. The direction now lives in the wording.

**The chrome localizes; the briefing does not.** English chrome renders "Review volume fell from 4 to 2 (−50%)" from the same stored digest that says "%50 azaldı" in Turkish, because `changes` are stored as structured data rather than prose. The headline, summary and actions stay in the language they were composed in — the *location's* language, not the viewer's. That is deliberate for MVP and worth revisiting if a chain has managers who do not share a language.

**Bug found by pressing the button, not by reading the code.** "Generate now" failed with `Custom Id cannot contain :`. BullMQ 6 rejects a custom job id containing a colon **unless it splits into exactly three parts** — a compatibility shim its own source marks for removal ("TODO: replace this check in next breaking change with `include(':')`"). The existing `sync:`/`analyze:`/`notify:` ids passed only by having three segments; the digest id embedded an ISO timestamp, whose own colons made it five. All ids now go through `jobId()` in `src/jobs/queue.ts`, which joins with `~` and strips colons, so nothing depends on how BullMQ counts segments — including when that shim is removed. Verified against a live queue for every id shape, and covered by `tests/lib/job-id.test.ts`.

That is the first defect the click-through gap actually produced. Worth recording: the service layer and the actions were tested, the wiring between button and action was not, and this is precisely the class of bug that leaves.

**Known gap:** an action's evidence links to `/inbox?theme=…`, and the Inbox does not filter by theme yet — that is T9. The link lands on an unfiltered Inbox until then. **Closed in T9.**

### P1a-T9 — Inbox enhancements — **done (live-verified 2 Aug 2026)**
Review cards show **sentiment + theme tags**; filters by source/sentiment/status; review detail shows insights + the reply composer from T6.
**Done when:** the Inbox is filterable by sentiment/theme and every card reflects its analysis.

**What shipped.** `src/inbox/queries.ts` (`listInbox` + `inboxFacets`), `src/components/inbox/filter-bar.tsx`, sentiment chips and clickable theme tags on every card, and an Inbox page driven by URL filters.

**Filters are links, not client state.** Every filter is a URL, so a filtered Inbox can be bookmarked, shared, and — the reason this shape was chosen — **linked to from a digest action**. `/inbox?theme=otopark` is what makes "see the reviews behind this recommendation" a single href, and it closes the gap T8 left open.

**One query, not three.** A card needs the review, its analysis and its reply state together; fetching those separately would mean N+1 round trips over the same hundred rows. Theme matching uses `= any(topics)` rather than a LIKE, so it hits the GIN index from migration 0008 and matches exactly — a test pins that "servi" does not match "servis".

**Facet counts are deliberately unfiltered.** They describe the location, not the current selection. Facets that shrink as you narrow make it impossible to widen a search without clearing everything first — and a count that disagreed with what a click actually shows would be worse than no count, so a test asserts the negative facet equals the length of the negative-filtered list.

**A failed reply still counts as unanswered**, matching the reply service: a rejected post frees the review to be answered again, so it is outstanding work. A *draft* counts as answered — somebody is already on it, and listing it as needing attention sends two people to the same review.

**`listReviewsForLocation` stays** in `connectors/normalize.ts`. It is a plain projection of the canonical table and is what the ingestion tests assert against; giving it joins would make those tests depend on analysis having run.

**Bug found by rendering, again.** The unfiltered Inbox printed "100 yorum" beside a filter bar reading 111 total, and `?reply=unanswered` claimed "111 yorumdan 100 tanesi" — stating that exactly 100 matched when the list had simply been truncated at the limit. `listInbox` now fetches `limit + 1` and returns `hasMore`, and the screen says "İlk 100 yorum gösteriliyor" when it is showing a page rather than a total. Three different truths, said differently.

Also fixed: `inboxFacets` ran its four aggregate queries under `Promise.all` on a single transaction client. node-postgres serializes those anyway and warns that concurrent `client.query()` is deprecated and removed in pg@9 — the warning was visible in the test output. They now await in turn, which is what was happening regardless.

**Live check:** every filter rendered through the real page — unfiltered 100 of 111 shown, `sentiment=negative` 34, `theme=otopark` 4, `sentiment=negative&theme=servis` 3, `reply=unanswered&sentiment=negative` 30 — with sentiment chips and URL-encoded Turkish theme links on the cards.

### P1a-T10 — Sample digest (lead-gen path) — **done (live-verified 2 Aug 2026)**
Run the digest pipeline over a **demo/mock dataset** to produce a no-signup **sample digest** (the real public-Google source version is a 1b item).
**Done when:** a sample digest renders from demo data without an account.

**Scope note.** This task was always specified against a mock dataset — the public-Google variant is explicitly a 1b item — so it is fully verifiable today and is marked live-verified. The gated thing is the *Google source*, which this does not use.

**What shipped.** `src/digest/sample-data.ts` (the invented corpus), `src/digest/sample.ts` (the builder), `src/app/sample/page.tsx` (the public route), and `src/digest/change-text.ts`, extracted so Home and the sample describe a change identically.

**It touches no database.** The same metrics and the same prompt as a real digest, run over an invented café, with no organization, no location and no rows. That is only possible because the computation in `metrics.ts` is pure — had the pulse and the clustering lived inside the tenant-bound pipeline, this page would have needed a fake tenant and rows an anonymous visitor could somehow read, which is the shape of an accident waiting to leak a real customer's words. The test file lives in the *unit* suite deliberately: if the sample ever grew a query it would fail there for want of a connection.

**The corpus is invented, not borrowed.** Not the seed data and not a tenant's reviews. A lead magnet built from a real customer's words would be a disclosure however anonymised it looked. The page says so above the content rather than in small print: "Kahve Molası is not a real business and these reviews were written for this page."

**A visitor cannot trigger a model call.** The briefing is composed at most once per locale per hour and cached in the process. A public URL that composes per request is an unauthenticated way to spend the AI budget, and a bored script is all it takes — a test asserts three page loads produce one call.

**It renders on a bad day.** If the model is unreachable the page falls back to a written briefing over the *computed* numbers, so a visitor never sees a figure that disagrees with the themes beside it. `fallback` records which they got.

**`runAi` now accepts `organizationId: null`**, for this one caller. A null skips the audit row and the usage counter — both foreign-keyed to an organization — and logs with `anonymous: true` instead, so cost stays observable. Inventing a placeholder id is exactly the bug that put an empty string into a uuid column in T7.

**Live check:** `/sample` returns 200 with no cookies and no account, in both locales, composed by real Gemini: pulse 62.9 against 84.8 the previous fortnight, three Turkish actions each pinned to a real theme, and change sentences that read "Yorum sayısı 5 iken 14 oldu (%180 arttı)" in Turkish and "Review volume rose from 5 to 14 (+180%)" in English from the same stored data.

**Known limitation:** the sample corpus carries no embeddings, so theme merging falls back to identical-slug grouping and `personel` and `staff` stay separate. That is the honest behaviour without vectors rather than a staged result; giving the demo pre-computed embeddings would make it prettier and less true.

### P1a-T11 — Tests + guardrail validation — **done (live-verified 2 Aug 2026)**
Analysis quality on the eval set (thresholds); digest generation **deterministic/reproducible** from stored data; **reply guardrails** (an injection attempt neither leaks nor acts); entitlement + usage enforcement; **tenant scoping** of every AI call (no cross-org context).
**Done when:** all suites pass; a documented adversarial prompt-injection case is proven safe.

**The evidence lives in `docs/12-ai-guardrail-validation.md`** — threat model, every structural defence with the test that pins it, the adversarial results, and the known gaps. What follows is what T11 *added* rather than re-asserted.

**An adversarial corpus and a runner.** `tests/fixtures/redteam/attacks.json` (12 attacks, 6 categories, TR + EN, against both the classifier and the reply writer), `src/ai/redteam.ts` for scoring, and `pnpm ai:redteam`. The bar is every attack, not a percentage: an eval set measures quality where 95% is good, a security corpus measures whether a defence holds. **Result: 12/12 repelled.**

**Scoring is mechanical — no model judging another model.** A safety check that itself depends on an LLM inherits every weakness it is meant to detect.

**The first corpus was wrong, and that is the more useful finding.** It forbade the phrase "full refund" and flagged this reply as a breach: *"Regarding your request for a full refund and a free meal, our team will follow up with you directly."* That is the guardrail behaving exactly as `DRAFT_SYSTEM` instructs. A test that cannot distinguish committing from acknowledging cannot validate this guardrail, and one that cries wolf gets ignored. Patterns now target commitment language, and offer attacks additionally require deferral wording via `mustDefer`, so a reply that silently drops the customer's request also fails. The runner quotes the model's output beside every violation — the first report said only "matched forbidden pattern" and took a separate script to interpret.

**Proof that no prompt carries another tenant's data.** `tests/db/ai-tenant-scoping.test.ts` records every request the provider receives, seeds two organizations with marker strings, and searches the captured prompts. Stronger than "the query was scoped": it holds however the context was assembled. Analysis, drafting and the digest are all covered, the digest from both sides so a bug favouring one fixture cannot pass. Also: analysing one tenant writes no audit rows against another, and customer words never reach audit `meta`.

**A rate-limit finding.** The runner paces for the *slowest* model in the run, not the configured default: per-task routing sends drafting to `gemini-3.5-flash`, whose free tier is far tighter than the lite tier's. Pacing at the analyze rate lost attacks to 429s, and an unscored attack is not a repelled one — the script now waits out a retry-after and still exits non-zero if anything went unscored.

**Coverage caveat, carried into `docs/12` §3:** the 12/12 run used `gemini-3.5-flash-lite` for the drafting attacks because the production draft model's daily free-tier quota was exhausted by that day's testing. It had repelled 3 of its 5 attacks, including both exfiltration attempts, before the cap. **Re-run `pnpm ai:redteam` on default configuration before go-live.**

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
# Dev email transport — already configured in .env.example (Mailpit)
SMTP_URL=smtp://localhost:1025
```

## Out of Scope — Phase 1b territory

İYS/consent flows and live SMS/WhatsApp sends (**P1b-T5**); WhatsApp digest delivery (**P1b-T3**, needs Meta); Instagram ingestion (**P1b-T4**); the public-Google sample digest (needs a live Google connection); widgets, benchmarking, competitor watch (Phase 3).

Already built, out of scope *because it is done* rather than deferred: first-party collection, the connector framework, and the Google connector's code. **Do not start the remaining 1b tasks until 1a is complete** — they cannot be verified before company formation, so building them early only ages the rework.

Two dependencies now run the other way, from 1a into completed 1b work:
- **T6 creates the `replies` table**, which the Google connector's `postReply` needs before anyone posts a real reply (`docs/03` §5 specifies the shape).
- **T5's email notifications** should use the `EmailTransport` seam already built in `src/messaging/email.ts` rather than a second one.

---

## Claude Code Kickoff Prompt

> Read `CLAUDE.md` and `docs/10-phase-1a-build-plan.md`. Phase 0 is complete, and P1b-T1/T0/T2 are already built. We're on **Phase 1a** — the AI layer and Action Digest, built entirely on the existing MockConnector. Restate the Phase 1a Definition of Done and confirm you will not start the remaining Phase 1b tasks (T3–T6). Then begin at **P1a-T1** and proceed in order, stopping after each task for my review. Keep the locked stack; ask before adding any dependency not named in the plan.
