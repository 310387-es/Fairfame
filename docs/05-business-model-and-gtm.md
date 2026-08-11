# Business Model & Go\-to\-Market — Review SaaS

*Working name: **Fairfame** (provisional) · v1 · August 2026 · Companion to the Master Plan*

> How we make money, what it costs us, and how we get customers. Numbers here are **planning assumptions to validate**, not promises — every figure is a hypothesis we test with the first cohort. Includes the brand & naming shortlist.

Table of Contents

* * *

## 1\. Business Model

**Type:** B2B SaaS subscription. **Billing unit:** per **location** (the natural unit in this category), with seats included and **metered add\-ons** for real\-cost items (SMS/WhatsApp sends, high\-volume AI). Monthly and discounted annual. **The catalog is denominated in USD only (decided 11 Aug 2026):** the payment provider converts at charge time — Stripe presents local currency where it can, and iyzico charges the TRY equivalent (with e\-fatura) when that adapter goes live. There is no separate TRY price list to maintain against inflation; repricing is one ladder, not two.

**Why per\-location:** it aligns price with value (a 5\-location brand gets \~5× the value and pays accordingly) and scales naturally into multi\-location and agency tiers. Concretely: each plan's base price **includes N locations**, and additional locations are **priced add\-ons** rather than hard caps forcing a tier jump.

* * *

## 2\. Pricing Tiers (initial hypothesis)

Positioned to undercut opaque, sales\-gated incumbents with transparent public pricing — including the extra\-location price, which is published, not discovered at checkout.

