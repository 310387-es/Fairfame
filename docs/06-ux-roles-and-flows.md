# Product UX, Roles & User Flows — Review SaaS

*Working name: **Revira** (provisional) · v1 · August 2026 · Companion to the PRD & Architecture*

> This document answers "how does a person actually use the app?" — the account model, team access, location management, navigation, and step\-by\-step user journeys. Paired with the visual flow diagrams.

Table of Contents

* * *

## 1\. Your Questions, Answered Directly

- **Are reviews location\-based?** **Yes.** The whole product is organized around **Locations**. Every review, social mention, insight, request, and digest belongs to a Location. A single\-shop business has one Location; a chain or franchise has many.
- **Do we support team access?** **Yes.** An Organization has multiple **team members with roles** (Owner, Admin, Member, Client), and access can be **scoped to specific locations**. Agencies use the Client role to give their customers limited views.
- **How are locations managed?** From a **Locations** area: add a location, map it to its source accounts (Google/Instagram/WhatsApp), assign team members, and set per\-location preferences (brand voice, notifications, digest schedule). Locations can be grouped for chains/regions.
- **How does a user use the app day to day?** Two rhythms: a **daily loop** (new review/mention → notification → Inbox → AI\-drafted reply → approve/post) and a **weekly loop** (Action Digest → do the 3 recommended actions → next digest closes the loop). Full journeys in §5.

* * *

## 2\. The Account Model *(the mental model of the whole app)*

```
Organization  (the account / company)
 ├── Team members  → each has a Role + a Location scope
 └── Locations  (1 for a single shop, many for a chain/franchise)
      └── Connections  (Google · Instagram · WhatsApp · first-party · …)
           └── Reviews & social mentions  → AI insights → Weekly Action Digest
```

- **Organization** \= the paying account. Holds billing, team, global settings, and brand defaults.
- **Location** \= a managed business unit (a branch, a store, a hotel). The unit of pricing, permissions, reporting, and every review.
- **Connection** \= one linked source on one location.
- **Reviews/mentions** roll **up** from Location → Organization for cross\-location reporting.

This model scales cleanly from a one\-person café (1 org, 1 location, 1 user) to a 50\-branch chain (1 org, 50 locations, role\-scoped team) to an agency (1 agency org managing many client orgs).

* * *

## 3\. Team Access & Roles

Roles are set per Organization; each member's visibility can be limited to specific locations.

| Role | Sees | Can do | Location scope |
| --- | --- | --- | --- |
| **Owner** | Everything | Full control incl. billing, delete org | All locations |
| **Admin** | Everything | Manage sources, team, settings, reply | All or assigned |
| **Member** | Assigned locations | View, reply (with/without approval), tag, assign | Assigned only |
| **Client** *(agency use)* | Their own locations only | View reports, limited reply | Their locations only |

Supporting rules:

- **Reply approval:** Members can be set to "draft\-only" (their replies queue for Admin approval) or "can post" — configurable per org.
- **Assignment:** any review can be assigned to a member, with status (open / in progress / done) and an SLA timer.
- **Audit:** every sensitive action is logged (who replied, who changed a source).

* * *

## 4\. Location Management

- **Add / edit locations** with name, address, category, and language.
- **Map sources:** connect each location to its Google/Instagram/WhatsApp/first\-party accounts (the connect flow shows capability \+ approval status honestly).
- **Assign team** members and set per\-location reply\-approval rules.
- **Per\-location settings:** brand voice for AI replies, notification preferences, digest schedule/recipients, request templates.
- **Location groups** (chains/regions): roll up reporting and apply settings in bulk. *(Phase 2\+ for large multi\-location; single/multi works from MVP.)*
- **Global Location Switcher:** a persistent control in the top bar to switch the active location, plus an "All locations" rollup view.

* * *

## 5\. Information Architecture (App Navigation)

Primary navigation (left rail), with the **Location Switcher** always in the top bar:

1. **Home / Digest** — the Action Digest and reputation pulse; the default landing screen (this is the habit surface).
2. **Inbox** — all reviews \+ social mentions in one stream; filter by source/sentiment/status; reply here.
3. **Requests** — create and track review\-request campaigns (email/SMS/WhatsApp/QR).
4. **Insights** — trends, themes, sentiment over time, staff/location performance, competitor watch.
5. **Widgets** *(Phase 3)* — display/showcase configuration.
6. **Locations** — manage locations, sources, and groups.
7. **Team** — members, roles, assignments.
8. **Settings** — brand voice, billing, notifications, compliance (KVKK/İYS), API keys.

**Design opinion:** the **Digest is Home**, not a dashboard of charts — the first thing a user sees is "here's what happened and what to do." The Inbox is the second home for daily triage. Everything else supports those two.

* * *

## 6\. Core User Journeys

### 6\.1 First run (owner\-operator)

Sign up → create Organization → add first Location → connect Google (\+ Instagram/WhatsApp) → existing reviews auto\-import → land in Inbox with a guided "reply to your first review with AI" nudge → set brand voice → done. **Target: under 10 minutes to first value.**

### 6\.2 Daily loop (triage & respond)

New review/mention arrives → push/email notification (negative flagged urgent) → open Inbox → read AI sentiment \+ themes → use AI\-drafted reply → edit → approve/post → tag or assign if needed.

### 6\.3 Weekly loop (the hero)

Action Digest arrives (in\-app \+ email \+ WhatsApp) → read the reputation pulse \+ what changed → see the **3 recommended actions** with evidence → use attached assets (draft replies, a social post from the best review) → act → next week's digest reports whether it worked.

### 6\.4 Collection (get more reviews)

Create a request campaign → pick channel (WhatsApp/email/SMS) and template → **consent/İYS check runs automatically** → send or generate a QR/short\-link → track sent → opened → review left. *(No rating\-gating option exists.)*

### 6\.5 Multi\-location manager

Switch to "All locations" → compare ratings/sentiment across branches → drill into a weak branch → assign follow\-ups to that branch's member → export a leadership report.

### 6\.6 Agency

Agency org → add client → set up their locations \+ sources → invite the client as a **Client role** (sees only their data, white\-labeled) → agency manages replies/digests across all clients from one seat.

* * *

## 7\. Screen Inventory (MVP → later)

**MVP:** Auth/Signup · Onboarding wizard · Location & source connect · Inbox · Review detail \+ AI reply · Home/Digest · Requests (create/track) · Locations · Team · Settings (brand voice, notifications, compliance, billing).
**Phase 2\+:** Unified multi\-source inbox filters · Assignment/SLA workflow · Insights/benchmarking · Widgets · Location groups · Agency/white\-label console.

* * *

## 8\. Decided vs. Still Open

**Decided (recommended):** Location as the core unit; reviews location\-based; RBAC with location scoping; Digest\-as\-Home; Inbox\-centric daily use; owner\-authorized source connection as a first\-class connector path.

**Open — worth your call:**

- Is **agency/white\-label** in scope early, or strictly Phase 4? (Affects the roles model we build first.)
- Do we need **location groups** at MVP, or is flat multi\-location enough to start?
- Default landing screen: **Digest** (my rec) vs **Inbox** — we can A/B later.
- Do Members default to **draft\-only** (safer) or **can\-post** out of the box?

*Companion documents: Master Plan, PRD, Technical Architecture, Türkiye Market Analysis, Business & GTM. See also the visual User\-Flow Diagrams.*
