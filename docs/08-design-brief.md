# Design Brief — Revira

*Working name: **Revira** (provisional) · v1 · August 2026 · Hand this to the design session*

> A self\-contained brief so a design session starts warm, not blank. It captures the brand, principles, screens, components, and flows to design for the MVP. Detail behind each item lives in the PRD and UX & Flows docs.

Table of Contents

* * *

## 1\. What We're Designing

**Product:** Revira — a platform where any business connects its review and social sources, then gets new\-review notifications, AI analysis, and a weekly **Action Digest** that tells them what to do. Launch market Türkiye; bilingual (TR/EN); global\-ready.

**Primary users:** non\-technical **owner\-operators** and **marketing managers** of local/multi\-location businesses. They are busy, phone\-heavy, and not analysts. The design must make value obvious in the first session.

**MVP surface to design:** onboarding \+ source connect, the Inbox, review detail \+ AI reply, the Digest (Home), review requests, locations, team, settings.

* * *

## 2\. Brand Foundation

- **Name:** Revira (provisional). Logo direction chosen: **monogram** ("R" tile with a live\-notification dot — favicon/app\-icon ready).
- **Palette:** Indigo `#3D5AF1` (primary/trust) · Amber `#F5A524` (accent / rating / energy) · Ink `#10193A` (text) · light neutral backgrounds. Flat, confident, **not** gradient\-heavy.
- **Typography:** geometric/clean sans (e.g. Inter or Poppins) — legible, modern, works in Turkish and English.
- **Personality:** trustworthy, clear, calm, AI\-native, professional. The deliberate opposite of the sleazy "buy reviews" grey market and the cluttered legacy tools. Confidence through clarity, not decoration.

* * *

## 3\. Design Principles

1. **Digest is Home.** The default screen answers "what happened and what should I do," not a wall of charts.
2. **Inbox\-centric.** Daily life is triaging and replying; the review \+ reply experience must be excellent.
3. **Mobile\-first.** Owners act from their phones between customers. Design mobile and desktop; push notifications matter.
4. **Honest capability labels.** Each source is tagged *Live sync / Monitor only / Display only* — clarity over hype.
5. **Compliant by design.** Consent (KVKK/İYS) surfaces cleanly in request flows; no rating\-gating UI exists.
6. **AI assists, human decides.** Draft replies and insights are one edit/approve away — never silently automatic.
7. **Bilingual.** TR and EN as equals; design for longer Turkish strings.

* * *

## 4\. Information Architecture

Left\-rail navigation with a persistent **Location Switcher** in the top bar:
**Home / Digest · Inbox · Requests · Insights · Widgets (later) · Locations · Team · Settings.**
Default landing \= Digest. "All locations" rollup available in the switcher.

* * *

## 5\. Screens to Design (MVP, prioritized)

1. **Onboarding wizard** — signup → create org → add location → connect sources → first\-value nudge.
2. **Source connect** — cards per source with capability badge \+ status (incl. "pending approval" state).
3. **Home / Digest** — reputation pulse, what changed, themes, and the **3 recommended actions** \+ attached assets.
4. **Inbox** — unified reviews \+ social mentions; filters (source/sentiment/status); list \+ detail.
5. **Review detail \+ AI reply composer** — sentiment/themes, AI draft, edit, approve/post.
6. **Requests** — create campaign (channel/template), consent/İYS check, QR/link, tracking.
7. **Locations** — add/map/assign/settings; single and multi\-location.
8. **Team** — members, roles, assignment.
9. **Settings** — brand voice, notifications, compliance, billing/plan.

* * *

## 6\. Core Components / Design System

Review card · digest card \+ "action" item · AI reply composer (with tone control) · source\-connect card w/ capability badge · reputation\-pulse / score tile · sentiment \+ theme tags · notification item · empty states · **entitlement\-locked state \+ upgrade prompt** · location switcher · role/permission chips · request\-campaign builder · toast/alerts.

* * *

## 7\. Key Flows to Show End\-to\-End

- **First run:** signup → connect → first AI reply (target \< 10 min).
- **Daily triage:** notification → inbox → AI reply → post.
- **Weekly digest:** digest → 3 actions → act (the hero moment — make it feel great).
- **Collection:** create request → consent check → send → track.

* * *

## 8\. States Not to Forget

Empty (no sources yet / no reviews yet) · loading / syncing / backfilling · error (connection failed, sync issue) · **pending platform approval** (source connected but awaiting Google/Meta) · permission\-locked (feature above current plan → upgrade prompt) · negative\-review urgent flag.

* * *

## 9\. Localization & Accessibility

Full TR/EN parity; design for \~30% longer Turkish strings; locale\-correct dates/numbers/currency. Target **WCAG 2.1 AA** (contrast, focus states, touch targets) for both the app and the public widgets.

* * *

## 10\. Inspiration & Positioning

Aim for the clarity of modern, well\-designed SaaS (think Linear/Stripe\-level restraint) — generous whitespace, one accent, strong hierarchy. Explicitly avoid the dense, dated, feature\-cluttered look of legacy reputation tools. The design itself should signal "legitimate and premium."

* * *

## 11\. Deliverables to Ask Design For

A lightweight **design system** (color, type, core components) · **key MVP screens** in desktop \+ mobile · the four flows above · empty/error/locked states · and the finalized **logo** built from the monogram direction (production files).

*Companion documents: Master Plan, PRD, Technical Architecture, UX & Flows, Business & GTM, Ideas & Parking Lot.*
