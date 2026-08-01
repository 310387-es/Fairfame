# Review Management SaaS — Master Plan & Build Blueprint

*Founding planning document · v1 · August 2026 · Omer \+ Claude (technical co\-founder)*

> This is our shared source of truth. It is written to be honest, not motivational. Where the market or the technology says "this is hard," it says so. We plan around reality, then build one piece at a time.

Table of Contents

* * *

## 1\. Executive Summary

We are building a **review management platform**\: software that helps any business collect, monitor, respond to, showcase, and learn from its online reviews — in one place. The long\-term vision is to grow from "review management" into a broader **customer\-engagement platform** (messaging, surveys, NPS, light CRM).

The category is large and still growing, but the SMB layer is crowded and the incumbents (Birdeye, Podium, Trustpilot, Yotpo) are well\-funded. We do **not** win by being "another Birdeye." We win by being **AI\-native, developer\-grade, transparently priced, and genuinely pleasant to use** — the things bloated, sales\-heavy incumbents are structurally bad at.

The single most important reality to internalize: **"manage all reviews in one place" is partly blocked by the platforms themselves.** Google is fully accessible (with approval). Yelp, TripAdvisor, Meta, Amazon, G2 are gated, excerpt\-only, or closed. Our product and our marketing must be honest about this, and our architecture must treat each source's access level as a first\-class concern.

Our strategy: **pick a beachhead, win it with a sharp wedge (AI\-native review collection \+ Google done better), then expand outward toward the universal vision.** Full picture below; we build it phase by phase.

* * *

## 2\. Straight Talk — The Honest Co\-Founder Take

Before the plan, five things I'd want a co\-founder to say to me out loud:

1. **The market is real but saturated at the bottom.** Local\-SMB review tools are a red ocean. There are dozens of them, many cheap, many "good enough." Differentiation has to be sharp and defensible, not "we also do reviews."

2. **"Universal" is a vision, not a launch strategy.** A tool that does everything for everyone on day one does nothing well and is impossible to market. Every successful horizontal platform (Slack, HubSpot, Stripe) started narrow. We keep the universal north star, but we launch a wedge.

3. **You cannot actually aggregate "all" reviews — the platforms won't let you.** This is the biggest gap between the pitch and the technical truth. See §4. We must design for it and never over\-promise.

4. **Review "gating" is now illegal\-ish and against platform policy.** The classic growth hack — intercept unhappy customers and route them to a private form while sending happy ones to Google — violates Google's policy and runs into FTC rules on review practices. We design compliant collection from day one. This is both a risk and a *marketing angle* ("compliant by design").

5. **Distribution, not code, is the hard part.** You're a strong engineer building with Claude Code, so we will ship a great product. The real risk is CAC and getting in front of buyers who are already being sold to daily. GTM gets equal planning weight to the build.

Why we can still win: incumbents are expensive (often several hundred dollars/month, gated behind sales demos), slow\-moving, and bolt AI on as an afterthought. An AI\-native, self\-serve, API\-first product with honest pricing and beautiful UX is a real opening in 2026.

* * *

## 3\. Market & Competitive Landscape

The online reputation / review management software category is worth low\-single\-digit **billions** globally and growing double digits annually, driven by the fact that reviews now directly affect local search ranking, ad conversion, and purchase decisions.

**Who we're up against:**

| Competitor | Core focus | Where they're strong | Where they're weak (our opening) |
| --- | --- | --- | --- |
| **Birdeye** | All\-in\-one SMB reputation \+ messaging | Breadth, integrations, brand | Expensive, sales\-gated, heavy UI, AI feels bolted\-on |
| **Podium** | SMB reviews \+ payments \+ messaging | Texting/payments combo, sales machine | Pricey, aggressive sales, SMB\-only feel |
| **Trustpilot** | Consumer review network \+ widgets | Trust brand, SEO, network effect | It's a walled network, not a manager; costly for full features |
| **Yotpo** | E\-commerce reviews \+ loyalty/SMS | Shopify ecosystem depth | E\-comm only, complex, enterprise pricing |
| **Reputation.com** | Enterprise / multi\-location | Enterprise analytics | Heavy, expensive, not for SMB/self\-serve |
| **NiceJob / GatherUp / Grade.us** | SMB & agency review collection | Simpler, agency\-friendly, cheaper | Thinner feature set, dated UX, limited AI |
| **Reviews.io / Judge.me / Loox** | E\-comm review widgets | Cheap, easy, good widgets | Narrow (display/collection), not full management |

