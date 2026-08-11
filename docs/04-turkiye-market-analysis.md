# Türkiye Market Analysis — Review SaaS

*Working name: **Fairfame** (provisional) · v1 · August 2026 · Launch\-market study*

> Türkiye is our launch market; the brand is built global. This document maps the platforms that matter here, the local and international competition, buyer behavior, the compliance landscape (KVKK / İYS), pricing norms, and our entry strategy. It is deliberately honest about where "manage all reviews" is limited by platform access.

Table of Contents

* * *

## 1\. Why Türkiye First

Starting in Türkiye is a sound wedge: it's a large, digitally active market where **Google Maps reviews strongly influence local purchase decisions**, where SMBs are underserved by localized software, and where we have language/market advantage over international incumbents that haven't localized. It lets us validate the product with real customers before taking the global\-ready brand outward.

The trade\-offs to hold honestly: currency volatility (TRY) pressures pricing and unit economics, willingness\-to\-pay for SaaS among small businesses is lower than in the US/EU, and there is a **grey market of "buy reviews" services** we must visibly reject.

* * *

## 2\. Review Platforms That Matter in Türkiye

| Platform | Role in TR | Access reality for us |
| --- | --- | --- |
| **Google Maps / Business Profile** | Dominant for local businesses; primary driver of foot traffic and trust | **Full read \+ reply via official API (approval\-gated).** Our anchor source. |
| **Yandex Maps / Business** | Meaningful secondary map/review platform in TR | Managed via Yandex Business dashboard; **limited/no official reply API** → monitor \+ deep\-link. |
| **Şikayetvar** | Huge Turkish complaint/resolution platform; brand\-reputation battleground | Closed platform with its own brand tools; **monitor/awareness only**, not open API management. |
| **Trustpilot** | Used by larger/e\-commerce brands | Business API available; integrate as a source. |
| **Sector sites** (Booking, TripAdvisor, Hotels.com for hospitality; Trendyol/Hepsiburada for e\-comm; sahibinden, etc.) | Vertical\-specific reputation | Mostly partner\-gated or closed; hospitality is where local tools concentrate. |
| **Sosyal (Instagram/Facebook)** | Comments/DMs act as informal reviews | Limited API; partial. |
| **First\-party** (our collection) | The reviews we generate/own | **Fully ours** — the foundation of the wedge. |

**Implication:** in Türkiye specifically, our strong, honest core is **Google \+ first\-party \+ Trustpilot \+ (monitor) Yandex/Şikayetvar**. We market coverage truthfully with capability labels.

* * *

## 3\. Competitive Landscape

### 3\.1 Local (Turkish) tools

The Turkish market has real local players, but they cluster in **hospitality** and lean on templates:

| Tool | Focus | Strength | Gap we exploit |
| --- | --- | --- | --- |
| **VoyageRespond** | Hotels/restaurants; AI responses (multi\-tone), sentiment, Turkish NLP | Modern, localized, AI\-forward | Vertical\-narrow (hospitality); we go cross\-vertical \+ developer\-grade |
| **Jetyorum** | Restaurants/retail/service; templates, NPS, surveys | Established, NPS focus | Template\-based, lighter AI/insight depth |
| **Esinix** | Hotels/resorts; monitoring \+ PMS integration | Deep hospitality/PMS fit | Niche; not for general SMB |
| **Elektraweb** | Hotel PMS with built\-in review tooling | Embedded in PMS | Reviews are a side\-feature, not the product |

### 3\.2 International tools present but not localized

Birdeye, Podium, Yotpo, ReviewPro, TrustYou, MARA — available but **English\-first, priced in USD, and not tuned to Turkish platforms/compliance**. They don't seriously localize for TR SMBs.

### 3\.3 The grey market

A cluster of "**yorum satın al**" (buy Google reviews) services exists. These violate Google policy and erode trust. We treat this as a **positioning gift**\: we are the compliant, legitimate opposite — "real reviews, honestly earned and managed."

**The opening:** no one owns *cross\-vertical, AI\-native, compliance\-first, developer/agency\-friendly, properly localized* review management for Turkish SMBs. Local tools are hospitality\-bound; international tools aren't localized; grey\-market tools are liabilities.

* * *

## 4\. Buyer Behavior & Segments

