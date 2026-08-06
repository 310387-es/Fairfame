# 18 — Accessibility & mobile verification

*Revira · evidence for the WCAG AA and mobile-layout requirements in `docs/17-phase-2-build-plan.md` §P2-T9 · verified 4 Aug 2026*

This is the sibling of `docs/12-ai-guardrail-validation.md`: a record of the checks that **cannot live in the unit suite**, so that "we verified it" is a document rather than a memory.

There is no browser test layer, by decision. That rules out asserting these in CI; it does not rule out verifying them, and it does not make them true by default. Everything below was run against the app on `localhost:3000`.

---

> **Update, 4 Aug 2026.** Sections 2 and 3 below were the hand-run evidence. Both
> are now **automated** in Playwright (`pnpm test:e2e`) — `e2e/mobile-layout.spec.ts`
> and `e2e/keyboard.spec.ts` run the same walks against a real browser. The manual
> recipes are kept because they are still the fastest way to investigate a
> failure, and because they explain *why* each check exists.

## 1. What *is* automated

`tests/lib/design-contrast.test.ts` — WCAG 2.1 AA contrast, computed from `src/app/globals.css` on every run.

Contrast is a property of the palette, not of a rendered page, so it is the one part of AA that belongs in the test suite. It caught a live failure: the segmented control's inactive labels (the inbox sort) were `--ink-400` on `--surface-segmented` at **3.97:1**, below the 4.5 floor. Fixed to `--ink-500` (4.97:1).

It also established that the palette's rule is a **table, not a token** — the lightest legal body ink depends on the surface, because a value designed against white is marginal on the canvas and illegal on a control's trough:

| surface | lightest legal body text |
| --- | --- |
| `--surface` (white card) | `--ink-400` (4.68:1) |
| `--canvas`, `--surface-sunken` | `--ink-350` (4.73 / 4.71:1) |
| `--surface-segmented` | `--ink-500` (4.97:1) |

`--ink-300` is non-text only **and only on white** — 3.06:1 there, 2.86:1 on the canvas, under the 3:1 non-text floor.

`tests/lib/i18n-messages.test.ts` — every message in both catalogues is compiled through next-intl. Added because a malformed ICU string (`{{author}}`) passed both the parity check and the usage check and would have failed at render.

---

## 2. Mobile triage layout

**Method.** The window could not be resized below the OS minimum, so the app was loaded in a same-origin iframe at a phone width and measured from inside it. This is repeatable: paste into the console on any app page.

```js
const f = document.createElement("iframe");
f.src = "/reviews?sentiment=negative";
f.style.cssText = "position:fixed;top:0;left:0;width:390px;height:840px;z-index:99999";
document.body.appendChild(f);
// then, against f.contentDocument:
//   documentElement.clientWidth              → the real inner viewport
//   documentElement.scrollWidth > clientWidth → horizontal scroll
//   [...querySelectorAll("*")].filter(el => el.getBoundingClientRect().right > clientWidth + 1)
```

**Result at a 386px viewport (`/reviews?sentiment=negative`):**

| check | result |
| --- | --- |
| Horizontal scroll | none |
| Elements overflowing the viewport | 0 |
| Filter groups | label stacks above its chips (`sm:grid-cols-[6rem_1fr]`) |
| Chip rows | wrap; no truncation |
| Review card | fits; text wraps; reply buttons wrap to two lines |
| Triage row | wraps — status on one line, assignee + SLA badge on the next |
| "Load more" | visible (the phone's pager) |
| Numbered pager | hidden, as designed |

**Known cosmetic limit.** The status and assignee selects are fixed widths (`w-36`, `w-44`), which together exceed a 386px content column, so they wrap rather than sitting side by side. Legible and usable; making them full-width below `sm` would be tidier and is not a defect.

---

## 3. Keyboard and assistive technology

**Method.** A `focusin` listener recorded every focus stop and whether it had a visible ring; `Tab` was then pressed 52 times from the top of `/reviews`.

| criterion | result |
| --- | --- |
| **4.1.2** Name, Role, Value | 209 interactive elements on the page, **0 without an accessible name**. 52 focus stops, **0 unnamed**. |
| **2.4.7** Focus Visible | **0 of 52** focus stops lacked an outline or box-shadow. |
| **2.4.3** Focus Order | Follows reading order: rail nav → plan → location switcher → search → notifications → language → user menu → filter chips → sort → saved views → per card: select checkbox → theme links → *Kendin yaz* → *Şablon* → *Yapay zekâ ile taslak* → *Durum* → *Atanan kişi* → next card. |
| **2.1.1** Keyboard | `Enter` opens the status select; focus moves into the listbox; all four options are exposed as `role="option"`. |
| **2.1.2** No Keyboard Trap | `Escape` closes it, focus returns to the trigger, and **the value is unchanged** — dismissing does not mutate the review. |

Phase 2's own controls all carry names, in the reader's language: `Durum`, `Atanan kişi`, `Burak Koç adlı kişinin yorumunu seç`, `Bildirimler — 160 okunmamış`.

---

## 4. What is still unverified

- ~~**Screen-reader announcement.**~~ Checked with **VoiceOver on macOS** by the product owner, 4 Aug 2026, and reported working. This was a hands-on spot-check rather than a criterion-by-criterion audit, and the specifics were not captured — so treat it as "a person heard the inbox read out and it made sense", which is exactly the thing the accessibility tree could not tell us. **NVDA and JAWS on Windows** were checked separately, also by the product owner, and reported working. Same caveat: hands-on, not criterion-by-criterion, and the specifics were not captured.
- **Real devices.** The iframe gives a true 386px viewport and real media queries; it does not give touch targets, on-screen keyboards, or iOS Safari's viewport quirks.
- **Regression protection.** Closed. Contrast, ICU, layout and keyboard are all guarded now — the first two on every `pnpm verify`, the last two on `pnpm test:e2e`, which is separate because it needs a live server and database.
- **What the browser suite still does not cover.** It asserts that a control is reachable, named and ringed; it cannot hear what a screen reader says about it. It runs one engine (Chromium) at one viewport, so Safari-specific and touch-specific behaviour is still unexercised.
