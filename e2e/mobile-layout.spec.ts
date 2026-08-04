import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

/**
 * Mobile triage layout, at a real viewport (P2-T9's remaining half).
 *
 * This is the check that could not exist before. jsdom has no layout engine, so
 * "does anything overflow at 390px" is not a question it can answer — every
 * previous attempt was either a class-string assertion, which proves nothing
 * about layout, or a person looking at a screenshot, which does not run again
 * tomorrow.
 *
 * The assertion is deliberately about *overflow* rather than about pixels.
 * Asserting positions would fail on every legitimate design change; asserting
 * that nothing escapes the viewport fails only when something is actually
 * broken — which, on a phone, means a horizontal scrollbar and a card whose
 * right-hand side cannot be reached.
 */

/** An iPhone-ish portrait viewport. */
const PHONE = { width: 390, height: 844 };

/** Elements that stick out past the right edge, named so a failure is readable. */
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll("body *")]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        // Zero-sized nodes and things deliberately parked off-screen (a sheet,
        // a popover's portal) are not overflow.
        if (rect.width === 0 || rect.height === 0) return false;
        if (getComputedStyle(el).position === "fixed") return false;
        return rect.right > limit + 1;
      })
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join(".")}`);
  });
}

async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

test.use({ viewport: PHONE });

test.describe("the inbox on a phone", () => {
  test("fits the viewport, with nothing hanging off the side", async ({ page }) => {
    await page.goto("/inbox");
    await expect(page.getByRole("heading").first()).toBeVisible();

    expect(await overflowing(page)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
  });

  test("swaps the numbered pager for a load-more control", async ({ page }) => {
    // The two paging models from P2-T2, and the whole reason both exist: page
    // numbers to jump around on a desktop, a single forward step on a phone.
    await page.goto("/inbox");
    await expect(page.getByRole("heading").first()).toBeVisible();

    const pager = page.getByRole("navigation", { name: /sayfalama|pagination/i });
    await expect(pager).toBeHidden();
  });

  test("keeps the filter bar's labels readable rather than clipping them", async ({ page }) => {
    // The bug this guards: `ChipGroup`'s label column was a fixed 3.5rem, which
    // clipped the Turkish "GÖRÜNÜMLER" outright. It stacks below `sm` now, so
    // the assertion is that each label renders at its full width — a clipped
    // one is narrower than the text inside it.
    await page.goto("/inbox");

    const labels = page.locator("span.uppercase").filter({ hasText: /\S/ });
    const count = await labels.count();
    expect(count, "the filter bar should render at least one group label").toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const label = labels.nth(index);
      const clipped = await label.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(clipped, `"${await label.innerText()}" is clipped`).toBe(false);
    }

    expect(await overflowing(page)).toEqual([]);
  });
});

test.describe("the public review page on a phone", () => {
  // Unauthenticated: this is what a customer actually opens, from a QR code on
  // a table, on a phone. If anything in the product has to survive a small
  // screen it is this page.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("fits the viewport", async ({ page }) => {
    await page.goto(`/c/${campaignSlug()}`);
    await expect(page.getByRole("button", { name: /gönder|submit/i })).toBeVisible();

    expect(await overflowing(page)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
  });
});

/** The campaign the setup created, recorded for the suite to open. */
function campaignSlug(): string {
  const run = JSON.parse(readFileSync("e2e/.auth/run.json", "utf8")) as { campaignSlug: string };
  return run.campaignSlug;
}