**The pattern:** the market splits into *SMB all\-in\-one* (Birdeye/Podium — broad but expensive and heavy), *e\-commerce* (Yotpo/Judge.me — narrow), *review networks* (Trustpilot/Google itself), and *agency/simple tools* (NiceJob/Grade.us — thin). **Nobody owns "AI\-native, developer\-grade, transparent, cross\-vertical."** That's our lane.

* * *

## 4\. The Hard Constraints — Review Source Access (2026)

This table is the most important page in the document. It defines what "manage all your reviews" can *actually* mean.

| Source | Read reviews? | Reply via API? | Method | Reality for us |
| --- | --- | --- | --- | --- |
| **Google Business Profile** | ✅ Full | ✅ Full | Official API (`mybusiness…/v4`) | **Gated:** zero quota by default, formal access request, approval takes days–weeks, vague use cases rejected. This is the crown jewel — apply early. |
| **Yelp** | ⚠️ 3 excerpts only | ⚠️ Separate licensed API | Fusion API (Enhanced/Premium plan) | Essentially **closed** for real management. We can show excerpts \+ deep\-link; not full aggregation. Be honest. |
| **Facebook / Meta** | ⚠️ Limited | ⚠️ Limited | Graph API (Page ratings/recommendations) | Star reviews were replaced by Recommendations years ago; API access is thin and permission\-heavy. Partial at best. |
| **TripAdvisor** | ⚠️ Partner\-only | ❌ | Content API (approval, partner tier) | Restricted to approved partners; hard for a new SaaS. Monitoring only, if at all. |
| **Trustpilot** | ✅ (business acct) | ✅ | Business/Invitations API | Doable, but it's a competing network — integrate as a source, don't depend on it. |
| **G2 / Capterra** | ❌ open API | ❌ | Partner feeds only | No open review API. B2B\-software reviews are largely locked. |
| **App Store / Google Play** | ✅ (your own apps) | ✅ | App Store Connect API / Play Developer API | Strong for **app/SaaS makers** managing their own listings. |
| **Amazon** | ❌ | ❌ | None (scraping violates ToS) | Off the table via compliant means. |
| **Booking / Expedia / Zomato / industry sites** | ⚠️ Partner\-only | Varies | Partner programs | Case\-by\-case; treat as long\-tail. |
| **First\-party reviews** (collected on *our* platform) | ✅ Full | ✅ Full | Our own system | **100% ours.** This is the most reliable, richest data we have — and the foundation of the wedge. |

**Strategic implications:**

- Our defensible core is **Google \+ first\-party collection \+ app stores \+ Trustpilot** — genuinely strong, honestly deliverable.
- "All reviews in one inbox" is marketed truthfully as **"every source we can legally connect, plus first\-party — with clear labels on what's live\-synced vs. monitored vs. display\-only."**
- The compliant path for closed sources is **monitoring/alerting and deep\-linking**, never claiming full two\-way sync we can't deliver.
- **First\-party review collection is the wedge** precisely because it sidesteps every access restriction and generates data no competitor owns.

* * *

## 5\. Positioning & Strategy

**North star (vision):** the review \+ customer\-engagement operating system for any business — collect feedback, manage reputation, and engage customers, all in one place.

**The wedge (launch):** *AI\-native review generation \+ Google, done dramatically better than incumbents, self\-serve and transparently priced.* It works across every vertical (any business wants more Google reviews), sidesteps API limits (first\-party \+ Google are both fully accessible), and has the clearest ROI story ("more and better reviews → higher local ranking and conversion").

**Recommended beachhead:** rather than committing to one vertical prematurely, target **service\-based SMBs and multi\-location brands that live and die by Google reviews** (home services, clinics, dental, auto, hospitality, local retail) — but keep the product vertical\-agnostic so we can follow demand. If early traction concentrates in e\-commerce or app makers, we lean in there. We validate the beachhead with the first 10 paying customers, not by guessing.

**Our four differentiation pillars:**

1. **AI\-native, not AI\-bolted\-on** — sentiment, theme extraction, competitor benchmarking, and on\-brand reply drafting are core workflows, not a "✨ AI" button.
2. **Developer\-grade** — API\-first, embeddable widgets, webhooks, clean docs. Nobody in SMB reviews treats developers/agencies as first\-class. (Plays directly to your strengths.)
3. **Transparent & self\-serve** — public pricing, sign up and start in minutes, no forced demo. A direct jab at Birdeye/Podium's sales\-gate.
4. **Compliant & trustworthy by design** — no shady review gating; FTC\- and Google\-policy\-safe collection as a *feature*.

