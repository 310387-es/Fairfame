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

The one illustration device: **the murmur** — the town talking, faintly, in both languages. Short phrases in Lora italic drift on paper at near-invisible opacity; near the pointer they sharpen into ink — lean in and you can hear the talk — and a click sends a quiet ring through them. It is the brand's picture of word of mouth, told in Fairfame's own material: words.

Implementation: `brand/murmur.js` — self-contained, `Murmur.attach(el, {carve:true})`, no dependencies; the `carve` option keeps a clear zone behind hero content, and `prefers-reduced-motion` stills the drift. The brand sheet's hero and §04 band run it live.

*Integration notes (10 Aug 2026), added when the app mounted this file. Both are backwards compatible — the brand sheet's own call is unchanged — and both exist because an embedded copy is not a standalone page:*

- **`opts.family`** — the font-family string to draw with, default `"Lora"`. The name of a loaded face belongs to whatever loaded it, and a bundler that hashes it leaves the canvas drawing in Georgia: still a serif, still handsome, silently not the brand. The front door passes `lora.style.fontFamily`.
- **`attach` returns `{detach}`** — cancels the loop, drops the listeners, removes the canvas. In a single-page app the container unmounts while the tab stays open, and a render loop with nothing to render into is a warm phone.
- **Wide viewports only, in the product.** `carve` clears the middle, so the words gather in the margins — which a 390px hero does not have. On a phone they land on the subhead and on small faint copy, and texture behind body copy is a contrast problem that cannot be solved by making the texture fainter. `src/components/marketing/murmur-field.tsx` attaches at `lg` and above.

Rules: the phrases are **invented, generic and anonymous — never real review text** (a customer's sentence is personal data, not decoration); mostly ink at ~10% opacity, a minority in amber; Lora italic only; never inside the product — the app's imagery is its data ([`15`](./15-design-system.md) §7); in print and email the murmur freezes into faint static text or is simply absent. *(v2.1 note: this replaced an amber-dither texture that leaned too close to a reference brand's signature — same idea, now said in our voice.)*

## 6. Voice

Candid, specific, second person — the same house style [`15`](./15-design-system.md) §7 already enforces in-product, extended to marketing: real figures with a click-through behind them, never round vague claims; "22 reviews are waiting for a reply. Three matter today." beats any sentence containing *revolutionize*. Turkish is an equal, not a translation — write the TR line as its own sentence. Headlines end in a full stop, like the wordmark.

## 7. Where the brand stops and the product starts

The brand layer (paper, Lora, the murmur, the seal) applies to: the marketing front door (`/`), documents and PDFs that leave the app, outbound email *chrome* (header/footer), social, and print. The product keeps [`15`](./15-design-system.md)/[`21`](./21-visual-language.md) untouched: cool canvas, Geist-only, no texture, no Lora. The two share ink, amber, indigo and the seal — which is what keeps them one company rather than two.

## 8. Still open — the two gates

1. **Trademark.** Fairfame is unscreened: TÜRKPATENT and EUIPO classes 9, 35, 42, plus a USPTO knock-out. Until it clears, the name is adopted-at-risk and nothing customer-facing ships with it.
2. **Domain.** fairfame.com sits with HugeDomains (fixed-price reseller listing) — a purchase, not a negotiation. fairfame.com.tr unchecked. Buy before public use. Naming history and the ruled-out list: `05` §6 and the project memory.

When both clear, the remaining work is integration — favicon set in `public/`, the rail seal, Lora on `/`, and the display-name sweep — tracked as tasks, not in this document.
