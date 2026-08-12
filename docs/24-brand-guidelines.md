# 24 — Brand guidelines

**Status:** adopted 10 Aug 2026, **revised same day (v2, then v2.1)** after founder review — the first pass was judged too plain; v2 added warmth and an editorial voice; v2.1 replaced the amber dither texture with **the murmur** (§5) because the dither sat too close to a reference brand's signature to be ours. The name and mark below are the decided identity, **subject to the two gates in §8** (trademark screening, domain purchase). This document governs the *identity* — name, logo, brand colour, brand type, texture, voice. [`15-design-system.md`](./15-design-system.md) and [`21-visual-language.md`](./21-visual-language.md) continue to govern every in-app surface; §7 says exactly where the boundary sits.

**The brand sheet — `brand/fairfame-brand-sheet.html` — is the visual form of this document.** Open it to *see* every rule below; read on for the rules themselves and the reasons.

---

## 1. The name

**Fairfame.** One word, capital F, in all prose — English and Turkish. All-lowercase never appears anywhere (v2 retired the lowercase logotype). Never `FairFame`, never `Fair Fame`.

"Fair fame" is a real English phrase — early-modern through 19th-century usage — meaning **good reputation, honourably earned**. The name says what the customer gets, not what the product reads (territory decision: [`05-business-model-and-gtm.md`](./05-business-model-and-gtm.md) §6). It contains no `w`, `q`, `x`, and no hard `c` — it survives the Turkish alphabet, and "fair" is already familiar via *fair play*.

Turkish suffixation with an apostrophe, on the final vowel sound of *fame*: **Fairfame'e, Fairfame'in, Fairfame'de**.

## 2. The logo

**A seal, not a sticker.** The two f's of *fair* and *fame* share a single crossbar — two words fused into one mark — set in a **solid circular seal**: the stamp a good name used to get. The shared crossbar is the identity; a redraw that gives each f its own bar has drawn a different logo. v2 moved from the rounded-square tile to the circle and thickened the strokes after the tile version was judged too generic an app-icon shape.

Construction, 44-unit grid: circle r 22; stems at x 16.4 and 25.4, hooks curving left at the top; one crossbar x 12.2 → 30.6; stroke 4.3, round caps.

**The wordmark is `Fairfame` in Geist 700, ending in an amber full stop** — the last word on a reputation, and the one place amber enters the logo. The full stop is part of the wordmark: it appears wherever the wordmark does and never on the seal alone.

| Variant | File | Use |
|---|---|---|
| Primary lockup | `brand/fairfame-lockup.svg` | Light/paper surfaces: marketing, documents, email headers. |
| On-dark lockup | `brand/fairfame-lockup-on-dark.svg` | Ink surfaces (rail, briefing bar): white seal, rail-ink glyph, white wordmark, amber stop. |
| Mono lockup | `brand/fairfame-lockup-mono.svg` | Single-colour print/PDF: everything ink, including the stop. |
| Wordmark only | `brand/fairfame-wordmark.svg` | Where the seal already appears nearby (e.g. page footer). |
| Seal | `brand/fairfame-symbol.svg` | App tile, favicon, avatar, social. Holds at 16px. |
| Seal on dark | `brand/fairfame-symbol-on-dark.svg` | Dark surfaces without the wordmark. |
| Seal, mono | `brand/fairfame-symbol-mono.svg` | The mono lockup's counterpart: single-colour print/PDF where the wordmark is already nearby. |
| Seal, amber | `brand/fairfame-symbol-amber.svg` | Sparingly: social avatars, stickers, moments of celebration. Never in the app shell. |
| Bare glyph | `brand/fairfame-glyph.svg` | Watermarks and pattern use only. |
| Favicon + PNGs | `brand/favicon.svg`, `brand/png/` | favicon.svg; PNG at 512 / 192 / 180 / 32; lockup at 1200 for social cards. |

**Minimums:** seal 16px; lockup 28px tall. **Clear space:** half the seal's diameter on every side. Below 24px use the seal alone — never a shrunken lockup.

## 3. Colour

**Paper, ink, amber, indigo.** Four values govern everything outside the app:

| Role | Hex | Rule |
|---|---|---|
| Paper | `#FAF7F0` | The marketing and document background. Warm on purpose — the app's cool `--canvas` stays in the app. |
| Ink | `#10193A` | Text, the seal, buttons. Identical to `--ink-800`. |
| Amber | `#F5A524` | The brand's temperature: the full stop, the murmur's accent words, ratings. Identical to `--amber-500`. |
| Indigo | `#3D5AF1` | Links and interaction **only** — same meaning as in-product. Never decorative. |

Amber is the only decorative colour the brand has, and the murmur's accent words (§5) are the only place it appears in quantity. No gradients, no shadows on brand surfaces — flat colour throughout, same argument as [`15`](./15-design-system.md).

Hex values are stated here because brand assets ship *outside* the app — a PDF, an email, an embed — where `globals.css` does not exist. Same exemption `src/widgets/theme.ts` holds; it is the only reason a hex appears in this file.

## 4. Typography

**Serif says it; sans runs it.**

- **Display — Lora** (Google Fonts; variable, excellent Turkish coverage). Marketing headlines, section statements, and pull-quotes (italic). Weight 500–600, tight leading. Lora is the voice of the *phrase* — "fair fame" is a piece of old English, and an editorial serif lets the brand say so.
- **Everything else — Geist**, unchanged ([`15`](./15-design-system.md) §3). UI, body copy, buttons, emails, numerals (tabular / Geist Mono). The brand never re-types UI.
- The logotype is Geist 700 **cut to outlines** in the SVGs — never re-typed live.