* * *

## 6\. Product Vision — The Six Pillars

The full product, so we can see the whole picture even though we build it incrementally:

1. **Collect** — Automated review requests (email/SMS/QR/kiosk/link), smart timing, follow\-ups, and compliant routing to the right destination (Google, Trustpilot, or first\-party).
2. **Monitor** — A unified inbox aggregating every connectable source into one normalized stream, with real\-time alerts on new/negative reviews.
3. **Respond** — AI\-drafted, on\-brand replies with human approval; reply directly to Google (and other reply\-capable sources) from our UI; templates, tone controls, SLAs.
4. **Showcase** — Embeddable widgets, badges, and auto\-generated review pages to display reviews on the customer's website for conversion \+ SEO (with schema.org rich snippets).
5. **Analyze** — Sentiment over time, theme/topic extraction, location and staff performance, competitor benchmarking, and exportable reports.
6. **Engage** *(the expansion → customer\-engagement platform)* — Two\-way messaging, NPS/CSAT surveys, contact profiles, campaigns, and light CRM. This is where "review tool" becomes "platform."

* * *

## 7\. Phased Roadmap — What We Build, In Order

Each phase ends in something shippable with a clear "definition of done." We do not start the next phase until the current one is real.

### Phase 0 — Foundations *(the skeleton everything hangs on)*

Multi\-tenant architecture, auth, org/team/roles, billing skeleton (Stripe), the canonical **Review** data model, an integration/OAuth framework, background\-job infrastructure, and observability. No user\-facing features yet — but getting the tenancy and the canonical schema right here saves us from painful rewrites later.
**Done when:** a user can sign up, create an org, add a location, invite a teammate, and we can persist a normalized review from a seed source.

### Phase 1 — MVP: Collect \+ Google *(the wedge)*

Google Business Profile connection (OAuth \+ reply), automated review\-request campaigns (email \+ SMS), compliant request flows with QR/link, AI\-assisted reply drafting, and a basic dashboard. This is the minimum that a real business will pay for.
**Done when:** a paying customer can connect Google, send review requests, get more reviews, and reply to them with AI help — end to end.

### Phase 2 — Monitor \+ Respond *(breadth within legal limits)*

Unified inbox across every connectable source (Google, Trustpilot, app stores, first\-party; monitoring/deep\-link for the closed ones), real\-time alerts, reply SLAs, templates, and team assignment/workflow.
**Done when:** a customer manages all their connectable reviews from one inbox with alerts and team workflow.

### Phase 3 — Showcase \+ Analyze *(value \+ stickiness)*

Embeddable widgets/badges, auto\-generated SEO review pages with schema markup, sentiment/theme analytics, location/staff performance, competitor benchmarking, and scheduled reports.
**Done when:** a customer displays reviews on their site and gets a monthly insights report that changes what they do.

### Phase 4 — Engage \+ Agency/White\-label *(become a platform)*

Two\-way messaging, NPS/CSAT surveys, contact profiles/light CRM, campaigns — plus multi\-location/agency features (white\-label, client roles, bulk management) for higher\-ACV customers.
**Done when:** we're sold not as "a review tool" but as "how we talk to and learn from customers," and an agency can run 20 clients on it.

* * *

## 8\. Technical Architecture

Designed for a senior engineer building with Claude Code: **one language end\-to\-end (TypeScript)**, boring proven infrastructure, and clean seams so each pillar is a module we can build independently.

**Recommended stack (with the "why"):**

- **Frontend:** Next.js (App Router) \+ React \+ TypeScript, Tailwind \+ a component library (shadcn/ui). Server components for the app; a separately bundled, framework\-agnostic **embeddable widget** (vanilla/Preact, tiny, CDN\-served) for customer sites.
- **Backend/API:** Start as a **modular monolith** — Next.js route handlers or a dedicated Node service (NestJS/Fastify) exposing a typed API (tRPC internally, REST \+ webhooks for the public API). Split services out only when a real bottleneck appears. Don't start with microservices.
- **Database:** **PostgreSQL** (Supabase or Neon managed). Prisma or Drizzle as the ORM. Postgres gives us JSONB for messy per\-source review payloads, full\-text search early, and pgvector for embeddings later — one database does a lot before we need anything exotic.
- **Cache/queues:** Redis; background jobs via **BullMQ** or **Inngest** (Inngest is great for scheduled syncs, retries, and rate\-limit\-aware workflows — a strong fit for our integration layer).
- **Auth:** Auth.js (NextAuth), Clerk, or Supabase Auth — org/multi\-tenant aware.
- **Payments:** **Stripe** (subscriptions, metered usage for SMS/AI add\-ons, customer portal).
- **AI:** Provider APIs (Claude/OpenAI) behind our own abstraction: reply drafting, sentiment \+ theme extraction, embeddings for semantic search/clustering, with prompt\-injection and content guardrails since we process user\-generated text.
- **Infra/DevOps:** Vercel (web) \+ managed Postgres/Redis, or a single platform (Fly.io/Railway) if we want everything together. Object storage on S3/Cloudflare R2 for review media. CI/CD via GitHub Actions. Observability with Sentry \+ structured logs \+ a metrics dashboard.