- **Local SMBs** (clinics, salons, cafés, auto, retail): care most about Google rating and volume; price\-sensitive; buy on clear ROI and ease; often WhatsApp\-native.
- **Hospitality** (hotels/restaurants): already served by local tools; multi\-platform (Booking/TripAdvisor); higher willingness\-to\-pay; competitive to enter but proven demand.
- **Multi\-location & chains:** want per\-location dashboards and reporting; higher ACV; stickier.
- **Agencies:** manage many SMB clients; a channel more than a segment — white\-label unlocks them.
- **E\-commerce:** product reviews \+ widgets; Trendyol/Hepsiburada ecosystems; a later vertical.

**Channel note:** WhatsApp is dominant in Türkiye for business\-customer communication — strongly relevant to notifications and review requests (Phase 2/4), and a differentiator vs. SMS\-only tools.

* * *

## 5\. Compliance Landscape *(decisive, not optional)*

- **İYS (İleti Yönetim Sistemi):** every commercial SMS/email — **including review\-request messages** — requires prior consent registered in İYS, a KVKK notice presented alongside, consent uploaded within 3 business days, opt\-out honored, and proof retained. Non\-compliance carries administrative fines and can suspend marketing activity. → Our Collect feature must integrate an İYS\-connected gateway and block non\-consented sends. This is engineered, not advised (see Architecture §8).
- **KVKK (Law 6698):** Türkiye's GDPR\-equivalent. Reviews are personal data → consent, data\-subject rights (export/delete), DPA, and data\-residency considerations. Being demonstrably KVKK/İYS\-safe is a **sales advantage** with cautious Turkish businesses.
- **Platform ToS:** use official APIs; never scrape where prohibited; reject review\-buying outright.

Turning compliance into a feature ("İYS\-uyumlu talep gönderimi" / İYS\-compliant requesting, KVKK\-safe by design) differentiates us from both the grey market and less careful tools.

* * *

## 6\. Pricing Norms in Türkiye

- Turkish SMBs expect **TRY pricing and local invoicing** (e\-fatura), and local card/payment support (iyzico/local PSPs), not just USD Stripe.
- Absolute price points are lower than US/EU; **TRY inflation** means we should anchor internally to a hard\-currency value and adjust TRY periodically, or price in a stable unit with local display.
- Free\-trial\-led selling fits; a crippled free tier is less effective than a full time\-boxed trial (also caps our SMS/AI cost).
- SMS has real per\-message cost here → meter it; lean on WhatsApp/email where cheaper and preferred.

*(Concrete tiers and unit economics are in the Business & GTM document.)*

* * *

## 7\. SWOT (Türkiye entry)

|  |  |
| --- | --- |
| **Strengths** | Localization \+ Turkish NLP; AI\-native; compliance\-first; cross\-vertical; developer/agency\-ready; founder is a senior engineer with full focus |
| **Weaknesses** | Solo/small team; new brand/trust; TRY economics; no existing distribution |
| **Opportunities** | Underserved cross\-vertical SMBs; WhatsApp\-native workflows; compliance as differentiation; agency channel; grey\-market backlash toward legitimacy |
| **Threats** | Local incumbents expanding beyond hospitality; international players localizing; Google/Yandex API/policy changes; price sensitivity; macro/currency risk |

* * *

## 8\. Entry Strategy

1. **Anchor on Google \+ first\-party** (fully accessible) so the product is honestly strong on day one.
2. **Beachhead:** general local SMBs where Google rating is life\-or\-death (clinics/dental, auto, beauty, local services) — *avoid* leading head\-first into hospitality where local tools are entrenched; enter hospitality later with a superior cross\-platform \+ AI story.
3. **Lead with compliance \+ AI**\: "get more real reviews, İYS/KVKK\-safe, with AI that tells you what customers actually think."
4. **WhatsApp\-first communication** as a wedge feature vs. SMS\-centric tools.
5. **Validate with the first 10 customers** which second source (Yandex vs. sector sites) to prioritize.
6. **Build global\-ready** (EN \+ multi\-currency) so expansion needs no rewrite.

* * *

## 9\. Key Risks & Mitigations (TR\-specific)

| Risk | Mitigation |
| --- | --- |
| İYS/KVKK misstep | Engineer compliance in; legal review of consent flows before launch |
| TRY volatility erodes margin | Anchor to hard currency; meter SMS/AI; periodic TRY repricing |
| Low SMB willingness\-to\-pay | Clear ROI framing; low\-friction entry tier; annual discounts |
| Grey\-market association | Explicit "no fake reviews" stance; compliance as brand |
| Local incumbent response | Move fast on cross\-vertical \+ AI depth they lack |

* * *

*Sources include current TR market and compliance research (Aug 2026): local tool comparisons, İYS 2026 guidance, and platform access documentation. Companion documents: Master Plan, PRD, Technical Architecture, Business & GTM.*
