import { test, expect, type Page } from "@playwright/test";

/**
 * Keyboard and focus on the inbox (WCAG 2.1.1, 2.1.2, 2.4.3, 2.4.7).
 *
 * The other half of what unit tests structurally cannot reach. Tab order, a
 * visible focus ring and whether `Escape` gives focus back are behaviours of a
 * browser: there is no component tree you can inspect to learn them, and
 * asserting the Tailwind class that *would* produce a ring proves only that
 * somebody typed the class.
 *
 * These were verified by hand at the end of Phase 2 and written up in
 * `docs/18`. This is the same walk, run automatically.
 */

/** Everything the browser will stop on, in order, with what it looks like there. */
async function tabThrough(page: Page, steps: number) {
  const stops: { name: string; role: string; ring: boolean }[] = [];

  for (let index = 0; index < steps; index += 1) {
    await page.keyboard.press("Tab");

    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;

      // Next's development error overlay mounts a focusable custom element
      // outside the app. It is not part of the product and does not exist in a
      // production build, so counting it would fail these assertions for a
      // reason no user will ever see. Screens with fewer controls than the
      // inbox tab far enough to reach it.
      if (el.closest("nextjs-portal")) return null;

      const style = getComputedStyle(el);
      const label =
        el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? el.textContent ?? "";

      return {
        name: label.trim().slice(0, 40),
        role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
        // Either mechanism counts: the system uses a ring built from
        // box-shadow, and native controls draw an outline.
        ring: style.outlineStyle !== "none" || style.boxShadow !== "none",
      };
    });

    if (stop) stops.push(stop);
  }

  return stops;
}

test.describe("moving through the inbox with a keyboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/inbox");
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("every focus stop has a name and a visible ring", async ({ page }) => {
    const stops = await tabThrough(page, 40);

    expect(stops.length, "tabbing should reach the page's controls").toBeGreaterThan(15);

    // Named, because a focus stop nobody can identify is unusable to a screen
    // reader — and ringed, because one nobody can see is unusable to everyone
    // else navigating by keyboard.
    expect(stops.filter((stop) => stop.name === "")).toEqual([]);
    expect(stops.filter((stop) => !stop.ring)).toEqual([]);
  });

  test("reaches the triage controls on a review card", async ({ page }) => {
    const stops = await tabThrough(page, 60);
    const names = stops.map((stop) => stop.name);

    // The Phase 2 additions. Reaching them by keyboard at all is the claim;
    // their exact position shifts with the filter bar and is not worth pinning.
    expect(names.some((name) => /durum|status/i.test(name))).toBe(true);
    expect(names.some((name) => /atanan|assignee/i.test(name))).toBe(true);
  });

  test("opens a select, and Escape gives focus back without changing it", async ({ page }) => {
    const status = page.getByRole("combobox", { name: /durum|status/i }).first();
    // Wait for it to actually show its value first: reading the label before
    // hydration returns an empty string, and "unchanged" would then compare ""
    // against the real value and fail for the wrong reason.
    await expect(status).toContainText(/\S/);

    await status.focus();
    const before = await status.innerText();

    await page.keyboard.press("Enter");
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible();
    expect(await options.count()).toBe(4);

    await page.keyboard.press("Escape");
    await expect(options.first()).toBeHidden();

    // Dismissing must not be a decision. A select that committed whatever the
    // cursor happened to be over would silently reclassify somebody's review.
    await expect(status).toBeFocused();
    expect(await status.innerText()).toBe(before);
  });

  test("does not trap focus inside the review list", async ({ page }) => {
    // 2.1.2: whatever you can tab into, you can tab out of. Sixty presses is
    // well past the card controls; if focus were trapped the set of names
    // reached would stop growing long before that.
    const stops = await tabThrough(page, 60);
    const distinct = new Set(stops.map((stop) => `${stop.role}:${stop.name}`));

    expect(distinct.size).toBeGreaterThan(20);
  });
});

test.describe("moving through contacts with a keyboard", () => {
  /**
   * The Phase 4 screen (P4-T1). Its controls are deliberately links and a plain
   * GET form rather than client state, so most of this is the browser's own
   * behaviour — which is exactly why it is worth asserting that it survived:
   * a chip rendered as a `<div onClick>` would look identical and stop being
   * reachable at all.
   */
  test("reaches the search box and every filter chip, each named and ringed", async ({ page }) => {
    await page.goto("/contacts");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const stops = await tabThrough(page, 40);

    expect(stops.length, "tabbing should reach the page's controls").toBeGreaterThan(10);
    expect(stops.filter((stop) => stop.name === "")).toEqual([]);
    expect(stops.filter((stop) => !stop.ring)).toEqual([]);

    // The search field is a real input, so it is a focus stop with an
    // accessible name rather than a placeholder pretending to be a label.
    const search = page.getByRole("searchbox");
    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute("aria-label", /.+/);
  });

  test("submits a search with Enter, keeping the filters already applied", async ({ page }) => {
    // The form carries every other filter as hidden inputs. Without them,
    // pressing Enter in the search box would silently clear the tag you had
    // selected — which reads as "the filter is broken", not "the form is".
    await page.goto("/contacts?sub=unsubscribed");

    await page.getByRole("searchbox").fill("ayse");
    await page.getByRole("searchbox").press("Enter");

    await page.waitForURL(/\/contacts\?.*q=ayse/);
    expect(new URL(page.url()).searchParams.get("sub")).toBe("unsubscribed");
  });
});