Lora loads via `next/font/google` **on public marketing surfaces only** (`/`, SEO pages' hero if desired). It never enters the app shell — the Operate scale in [`15`](./15-design-system.md) §3 is untouched, and [`21`](./21-visual-language.md) still wins any disagreement inside the product.

## 5. Texture — the murmur

The one illustration device: **the murmur** — the town talking, faintly, in the reader's language — bilingual only where the audience truly is. Short phrases in Lora italic drift on paper at near-invisible opacity; near the pointer they sharpen into ink — lean in and you can hear the talk — and a click sends a quiet ring through them. It is the brand's picture of word of mouth, told in Fairfame's own material: words.

Implementation: `brand/murmur.js` — self-contained, no dependencies; `Murmur.attach(el, opts)` returns `{detach}`, and `Murmur.setPhrases(list)` switches language in place. `prefers-reduced-motion` stills the drift. The brand sheet's hero and §04 band run it live; the front door runs it with the options below.

*Integration notes — the options the app added to this file (10–11 Aug 2026), the first two **re-applied** after a regenerated copy dropped them. **Every one is backwards compatible and defaults to the old behaviour**, so the brand sheet's and the landing concept's own calls are unchanged. They exist because an embedded copy is not a standalone page; a regeneration that loses them takes the front door down on the first click, so re-apply rather than revert:*

- **`opts.family`** — the font-family string to draw with, default `"Lora"`. The name of a loaded face belongs to whatever loaded it, and a bundler that hashes it leaves the canvas drawing in Georgia: still a serif, still handsome, silently not the brand. The front door passes `lora.style.fontFamily`.
- **`opts.opacity`** *(added 11 Aug 2026)* — a multiplier on the **resting** alpha, default `1`. The words settle at 10% ink (34% for the amber minority) and sharpen toward the pointer; this lifts only where they settle, so leaning in still has somewhere to go. Clamped at `0.6`, which is what stops a multiplier turning the texture into content sitting behind a headline. The front door passes `1.5` — at the default the device did not register as anything on a large screen. It is a question of presence, not of contrast: `opts.veil` below is what keeps the words off the copy, so opacity is free to be chosen for how the field should feel.
- **`attach` returns `{detach}`** — cancels the loop, drops the listeners, removes the canvas. In a single-page app the container unmounts while the tab stays open, and a render loop with nothing to render into is a warm phone.
- **Wide viewports only, in the product.** The words need room to gather, which a 390px hero does not have — on a phone they land on the subhead and on small faint copy, and texture behind body copy is a contrast problem that cannot be solved by making the texture fainter. `src/components/marketing/murmur-field.tsx` attaches at `lg` and above.
- **`opts.veil` — the way to put copy over the field** *(11 Aug 2026)*. Three approaches, and only the third has no visible seam. **Carve** rejects positions inside an ellipse: the middle goes empty, which under centred copy reads as a hole rather than as a background. **A scrim** — a paper-to-transparent radial painted over the canvas — fills the middle back in, but it fades *pixels*, so a phrase straddling its edge is drawn half-visible and a sentence stops in the middle of itself. **`veil` fades words**: each one's alpha is scaled by how deep its own centre sits in the ellipse, so every phrase is whole at whatever opacity it has and the field stays continuous all the way through. Two details it took a pass each to find — the veil must scale the pointer-proximity *ceiling* too, or leaning on the headline sharpens the words underneath it back to full strength; and the ellipse's inner 72% is held **flat**, because a text block is a rectangle inside an ellipse and a ramp starting at the centre has already given most of the opacity back by the time it reaches the block's corners.
- **Carve or scrim, if you are not using the veil** *(superseded for centred copy)*. `carve` clears an ellipse and the words gather around it, which is right for an off-centre composition and wrong for a centred one: the cleared ellipse lands exactly where the eye goes and the field reads as a ring around a hole. The front door runs `carve: false` and paints a radial paper wash behind its text block instead, so the words thin out *gradually* under the copy and the crowd stays continuous. **Carve removes the texture and leaves a shape; the scrim veils it and leaves a field.** Either satisfies the rule that matters — no body copy over a moving texture — and neither is optional.
  - **Size a scrim against the smallest type in the block, not the headline.** A wash tuned to a poster-sized heading leaves the caption underneath it sitting on drifting words, and **no automated check will tell you**: a contrast suite resolves an element's background from its ancestors, and the murmur's canvas is a sibling, so the test reads the surface colour and passes whatever is actually painted behind. This one is caught by looking.
- **Enough phrases that none repeats more than twice — and the count moves with the density.** The canvas seeds roughly one word per 26,000 square pixels times `opts.density`, so the front door's `density: 2` puts ~90 phrases on a large hero. `murmur.js` deals from a shuffled deck rather than picking at random, so the counts differ by at most one — which means **the list has to be at least half the word count**. The front door carries **48 per language** for that reason, and it went 10 → 28 → 48 as the field was crowded. *Making the murmur denser is a copywriting job before it is a config change*: a crowd that repeats itself reads as a bug.
- **`opts.speed`** *(11 Aug 2026)* — a multiplier on the drift, default 1; the front door passes 1.7. It scales the two out-of-phase sines and **not** their amplitude, so a livelier murmur stirs in place rather than drifting further across the page.

Rules: the phrases are **invented, generic and anonymous — never real review text** (a customer's sentence is personal data, not decoration); mostly ink at ~10–15% resting opacity (see `opts.opacity` above), a minority in amber; Lora italic only; never inside the product — the app's imagery is its data ([`15`](./15-design-system.md) §7); in print and email the murmur freezes into faint static text or is simply absent. *(v2.1 note: this replaced an amber-dither texture that leaned too close to a reference brand's signature — same idea, now said in our voice.)*

## 6. Voice

Candid, specific, second person — the same house style [`15`](./15-design-system.md) §7 already enforces in-product, extended to marketing: real figures with a click-through behind them, never round vague claims; "22 reviews are waiting for a reply. Three matter today." beats any sentence containing *revolutionize*. Turkish is an equal, not a translation — write the TR line as its own sentence. Headlines end in a full stop, like the wordmark.

## 7. Where the brand stops and the product starts

The brand layer (paper, Lora, the murmur, the seal) applies to: the marketing front door (`/`), documents and PDFs that leave the app, outbound email *chrome* (header/footer), social, and print. The product keeps [`15`](./15-design-system.md)/[`21`](./21-visual-language.md) untouched: cool canvas, Geist-only, no texture, no Lora. The two share ink, amber, indigo and the seal — which is what keeps them one company rather than two.

## 8. Still open — the two gates

1. **Trademark.** Fairfame is unscreened: TÜRKPATENT and EUIPO classes 9, 35, 42, plus a USPTO knock-out. Until it clears, the name is adopted-at-risk and nothing customer-facing ships with it.
2. **Domain.** fairfame.com sits with HugeDomains (fixed-price reseller listing) — a purchase, not a negotiation. fairfame.com.tr unchecked. Buy before public use. Naming history and the ruled-out list: `05` §6 and the project memory.

When both clear, the remaining work is integration — favicon set in `public/`, the rail seal, Lora on `/`, and the display-name sweep — tracked as tasks, not in this document.
