---
version: 1
slug: "src-app-page-tsx"
primary_target: "src/app/page.tsx"
related_targets: []
---

# Landing page — `/`

**Scope:** the public marketing front door at `/`, one page ending in pricing. Signed-in visitors still redirect to `/dashboard`. **Visitor mode: Persuade.**

**Audience & job.** A Turkish owner-operator on a phone, between customers, who has been sold to before by people who fake reviews; and secondarily an agency operator sizing up whether twenty clients fit. They must leave understanding one thing: *this tells you what to do on Friday, with the customer's own words as the reason.*

**Primary action:** open the sample digest. **Secondary:** sign up. TR default, EN via the existing locale toggle.

**Proof.** The artifact itself, composed live by `getSampleDigest()` — the same pipeline, the same metrics, over the invented café in `src/digest/sample-data.ts`. No customer logos, no testimonials, no uplift figures; design partners exist but no quote has been captured, so none appears. The invented café must be labelled as invented.

## Chosen direction — "the briefing is the page"

The page *is* a weekly Action Digest; the marketing argument lives in the **margins**, each note anchored to the element it explains. Refuses the category arrangement (slogan over a device-framed screenshot, then three feature cards).

**Comps informed the composition; they were never a reproduction spec.** The honest history, because two records disagreed and a later reader should not have to guess: the build was commissioned **code-led**, since no image generation existed in the session when the direction was chosen. Generation appeared mid-build (the Higgsfield CLI was installed at the user's request), three comps were produced, and the user approved a **combination** of two at a real approval point — `.impeccable/mocks/landing-fold-cut.png` for the upper half, `.impeccable/mocks/landing-artifact-led.png` for the artifact card and the margin column. Both sidecars carry `approved: true`; `landing-first-viewport.json` records `approved: false`.

So this is neither a clean code-led run nor a comp-led one. **Do not audit the render against these images pixel-for-pixel** — the ambition lives in the direction contract's FIRST VIEWPORT block, and the comps are a composition reference plus a `do_not_literalize` list (dropped Turkish diacritics, filler copy, an invented date, a rotated margin note, the logo shape). The build is deliberately stricter than the comps in one respect: they carry a faint gradient in the masthead and the build renders it flat, per `docs/15` §7.

**Memorable moment:** the follow-through block — "last week you were told to do three things; here is what happened to the number."

**Signature interaction:** each action discloses its evidence *in place* (`<details>`), revealing the exact customer quotes behind it and staying open. The page never links away to prove something.

## Implementation fidelity inventory

Read from the approved comps, because everything they do not show gets built from this record.

- **Corner language:** 14px blocks, 9px controls, 7px chips, full for numeric counts. **Line weights:** 1px hairlines only. **Elevation:** none on cards — hairline first. **Type ramp:** poster → hero → display → title → lead → body → copy → meta.
- **Signature geometry:** the artifact card cropped by the fold; a short indigo rule above each margin note; indigo circled numerals on action rows; hairline separators between them.

| Region | Medium |
|---|---|
| Header bar, headline, subtitle, CTAs | semantic HTML/CSS |
| Artifact card, score tile, action rows, hairlines | semantic HTML/CSS |
| Margin annotations | semantic HTML/CSS |
| Disclosure of evidence | `<details>`/`<summary>`, no JS |
| Logo monogram | existing project asset — `src/components/brand/logo.tsx` |
| Icons | lucide-react, already a dependency |
| Raster assets | **none, deliberately** |

**Zero raster is a design position, not economy.** `docs/15` §7: "No gradients, photography, illustration or texture. The product's imagery is its data." Both approved comps are entirely typographic and hairline geometry; there is no region with lighting, depth, figure or material. A photograph here would contradict the system it advertises.

**New token required:** the type scale tops out at `hero` (32px), which is not poster scale. Add `--text-poster` and register it in `FONT_SIZES` (`src/lib/utils.ts`) or `cn()` silently drops it — `docs/15` §3 and `tests/lib/class-merge.test.ts`.

## Unresolved

1. No design-partner quote is captured — ask before any appears.
2. CTA target: `/sample` vs a signed-up sample workspace.
3. Name is still provisional — no wordmark treatment.
4. Pricing figures are publishable but expected to change.
