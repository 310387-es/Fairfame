# Post-Test Fix Plan — Cafe-Owner (Mehmet) run

*Revira · source: live cafe-owner usability test (Mehmet Yılmaz persona, 73 items, every screen + 390px) · merged with the founder audit + remediation plan, deduped, sequenced for Claude Code.*

> **Verdict:** the product is close and the wedge lands — the tester would **pay ₺700–900/mo for the digest + AI replies alone**, and judged the UI genuinely professional (the design pass worked). Two things gate trial→paid and ₺700→₺1,500: **the digest must never break**, and **WhatsApp must actually work**. The sleeper risk is **number trust** — four different "waiting" counts make him doubt every metric.
>
> **Protect at all costs — do not regress these:** the **digest prose**, the **AI reply drafting**, and the **QR poster**. The tester said these three are why he'd buy, and all three are above category standard.
>
> **What this re-test proved about "done" work:** W1.2 (single "answered" definition) is **not** actually closed — 4 counts still disagree. And W1.6 (digest refuse-when-thin) **introduced** a P0 by overwriting a published digest on failed regen. Re-testing on the running product caught both. Treat "done" as "verified in-product," not "committed."

---

## Wave A — Stop the bleeding *(P0 — will lose the account in week one)*

**A1 — "Bu haftayı hazırla" destroys the weekly plan.** `src/digest/pipeline.ts:645/:713` — regeneration writes `status='failed'` onto the existing ready row and the page renders nothing for a failed digest (payload survives intact, ~5.4KB, 3 actions — the user just can't see it). *Fix:* never downgrade a ready digest — generate into a **shadow row, swap on success**; on failure keep serving the last good payload with a non-blocking "couldn't refresh, retrying" note. The button says "this week" but regenerates the old period — target the current window and **disable it (with a reason) when the window has < MIN_ANALYSED_REVIEWS.** *This is the #1 churn bug.*

**A2 — No path sends a review request over WhatsApp/SMS, and one path silently lies.** `campaigns.channel` accepts `email|sms|whatsapp|link` (`schema.ts:133`) but the form offers only two (`campaign-form.tsx:113-116`); `listReviewCampaigns` hard-filters `channel='email'` (`surveys/store.ts:365`); the `sendMessage` branch (`collect/requests.ts:376`) is unreachable. Broadcasts→WhatsApp gates recipients on WhatsApp consent then **emails whoever passes** because the channel is re-derived at `requests.ts:130`. *Fix:* add whatsapp/sms to the form gated on channel status; drop the `email` filter; make `prepareRequests` take the channel **explicitly** so broadcast channel can't diverge; add a test asserting `review_requests.channel === broadcast.channel`. *This is the wedge — "not a feature, the product here."*

**A3 — "Waiting for a reply" has four incompatible definitions (one impossible).** `insight.waiting` = unanswered ∧ unhappy (`insight.ts:113`); `insight.themeNegatives` = all negatives on the theme (`insight.ts:122`) → "7 of 6" reachable and observed. Response card counts every unanswered (`metrics.ts:471`); Inbox uses `replies.id IS NULL` (`answered.ts:71`); Analytics excludes replied-only. *Fix:* **one `needsReply` definition in `reviews/answered.ts`, used everywhere** (finishes W1.2 properly). If the banner stays narrow, say so in copy ("6 olumsuz yorum yanıt bekliyor") and derive it as a subset. Test: `M ≤ N`.

**A4 — A saved draft drops a review from the reply queue.** `facts.ts:141` treats a draft as unanswered; `attention.ts:148` + `queries.ts:469` treat it as answered (observed: drafting dropped 47→46). *Fix:* a draft is **not** answered — one rule, and give drafts an explicit state in the queue.

---

## Wave B — First five minutes feel broken *(P1)*

**B1 — /welcome progress bar sits at "0/0" while sync works** (`onboarding/first-briefing.ts`). Show an indeterminate state until the denominator is known; "Google'dan yorumlar alınıyor…"; auto-advance when reviews arrive (don't require "Panoya geç").

**B2 — "Connect Google" completes with no Google interaction.** Correct in mock, but nothing says so. Give it a distinct **"Örnek verilerle bağla"** affordance, visually separate from real OAuth, matching the sample-workspace wording.

**B3 — Silent actions (the `useAction` contract isn't honored on 4 surfaces).** Empty campaign name → nothing (`campaign-form.tsx`); tone/length → sets state, no regenerate (`replies/style.ts` consumers); `sendRequestsAction` merges skips into one reasonless integer (`send-request.tsx:91-96`) and `server/campaigns.ts:156-163` discards `SendOutcome.failures`. *Fix:* inline Zod errors; regenerate on tone/length select (or label the button "Uygula"); **render per-recipient reasons** ("Telefonu var, e-postası yok", "İYS izni yok") instead of a count. Test all four.

**B4 — /channels: "Taklit" (counterfeit) is the wrong word, and "Bağla" promises what it can't do.** Rename to **"Örnek mod / Deneme modu"**; disable "Bağla" when İYS + Canlı are both unmet, or relabel "Örnek modda dene" and show what's still missing. Fix the untranslated `goLiveNote` fallback.

**B5 — Approve ≠ send, and an answered review stays "Açık".** Three presses (Onayla → Yanıtı gönder), no confirmation it reached the platform. *Fix:* one primary **"Yanıtı gönder"** for owner/admin (keep two-step only for non-admin draft-for-approval); on success show "Google'a gönderildi" + link; auto-transition status to resolved.

---

## Wave C — Trust & polish *(P2)*

**C1 — DMs & IG comments counted as reviews everywhere.** `loadFacts` never filters `itemType` (`facts.ts:126,188`) → 3 DMs + 5 IG items inside "73 yorum", inside waiting counts, inside the response-rate denominator — and a private lost-umbrella WhatsApp message became a weekly-plan theme. *Fix:* exclude `dm` from review metrics + digest theme clustering; route DMs to /conversations; decide + label whether comment/mention belong in rating-free volume.

**C2 — No way to add a single contact by hand** (`/contacts` = CSV only). Add "Kişi ekle" (name + email and/or phone) with the same no-consent-granted copy; auto-create a contact when a WhatsApp DM arrives from an unknown number.

**C3 — No language switcher on sign-up/sign-in** (`i18n/resolve.ts` precedence leaves an EN-browser İstanbul user stuck in English until after onboarding). Put the TR/EN toggle on the auth layout; weight country/timezone above Accept-Language for the pre-session default.

**C4 — Turkish copy defects.** "Önce Kişiler'de bir segment kaydettin" → "…kaydedin"; "Email ile…" → "E-posta ile…"; "Site bileşenleri" → "Web sitesi widget'ları"/"Sitedeki yorumlar"; reconsider "organizasyon" → "İşletme", and on /get-reviews "kampanya" → "yorum talebi" (label only; table name can stay).

**C5 — Analytics: %-on-tiny-base + fake-data card in a trial.** "+600%" from 1→7 → suppress % below a minimum base, show "1 → 7". Hide "Rakiplere karşı" entirely when `!source.isReal` instead of showing invented numbers with a disclaimer.

**C6 — Mobile.** Collapse the /reviews filter block behind a "Filtrele" button (it eats the first viewport; "Yanıt bekliyor" prints twice); add scroll affordance on /analytics + /get-reviews tables (they cut mid-word); move "Bu haftayı hazırla" out of thumb reach on /weekly-plan.

**C7 — Sample data doesn't match category.** Picking "Kafe" still yields tavuk/çorba/vale. Vary the mock corpus by `locations.category` (the theme taxonomy already varies by vertical).

---

## Sequencing

**Wave A this week** (all four are churn-grade; A1 + A2 are the two that gate paying). **Wave B next** (first-run credibility). **Wave C** folds into the design/polish track. After Wave A + B, re-run the cafe-owner test once more as a regression check — then it's genuinely demo-ready for real customers.

## Claude Code Kickoff Prompt

> Read `CLAUDE.md` and `docs/22-post-test-fix-plan.md`. These are prioritized fixes from a live cafe-owner usability test — several are regressions or incompletions of earlier "done" work, with exact file pointers. Work **Wave A in order (A1–A4)**, pausing after each for review; A1 (digest destroyed on regen) and A2 (WhatsApp/SMS requests) are the two that gate a paying customer. **Do not regress the digest prose, AI reply drafting, or QR poster.** Reproduce each bug before fixing it, add the test named in each item, and build missing queries rather than stubbing. Report anything that no longer matches the code.
