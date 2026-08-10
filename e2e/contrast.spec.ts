import { expect, test } from "@playwright/test";

/*
  Signed out, explicitly.

  `playwright.config.ts` attaches the shared account's `storageState` to this
  project, so without this the first thing `/` does is redirect to `/dashboard`
  and the spec measures the application instead of the page it names — which is
  how its first run reported a trial-countdown badge on the landing page.
  `auth-screen.spec.ts` clears state for the same reason.
*/
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * WCAG AA text contrast, measured on the rendered page.
 *
 * **Why this exists when `tests/lib/design-contrast.test.ts` already checks the
 * palette.** That file asserts the *tokens*: on this surface, this ink and every
 * darker one clears 4.5:1. It is exact and it is not enough, because it cannot
 * see which ink a component actually puts on which surface — that pairing is a
 * DOM relationship, not a source one.
 *
 * The landing page proved the gap. `--indigo-050` was in the token file as a
 * badge wash carrying `--indigo-700`; a section used it as a full-bleed
 * background carrying `--ink-350`; four paragraphs measured **4.493:1**, under
 * AA by seven thousandths, and every unit test stayed green. The completeness
 * test added alongside this one now catches a *surface* nobody classified. Only
 * a rendered page catches a legal surface with an illegal ink on it.
 *
 * So this walks real elements, resolves the colour actually painted behind each
 * one, and applies the WCAG floor its own font size and weight earn. It is the
 * measurement that was being done by hand during the landing-page build, made
 * permanent.
 *
 * **Public routes only, and deliberately.** These need no account, so the spec
 * stays fast and independent of the shared fixture. The application's own
 * screens are the next thing to add here, not a reason to delay this.
 */

/** SC 1.4.3: 4.5:1 for body text, 3:1 for large text (>=24px, or >=18.66px bold). */
const AA_TEXT = 4.5;
const AA_LARGE = 3;

type Failure = { ratio: number; size: number; weight: number; text: string; selector: string };

/*
  Measured in the page, not from source.

  Passed as a real function with its thresholds as an argument rather than as a
  template string: `page.evaluate` treats a string as an *expression*, so a
  stringified arrow function evaluates to the function itself and the result
  comes back undefined — which is how the first run of this spec "failed" with a
  TypeError rather than a contrast report.
*/
function measure({ aaText, aaLarge }: { aaText: number; aaLarge: number }): Failure[] {
  /*
    Rasterise, do not parse.

    `getComputedStyle` returns whatever colour space the value was authored in —
    this project's own tokens come back as `rgb()`, but the shadcn base layer is
    `oklch()` and Chrome reports the page background as
    `lab(98.2353 -0.0323951 -1.89769)`. Reading numbers out of that string with a
    regex treats LAB components as RGB channels: a near-white background is read
    as `rgb(98, 0, 1)`, a dark red, and every dark-on-light element on the page
    reports about 1.2:1. That is exactly how the first run of this spec produced
    a page full of impossible failures.

    Painting one pixel and reading it back makes the browser do the conversion,
    which is the only implementation that is right for every colour space it
    supports — including ones added after this was written.
  */
  const context = document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  })!;
  /** `[r, g, b, alpha]` — alpha read from the pixel, never from the string. */
  const toRGBA = (value: string): [number, number, number, number] => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000000";
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!, a! / 255];
  };

  const toRGB = (value: string): number[] => toRGBA(value).slice(0, 3);

  const luminance = (rgb: number[]): number => {
    const [r, g, b] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };

  /*
    The colour actually behind this element.

    Walking up until something is not transparent is the only honest answer: an
    element's own background is usually `rgba(0, 0, 0, 0)` and the pixel a
    reader sees comes from an ancestor several levels away.
  */
  /*
    The colour actually behind this element, composited.

    Two things make this more than "read the parent's background". Most
    elements are transparent, so the pixel a reader sees comes from an ancestor
    several levels up — and a *translucent* layer such as `bg-primary/5` is not
    the backdrop either, it sits over one. Treating 5% indigo as opaque reports
    it as near-black and fails every label on top of it.

    So layers are collected on the way up and painted back down over the first
    opaque colour, which is what the compositor does.
  */
  const backgroundOf = (element: Element): number[] => {
    const layers: string[] = [];
    let node: Element | null = element;
    let base = [255, 255, 255];

    while (node) {
      const background = getComputedStyle(node).backgroundColor;
      if (background && !/rgba\(0, 0, 0, 0\)|transparent/.test(background)) {
        const [r, g, b, alpha] = toRGBA(background);
        if (alpha >= 0.999) {
          base = [r!, g!, b!];
          break;
        }
        // Alpha comes from the painted pixel, so a translucent layer authored
        // as `oklch(... / 0.05)` is handled exactly like one authored as
        // `rgba(...)`. Reading it out of the string missed the former and
        // treated 5% indigo as opaque, which reported it as near-black.
        if (alpha > 0) layers.push(background);
      }
      node = node.parentElement;
    }

    return layers.reduceRight((under, layer) => {
      const [r, g, b, alpha] = toRGBA(layer);
      const over = [r!, g!, b!];
      return under.map((channel, i) => Math.round(over[i]! * alpha! + channel * (1 - alpha!)));
    }, base);
  };

  const failures: Failure[] = [];
  for (const element of document.querySelectorAll("body *")) {
    // Only elements that render text themselves: a container's textContent is
    // its children's, and measuring it would blame the wrong node.
    if (element.children.length > 0) continue;
    const text = (element.textContent ?? "").trim();
    if (!text) continue;

    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
      continue;
    // Decorative glyphs carrying a text equivalent are not text for SC 1.4.3.
    if (element.closest('[aria-hidden="true"]')) continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;

    const size = parseFloat(style.fontSize);
    const weight = parseInt(style.fontWeight, 10) || 400;
    const a = luminance(toRGB(style.color));
    const b = luminance(backgroundOf(element));
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

    const floor = size >= 24 || (size >= 18.66 && weight >= 700) ? aaLarge : aaText;
    if (ratio < floor) {
      failures.push({
        ratio: Math.round(ratio * 1000) / 1000,
        size,
        weight,
        text: text.slice(0, 40),
        selector: `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`,
      });
    }
  }
  return failures;
}

/* The public surfaces a stranger can reach without an account. */
const ROUTES: [name: string, route: string][] = [
  ["the landing page", "/"],
  ["the sample digest", "/sample"],
];

for (const [name, route] of ROUTES) {
  for (const [device, width, height] of [
    ["desktop", 1440, 900],
    ["mobile", 390, 844],
  ] as const) {
    test(`${name} carries no text below its AA floor (${device})`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(route, { waitUntil: "networkidle" });

      // Lazy content below the fold is text too.
      await page.evaluate(async () => {
        const step = window.innerHeight;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        window.scrollTo(0, 0);
      });

      const failures = await page.evaluate(measure, { aaText: AA_TEXT, aaLarge: AA_LARGE });

      expect(
        failures,
        failures
          .map((f) => `${f.ratio}:1 at ${f.size}px/${f.weight} — "${f.text}" (${f.selector})`)
          .join("\n"),
      ).toEqual([]);
    });
  }
}
