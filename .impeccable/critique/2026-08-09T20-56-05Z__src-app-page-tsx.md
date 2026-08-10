---
target: the landing page
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
timestamp: 2026-08-09T20-56-05Z
slug: src-app-page-tsx
---
Method: dual-agent (A: design review · B: detector + browser evidence, isolated until synthesis)

## Design Health Score — 23 / 40 · Acceptable

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | `aria-pressed` on 12 nodes that cannot be pressed. Focus *does* highlight (measured: 8 dimmed, 3 edges lit) — so the state is real, but the ARIA describes a toggle that does not exist. |
| 2 | Match System / Real World | 3 | Turkish is native and excellent. But an English review sits unexplained in a Turkish café's evidence, and "Yapmadığımız **iki** şey" heads three blocks. |
| 3 | User Control and Freedom | 2 | The signature interaction is hover/focus-only — no pin, so studying a lineage means holding the mouse still. 7,290px desktop with no in-page nav. |
| 4 | Consistency and Standards | 2 | `text-title` (14.5px) headings sit above 17px body — the heading is smaller than its own paragraph. A fourth text surface (`--indigo-050`) was introduced outside the project's own contrast table. |
| 5 | Error Prevention | 2 | Delta-framed pricing sets a buyer up to misread: Agency shows 2 features and reads as *less* product than Pro. |
| 6 | Recognition Rather Than Recall | 1 | Mobile pricing stacks, so judging Growth means remembering Starter's bullets ~900px above. "+4 özellik daha" names four features and offers no way to see them. |
| 7 | Flexibility and Efficiency | 2 | 12 pipeline stops in the tab order that highlight but cannot be activated or pinned. |
| 8 | Aesthetic and Minimalist Design | 2 | The pipeline and the briefing card carry the **same 3 actions, 3 themes and 6 quotes**, 1,100px apart. Plus two shipped placeholders. |
| 9 | Error Recovery | 3 | Small surface, but the digest fallback path is handled and named. |
| 10 | Help and Documentation | 3 | Does real explanatory work; raises "no live platform traffic" and answers nothing about what to do with that. |

Heuristics 7 and 10 were scored rather than marked n/a: this page does real explanatory work and has a genuine keyboard surface, so both apply.

## Design Specificity Verdict

**Split, and the split is structural.** Two organs could not be lifted onto a neighbouring SaaS; most of what sits between them could.

**Authored for this product:** the pipeline (`Bir yorumdan bir işe`) is the Action Digest's mechanism drawn from the same `getSampleDigest()` payload the briefing renders — put it on a CRM landing page and it means nothing. And the conscience band, whose sentences ("arayüzde yok, veritabanında yok, kodda yok") no incumbent can write.

**Category-interchangeable:** between y2359 and y5450 the page runs three consecutive `IconTile + dt + dd` grids at 3 / 4 / 6 columns, distinguished only by column count, plus a screenshot and two placeholder boxes. The source comment defends this as "deliberately different densities" — it is defending the symptom. This is the arrangement the direction contract explicitly refuses; it simply arrives in the second half instead of the first.

**The contract in the shipped markup no longer describes the page.** It promises a briefing cropped by the fold glossed by three stacked margin notes. The marginalia were removed for good reasons; the contract was not updated. The audit now reads against fiction.

**Deterministic scan:** CLI on `.tsx` returned `[]`, exit 0 — **and that is not evidence.** Probed with a deliberately-violating `.tsx` (raw hex, 13px text, gradient button, `#ccc` on white), the CLI also returned `[]`; the same patterns in `.html` returned findings. On non-HTML it routes to a regex engine that is materially less sensitive. URL scanning was unavailable (puppeteer missing). The browser-grade detector was recovered by injecting the bundled browser detector into the live page: **31 findings desktop, 17 mobile.**

**Visual overlays:** none. Playwright is headless with no persistent viewer, so no user-visible overlay exists — the findings came from injecting the detector and reading its return value.

## Overall Impression

The page has two genuinely excellent organs and a soft middle. What works is unusual and hard to copy; what does not work is ordinary and easy to fix. The single biggest opportunity is subtraction: the page says its best thing twice, 1,100px apart, and ships two dashed boxes of internal art direction at the exact moment it is about to make its trust argument.

## What's Working

1. **The pipeline is honest by construction.** It is not an illustration of the mechanism — it is `digest.actions` → `digest.themes` → `theme.quotes` rendered as a graph, with edges measured from the DOM so a longer customer sentence cannot break the drawing. The lineage is one theme key, so highlight and edges read the same field and cannot drift. The claim "every line is traceable" is enforced by the data structure rather than asserted in copy.