**Multi\-tenancy model:** shared database, shared schema, **`organization_id` on every row**, enforced with Postgres **Row\-Level Security** (natural with Supabase) or a strict repository layer. Simplest to operate; isolate to per\-tenant schemas only if a big enterprise later demands it.

**Core system components (logical modules):**

- **Web app \+ API** — the product surface and public/typed API.
- **Integration layer** — connectors per source, an **OAuth token vault** (encrypted), a **sync scheduler** that respects each platform's rate limits, and a **normalizer** that maps every source's payload into our canonical `Review`. This is the technical heart of the product; design it as a clean, pluggable interface (`Connector` with `fetchReviews()` / `postReply()` / `capabilities`).
- **Ingestion/eventing** — new reviews raise internal events → trigger alerts, sentiment analysis, and webhooks.
- **AI service** — stateless workers for drafting/analysis.
- **Notification service** — email/SMS/push (SMS via Twilio/Telnyx with A2P 10DLC registration handled — see risks).
- **Widget delivery** — CDN\-served embeddable widget with a public, cacheable read API.

**Security & compliance baked in:** reviews contain personal data → **GDPR/CCPA** obligations (data export/deletion, DPA), encryption at rest for tokens/PII, audit logging, per\-source ToS compliance (especially Google's), and strict tenant isolation.

* * *

## 9\. Core Data Model

The entities that make the whole thing coherent. Everything hangs off `Organization` (the tenant) and the canonical `Review`.

| Entity | Purpose | Key fields / relationships |
| --- | --- | --- |
| **Organization** | The tenant / account | plan, billing\_customer\_id, settings |
| **User** | A person | email, auth identity |
| **Membership** | User ↔ Org with a role | org\_id, user\_id, role (owner/admin/member/client) |
| **Location** | A business/place being managed | org\_id, name, address, source\_mappings |
| **Connection** | A linked external source | org\_id, location\_id, provider, OAuth tokens (encrypted), status, capabilities |
| **Review** *(canonical)* | Normalized review from any source | org\_id, location\_id, source, source\_review\_id, author, rating, text, language, created\_at, url, raw\_payload (JSONB) |
| **Reviewer/Contact** | The customer behind a review/request | org\_id, name, email, phone, history |
| **Reply** | A response to a review | review\_id, author\_user\_id, text, ai\_generated, status, posted\_at |
| **ReviewRequest** | An outbound ask for a review | contact\_id, channel, template, status, sent\_at, converted |
| **Campaign** | A collection strategy | schedule, channel, routing rules, template |
| **Widget** | An embeddable display config | org\_id, filters, style, public\_key |
| **Insight/Sentiment** | AI\-derived analysis | review\_id, sentiment, topics\[\], embedding |
| **Tag** | Manual/auto categorization | label, color |
| **WebhookSubscription** | Public API events | org\_id, url, events\[\], secret |
| **Subscription** | Billing state | org\_id, stripe\_ids, tier, usage counters |
| **AuditLog** | Security/compliance trail | actor, action, entity, timestamp |

The design principle: **normalize aggressively into `Review`, but keep `raw_payload` (JSONB)** so we never lose source\-specific data and can re\-normalize as we learn.

* * *

## 10\. Business Model & Pricing

**Model:** SaaS subscription, **priced per location** (the natural unit for this category), with seats included and **metered add\-ons** for the things that cost us money (SMS credits, high\-volume AI). Monthly and discounted annual.

**Draft tiers** (anchor: undercut incumbents' opaque pricing, publish it openly):

| Tier | Who | Rough monthly (per location) | Includes |
| --- | --- | --- | --- |
| **Starter** | Solo/single\-location | low tens of $ | Google connect, review requests (capped), AI replies (capped), 1 widget |
| **Growth** | Growing SMB | mid tens–low hundreds | Multi\-source monitor, unlimited requests, full AI, widgets, analytics |
| **Pro** | Multi\-location | hundreds | Everything \+ benchmarking, API access, priority support, SLAs |
| **Agency / White\-label** | Agencies | custom / per\-seat \+ per\-location | White\-label, client roles, bulk mgmt, reseller pricing |

**Unit\-economics reality (why metering matters):** every SMS has a hard cost (carrier fees \+ A2P), every AI reply/analysis has token cost, and closed\-source workarounds cost engineering time. Software margins are high, but **SMS\-heavy collection is a real COGS line** — we meter it so a heavy sender doesn't erode our margin. Target healthy SaaS gross margins (75%\+), which means AI and SMS are add\-ons above a fair included quota, not unlimited.

**Free trial, not free tier**, to start — a time\-limited full trial converts better than a crippled free plan in this category, and keeps our SMS/AI costs bounded.

* * *

## 11\. Go\-to\-Market

- **Product\-led \+ self\-serve** as the default motion — sign up, connect Google, see value in one session. This is our structural advantage over sales\-gated incumbents.
- **SEO/content** on the exact problems we solve ("how to get more Google reviews," "review widget for \[platform\]," "Birdeye alternative") — reviews businesses are already searching for this.
- **Integration distribution** — list in the **Shopify App Store**, WordPress plugin directory, and relevant marketplaces; these are high\-intent, low\-CAC channels.
- **Agency partnerships** — agencies resell to many SMBs; one agency \= many locations. White\-label (Phase 4) makes this a real channel.
- **Honest CAC note:** incumbents spend heavily on outbound sales; we can't out\-sales them, so we out\-*product* and out\-*content* them, and let self\-serve \+ integrations do the distribution. Getting the first 10–50 customers will still be manual founder\-led selling — plan for it.

* * *

## 12\. Risk Register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **Platform API access denied/changed** (esp. Google) | High | Apply for Google access *now* (long lead time); design connectors as pluggable; never depend on a single source; make first\-party collection the foundation. |
| **Closed sources (Yelp/Meta/TA)** limit the "all reviews" promise | High | Honest labeling (live\-sync vs monitor vs display); lead with sources we genuinely own. |
| **Review\-gating / FTC & Google policy** | High | Compliant collection by design (no rating\-based interception); turn it into a trust selling point. |
| **SMS compliance (A2P 10DLC, TCPA)** | Medium\-High | Register campaigns, consent capture, opt\-out handling, meter usage. |
| **Saturated SMB market / weak differentiation** | High | Sharp wedge \+ AI\-native \+ developer\-grade \+ transparent pricing; don't be "another Birdeye." |
| **High CAC / distribution** | High | Product\-led, SEO, integration marketplaces, agency channel; founder\-led sales early. |
| **GDPR/PII handling** (reviews \= personal data) | Medium | Encryption, deletion/export flows, DPA, tenant isolation from day one. |
| **Solo founder bandwidth** | Medium | Ruthless phasing; ship the wedge before breadth; Claude Code leverage; resist scope creep. |
| **Churn** (SMBs churn hard) | Medium | Embed into daily workflow (inbox \+ widgets on their site \= switching cost); prove ROI with reports. |

* * *

## 13\. Immediate Next Steps

Concrete, in order:

1. **Apply for Google Business Profile API access today.** It has the longest lead time (days–weeks) and gates the whole wedge. Prepare a crisp, specific use\-case description to avoid rejection.
2. **Lock the beachhead hypothesis** and write a one\-line ICP we'll test with the first 10 customers.
3. **Stand up Phase 0**\: repo, Next.js \+ Postgres \+ Prisma/Drizzle scaffold, auth, multi\-tenant `organization_id` \+ RLS, Stripe skeleton, and the canonical `Review` schema \+ `Connector` interface. (This is our first Claude Code build sprint.)
4. **Design the canonical `Review` model and the `Connector` interface** carefully — everything else depends on these two.
5. **Talk to 5–10 target businesses** about how they collect and manage reviews today, before we build Phase 1, to sharpen the wedge.

We build Phase 0 → 1 → 2 → 3 → 4, and we don't skip ahead. When you're ready, we start on Phase 0 and I'll scaffold it with you.

* * *

*Living document — we revise it as reality teaches us things. Honesty over optimism, always.*