**Decided 11 Aug 2026 (superseding the same day's two\-ladder note): one USD ladder, and it is the whole catalog.** The anchors stay **$29 / $89 / $229** — an Aug 2026 market scan places Starter level with Reviewshake/Cloutly entry pricing, Growth under NiceJob Pro ($125) with far more product, and Pro inside the empty gap between the self\-serve band (≤$125) and the demo\-gated band (Birdeye \~$299+/location) — but the TRY ladder is **retired**: the catalog is USD\-only and the provider converts at charge time (§1). The structure around the anchors changed too: **annual billing at two months free** ($290 / $890 / $2,290 per year), **base \+ per\-extra\-location pricing** instead of hard location caps, seats loosened to the category norm (unlimited from Pro), and per\-location quota semantics. Full rationale, competitor benchmarks and the seed SQL live in the *Fairfame Pricing Plans — August 2026* document.

| Tier | Target | USD/mo | Annual | Locations | Includes |
| --- | --- | --- | --- | --- | --- |
| **Starter** | Single\-location SMB | **$29** | $290/yr | 1 (single\-location plan) | Google \+ first\-party, notifications, AI analysis, capped requests \+ AI replies, 1 widget, hosted page, weekly digest |
| **Growth** | Established SMB | **$89** | $890/yr | 1 incl. **\+$49/mo each**, max 5 | \+ social sources, unlimited requests (fair\-use), analytics, scheduled reports, CRM, surveys, messaging, broadcasts, unlimited widgets |
| **Pro** | Multi\-location | **$229** | $2,290/yr | 3 incl. **\+$59/mo each**, max 25 | \+ benchmarking, competitor watch, API \+ webhooks, unlimited seats, priority support |
| **Agency / White\-label** | Agencies | Per deal (anchor: from $299) | Per deal | 10 incl. \+$29/mo each | White\-label, agency console, client roles, reseller margin |

**Add\-ons (metered, per location):** SMS/WhatsApp credits at cost\-plus (WhatsApp quotas deliberately \~2.5× SMS — the cheaper, TR\-preferred channel protects margin); AI usage above the included quota. **Trial:** 14\-day full\-feature trial (no crippled free tier) to bound SMS/AI cost while showing full value. **Marketing copy note:** under base \+ extra, `/` must say **"from $29/mo"** rather than "per location per month".

* * *

### 2\.1 Feature × Plan Matrix

What each tier unlocks (initial packaging — kept as configuration, not code; see Technical Architecture §7.1). "—" \= not included; numbers are indicative and validated with the first cohort.

| Capability | Starter | Growth | Pro | Agency |
| --- | --- | --- | --- | --- |
| Sources: Google \+ first\-party | ✅ | ✅ | ✅ | ✅ |
| Social sources (Instagram / WhatsApp) | — | ✅ | ✅ | ✅ |
| AI analysis (sentiment / themes) | 300/mo | 1,000 /location/mo | 2,500 /location/mo | per deal |
| AI reply drafting | ✅ (within analysis quota) | ✅ | ✅ | ✅ |
| Action Digest (hero) | weekly | weekly \+ on\-demand | weekly \+ on\-demand | weekly \+ on\-demand |
| Review requests / month | 100 (email \+ QR) | unlimited\* | unlimited\* | unlimited\* |
| SMS / WhatsApp included (per location/mo) | 0 / 0 | 100 / 250 | 250 / 500 | 2,500 / 2,500 pooled |
| Locations | 1 | 1 incl. \+$49 ea (max 5) | 3 incl. \+$59 ea (max 25) | 10 incl. \+$29 ea |
| Team members | 3 | 10 | unlimited | unlimited |
| Widgets / showcase \+ hosted page | 1 \+ page | unlimited | unlimited | unlimited |
| Analytics workspace \+ scheduled reports | — | ✅ | ✅ | ✅ |
| CRM · surveys · messaging · broadcasts | — | ✅ | ✅ | ✅ |
| Competitor watch \+ benchmarking | — | — | ✅ | ✅ |
| Public API \+ webhooks | — | — | ✅ | ✅ |
| White\-label \+ Client role \+ agency console | — | — | — | ✅ |
| Support | standard | standard | priority | priority \+ partner |

\*Fair\-use; SMS/WhatsApp sends are metered add\-ons on every tier, and quotas are **per location** so billing and cost scale together. Exact caps are entitlement config we tune without code changes. Scheduled reports moved from Pro to Growth (11 Aug 2026): the weekly rhythm is the retention engine, and Pro's upgrade case rests on benchmarking, competitor watch and the API instead.

## 3\. Unit Economics (the honest math)

Software margins are high, but two lines are **real COGS** and must be metered, not bundled unlimited:

- **Messaging:** every SMS has a hard carrier \+ İYS cost in Türkiye; WhatsApp has per\-conversation fees; email is cheap. → include a fair quota, meter overage at cost\-plus.
- **AI:** each analysis \+ reply draft costs tokens. → batch, cache, and cap per plan; heavy users pay for more.
- **Infra:** low and scalable at our stage (managed Postgres/Redis/hosting).

**Target:** blended **gross margin 75%\+** after messaging/AI. **The lever:** keep included messaging modest and push the cheaper, TR\-preferred channels (WhatsApp/email) so a heavy SMS sender never turns a customer unprofitable.

**Illustrative (to validate):** if blended ARPU lands around the Growth tier and we keep CAC low via product\-led \+ content \+ agency channels, payback in a few months is plausible — but CAC is the biggest unknown and we measure it from customer \#1.

* * *

## 4\. Financial Model — Structure to Track

We won't forecast fiction; we'll instrument these levers from day one:

- **Acquisition:** signups → activated (connected a source) → trial → paid (each conversion rate).
- **Revenue:** paying accounts × ARPU (by tier) \= MRR; expansion from added locations/upgrades.
- **Retention:** logo \+ net revenue retention; source\-stays\-connected as a leading indicator.
- **COGS:** messaging \+ AI \+ infra per account.
- **CAC & payback** per channel.
- **Runway:** founder full\-time; near\-zero burn early → protect it; spend only on validated channels.

A simple spreadsheet with these as inputs beats an elaborate 5\-year forecast at this stage. *(We can build that model next as an .xlsx if you want.)*

* * *

## 5\. Go\-to\-Market

**Motion:** product\-led \+ self\-serve first, founder\-led sales for the first cohort.

1. **Founder\-led (first 10–50 customers):** direct outreach to local SMBs, demos, hand\-holding onboarding. This is how we learn the wedge — not skippable.
2. **Product\-led self\-serve:** sign up → connect Google → see value in one session. Public pricing, no forced demo — a direct contrast to Birdeye/Podium.
3. **Content & SEO (TR \+ EN):** target real queries — "Google yorum nasıl artırılır," "İYS uyumlu yorum toplama," "\[competitor\] alternatifi," "review widget." High\-intent, low\-CAC, compounding.
4. **Integration distribution:** Shopify App Store, WordPress plugin, and later marketplaces — high\-intent channels the incumbents underuse for TR.
5. **Agency channel:** white\-label (Phase 4) turns one agency into many locations; the highest\-leverage channel for scale.
6. **WhatsApp\-native angle:** lean into the channel Turkish businesses already use — a concrete differentiator in demos.

**Positioning line (draft):** *"Get more real reviews, know exactly what customers think, and stay fully KVKK/İYS\-compliant — one platform, powered by AI."*

**Honest CAC note:** we cannot out\-spend incumbents on sales. We win on product, content, compliance\-trust, and channel leverage — and accept that early growth is manual and founder\-driven.

* * *

## 6\. Brand & Naming

**Decided 10 Aug 2026: Fairfame.** One word, capital F, in English and Turkish alike. The identity — logo, colour, type, texture, voice — is [`24-brand-guidelines.md`](./24-brand-guidelines.md); this section records the *commercial* decision and what it is still exposed to.

**Why this name.** The shortlist below was drawn from **product territory** — every entry says *review*, *opinion* or *voice*, which is what the software reads. Fairfame is drawn from **outcome territory**: what the customer is left with. "Fair fame" is a real English phrase, early\-modern through 19th\-century, meaning **good reputation, honourably earned** — and the honourably\-earned half is the product's whole compliance posture said in two words, in a market whose grey edge sells the opposite. It follows the pattern the category's own winners already took: **Podium** and **Birdeye** name a result and a vantage point, not a feature; nobody had to be told what a "review management platform" was to remember them. A name in product territory competes inside a crowded, descriptive, hard\-to\-register space — which is where the shortlist's availability problem came from in the first place.

It also survives Turkish: no `w`, `q`, `x`, no hard `c`, and *fair* already arrives via *fair play*. Suffixation takes an apostrophe — **Fairfame'e, Fairfame'in, Fairfame'de**.

**Adopted at risk.** Two gates are open, and the name is in use internally ahead of both:

1. **Trademark — unscreened.** TÜRKPATENT and EUIPO **classes 9, 35 and 42**, plus a USPTO knock\-out search. Until that clears, nothing customer\-facing ships under it.
2. **Domain — not bought.** `fairfame.com` sits with **HugeDomains** on a fixed\-price reseller listing: a purchase, not a negotiation, so the cost is known and the only risk is delay. `fairfame.com.tr` is unchecked. Buy before any public use.

Accepting that risk is deliberate — the alternative is another month of the product having no name, and the reversible cost is small: the sweep is display copy, and no table, module, env var or test identifier carries the name ([`24`](./24-brand-guidelines.md) §8). If a gate fails, the fallback is the shortlist below, re\-screened.

*Superseded — the shortlist that produced the provisional name **Revira**, kept because it is the argument the decision above departs from:*

**Direction chosen:** global\-English brandable; global brand, Türkiye as first market; must read as a *clear, legitimate* brand (explicitly not the grey "buy reviews" crowd).

**Shortlist** (all require domain \+ TÜRKPATENT/USPTO/EUIPO verification before commit — the reviews space is crowded and many short names are taken):

| Name | Concept | Notes |
| --- | --- | --- |
| **Revira** *(working pick)* | From "review" \+ a clean, ownable ending | Short, brandable, easy in TR & EN; verify trademark/domain |
| **Trustloop** | Trust \+ the feedback loop | Clearest meaning; more descriptive; check availability |
| **Voxa** | From *vox* \= voice (the customer's voice) | Punchy, modern; short\-name domains scarce |
| **Reviora** | Review \+ aura; premium feel | Distinctive, likely more ownable; slightly longer |
| **Reppo** | Reputation, casual and memorable | Friendly; verify clashes |
| **Opinal** | Opinion \+ signal | Meaningful, brandable |

**Recommendation:** **Revira** as primary for its clarity \+ brandability, with **Reviora** as the more\-ownable alternative if trademark/domain checks flag Revira. Names verified as already in use and set aside: Echora, Voxly, Revya, Reevoo/Reevo (existing review company), Reviewly.

**Next branding steps:** (1) run domain \+ trademark checks on the top 2–3; (2) lock the name; (3) I design clean SVG logo concepts; (4) define color/type and voice in a one\-page brand guide. *(Steps 2–4 are done under Fairfame; step 1 is the trademark gate above, still open.)*

* * *

## 7\. Key Business Risks

| Risk | Mitigation |
| --- | --- |
| CAC too high for TR SMB price points | Product\-led \+ content \+ agency leverage; keep burn near zero until channels prove out |
| TRY inflation erodes pricing/margin | Hard\-currency anchor; periodic repricing; meter COGS |
| Low willingness\-to\-pay | Sharp ROI story; low\-friction Starter; annual discount |
| Messaging COGS eats margin | Fair quotas \+ cost\-plus overage; favor WhatsApp/email |
| Name/trademark conflict | Verify before commit; keep alternates ready |
| Single\-founder bandwidth | Ruthless phasing; Claude Code leverage; automate onboarding early |

* * *

## 8\. First 90 Days — Commercial Track (parallel to the build)

1. Apply for Google API access (long lead time — do first).
2. Lock name → domain \+ trademark → logo → one\-page brand guide.
3. Interview 10 target SMBs on how they manage reviews today; refine the wedge and pricing.
4. Stand up landing page \+ waitlist; start TR/EN SEO content.
5. Line up 3–5 design\-partner customers for the MVP.
6. Build the lightweight financial\-lever spreadsheet and start tracking from customer \#1.

*Companion documents: Master Plan, PRD, Technical Architecture, Türkiye Market Analysis.*