2. **The conscience band turns a constraint into the strongest asset on the page.** Most products hide "no live platform traffic yet". This one sets it in 17px on ink and closes with the line that does the work: "Bunu satış sayfasında yazıyoruz, çünkü ürünün içinde de böyle yazıyor." For an audience whose defining experience is being lied to by review sellers, that is the differentiator.

3. **Pricing is derived from `PLAN_CATALOG`,** so the page cannot promise a feature the product refuses. A hand-written table eventually lies; this one is wrong only if the product is wrong.

## Priority Issues

### [P0] Two unfilled placeholders are live, carrying art direction to a photographer
`PlaceholderImage` renders in production by design. A visitor sees two dashed boxes — ~400px desktop, ~900px on a phone — containing *"Tezgâhın arkasında telefonuna bakan bir kafe işletmecisi… sahnelenmiş ofis fotoğrafı değil, gerçek bir işletme olmalı."* They sit immediately before the trust band.

**Why it matters:** the audience is defined as people who have been sold to by fakers. A landing page displaying its own to-do list reads as an abandoned build, at the exact point the page is about to argue for its integrity. The component's own reasoning ("a visible slot beats a stock photo") omits the third and better option.

**Fix:** stop rendering the section. Keep the component; gate it behind `NODE_ENV !== "production"` and move both briefs into the surface brief under Unresolved. If the visual break is needed there, move the product screenshot down into that slot.

**Suggested command:** `/impeccable polish`

### [P1] The numbers on screen contradict each other, on a page whose thesis is countability
The stat row reads **"14 yorum okundu · 6 tema çıkarıldı · 3 iş önerildi"** directly beneath a diagram showing **6 reviews and 3 themes**. Confirmed in source: the row reads `digest.reviewCount` and `digest.themes.length` (the whole week) while the graph renders only the quotes of the three *actioned* themes. Separately, one review — *"Kahvaltı için 40 dakika bekledik…"* — is printed **twice with identical stars**, because it is quoted under both `Bekleme süresi` and `Yemek`.

**Why it matters:** this is the one place a reader can literally count, on a page that says *"Tıklayıp göremediğiniz bir sayı, inanmak zorunda olduğunuz bir sayıdır."* A visitor who counts finds the page cannot.

**Fix:** de-duplicate `flowReviews` by quote text and let one node carry edges to both themes — a review belonging to two themes is a *better* demonstration than a repeat, and the graph already supports multi-edge. Then name the subset in the column eyebrow: `GELEN YORUMLAR · 14'ten 6'sı`.

**Suggested command:** `/impeccable clarify`

### [P1] The page states its centrepiece twice
The pipeline shows three actions, three themes and six quotes. The briefing card 1,100px later shows the same three actions, and its three `<details>` reveal the same six quotes verbatim — including the same duplicate. That redundancy is a large share of the 7,290px / 10,942px length and makes the briefing card read as a recap rather than a payoff.

**Fix:** strip the `<details>` evidence from `Briefing` on this surface. The graph has already delivered the quotes; the card's own heading — "Aynı hafta, tek bir belge olarak" — then becomes literally true, and the section earns its place as *format* rather than repetition. Evidence-in-place stays where it is the point: `/sample`, which is what the primary CTA opens.

**Suggested command:** `/impeccable distill`

### [P1] Mobile loses the signature interaction and keeps the instruction to use it
`flowTitle` / `flowBody` render outside `PipelineFlow`, so at 390px the reader is told *"Aşağıdaki her **ok** gerçek. Bir işin üzerine **gelin**…"* above three static stacked cards with no arrows and no hover. The primary persona is phone-heavy by definition; this is the sentence they get. Measured: 0 graph nodes rendered at 390px, 10,942px of scroll.

**Fix:** move the body copy inside `PipelineFlow` so each layout ships its own sentence. The stacked version already earns a good one — "Her işin altında, onu doğuran müşteri cümleleri duruyor."

**Suggested command:** `/impeccable adapt`

### [P2] The commitment moment has no action, no reassurance, and a contrast failure
Four pricing columns with **zero CTAs**. No trial badge in the table; the only reassurance ("Kart gerekmiyor · 14 gün boyunca her şey açık") sits 240px below at **11px**. "Bu plana eklenenler" is architecturally right and commercially wrong — stacked on mobile it becomes pure recall, and Agency (2 rows) reads as less product than Pro (4 rows). Pro lists both **"Rakip takibi"** and **"Rakip kıyaslama"**, which a Turkish reader takes as one feature said twice, in the tier costing ₺8.999.

Separately, measured by both assessments independently: **`--ink-350` on `--indigo-050` is 4.493:1**, failing AA by 0.007, on four `<dd>` elements in "Plan sizi nerede bulur". The project's own `design-contrast.test.ts` passes because its per-surface table covers white / canvas / segmented — `indigo-050` is a **fourth surface the table does not know about.**

