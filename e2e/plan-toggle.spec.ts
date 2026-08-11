import { test, expect } from "@playwright/test";

/**
 * The billing-period toggle, and the discount on it (11 Aug 2026).
 *
 * Two things worth a browser. **The saving must be in the control's accessible
 * name**, because `docs/15` §3 forbids saying anything in colour alone and a
 * green chip is exactly that to somebody who cannot see it — the assertion is
 * on `toHaveAccessibleName`, not on the pixels. And the chip made the toggle
 * wider, so a phone is where it would first spill.
 *
 * The arithmetic behind the figures is unit-tested; what cannot be checked from
 * source is whether the number reaches the screen at all.
 */
test.describe("the plan section's billing toggle", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("announces the saving, and fits a phone carrying it", async ({ page }) => {
    await page.goto("/settings#plan");

    const annual = page.getByRole("tab", { name: /annual|yıllık/i });
    await expect(annual).toBeVisible();
    await expect(annual).toHaveAccessibleName(/%|save|tasarruf/i);

    // Switching shows the concrete figure per plan, which is the thing the
    // research on this pattern says beats a bare percentage.
    await annual.click();
    await expect(page.getByText(/saves .* a year|yılda .* tasarruf/i).first()).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "no horizontal overflow").toBeLessThanOrEqual(1);
  });
});