**Fix:** a CTA per column; reword the intro to `Starter'daki her şey +` so the diff reads cumulatively; make "+4 özellik daha" a `<details>`; give `competitors` and `benchmarking` visibly different strings. For contrast: add `--indigo-050` to the table in `docs/15` with `--ink-500`, or use `text-ink-600` in that band — and extend the test so the table cannot silently miss a surface again.

**Suggested command:** `/impeccable clarify` then `/impeccable audit`

## Cognitive Load — 5 of 8 fail (critical)

FAIL: single focus (the pipeline section carries graph + stat card + note), visual hierarchy (`text-title` lands *below* the body size it sits above; nothing between 34px and 17px), one-thing-at-a-time (12 simultaneously interactive nodes), ≤4 options (12 nodes; 6 feature cells; 5 lines in Growth), working memory (delta-only pricing stacked on mobile).

PASS: chunking, grouping, progressive disclosure.

## Persona Red Flags

**Jordan (first-timer)** — counts 6 reviews and 3 themes, reads "14 · 6 · 3" beneath. Sees the same 40-minute-breakfast review twice with identical stars. Reads four pricing columns as independent lists and concludes Agency is weakest. Reads "Rakip takibi" and "Rakip kıyaslama" as the same thing twice. The theme table in "Geçen haftaya göre ne değişti" has **no column header** — "Yemek 2 → 5" could be a score, a rating or a count.

**Riley (stress tester)** — tabs into the pipeline, hears *"toggle button, pressed"*, presses Enter: nothing pins. Hears *"Seçildiğinde ilgili tema ve yorumlar vurgulanır"* **twelve times**. Hovers and finds **6 of 12 cards at 0.45 opacity** — the customer evidence is illegible in the exact state meant to prove it. Counts three blocks under "Yapmadığımız **iki** şey". Zooms the product screenshot and finds a **"Deneme · 14 gün kaldı — Plan seç"** billing nag and two **"SÜRESİ GEÇEN"** overdue badges inside the marketing screenshot.

**Casey (distracted mobile)** — 10,942px of scroll; pricing at 83%, final CTA at 95%. The page's whole argument does not exist at 390px. **"Hesap oluşturun" is 108 × 21px**; the three footer links are 19.5px tall. Two dashed boxes occupy roughly two full phone screens.

**The Turkish café owner, on a phone, between customers** — the demo café's score **falls 74 → 65** and no section shows it recovering. He is being sold a tool by watching a café get worse; the block built to answer "does this work?" answers "the number went down." What lands, and must be protected: *"deneyeceğiniz her gönderim, nedeni yazılı olarak reddedilir."*

## Minor Observations

- **Line length up to 151ch** at 1440px (`text-meta` blocks with no `max-width`), against a 65–75ch floor. Mobile is fine at ≤49ch.
- **`text-eyebrow` computes to 10.5px**, ×8 per viewport — below the 11px floor. System-wide token, not a one-off.
- The trial line — the most reassuring sentence on the page — is 11px.
- The product screenshot carries the page's **only shadow**, against a contract that says hairline-only.
- The "why" note titled **"Müşterinin kendi cümlesi"** has a body entirely about language handling and canonical themes. The heading promises quotes; the paragraph delivers i18n.
- "…**üç iş değişmez**" reads as "the same three jobs" rather than "there will always be three."
- No `prefers-reduced-motion` guard on the pipeline's transitions.
- `LocaleSwitcher` at 12.8px is the smallest control in the header, on a page whose stated rationale was that the front door must change its own language.
- **Detector false positives, verified and dismissed:** `marquee` (0 marquee elements, 0 infinite animations), `gradient-text` (0 `background-clip:text`; the 4 gradient hits are the pre-existing `scroll-shadow` utility), `nested-cards` (a transparent hairline tile, not a stacked card).
- **Admirable and rare:** 10 links, 4 destinations, no nav bar, no cookie banner, no chat widget. 26 tab stops, all reachable, all with visible focus rings. Zero console errors, zero broken images, zero horizontal overflow at either width.

## Questions to Consider

1. If the pipeline already delivers the three actions *and* their six quotes, what is the briefing card for — and if the answer is "to show the document format", why does it repeat the evidence instead of pointing at `/sample`, which the primary CTA opens anyway?
2. The demo café's score falls 74 → 65 across the designated memorable moment. Is a hero artefact allowed to be a business getting worse, when no section shows recovery? Honesty says yes; the buying question says this proves the *reporting* works and says nothing about whether the *advice* does.
3. The primary persona is phone-heavy, and the signature interaction is `lg`-only. If the phone is the primary screen, why does desktop carry the argument and the phone get the summary?
4. `aria-pressed` on twelve buttons that cannot be pressed is a promise the page cannot keep. Is the fix to remove the ARIA — or to build what it describes, and let a reader *pin* a lineage so they can read the evidence with both hands free?
