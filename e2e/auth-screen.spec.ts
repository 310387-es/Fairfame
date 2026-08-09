import { test, expect } from "@playwright/test";

/**
 * The sign-in screen can change its own language (A22-C3).
 *
 * The toggle lived only in the application shell, so somebody who arrived in
 * the wrong language read the whole of sign-up and onboarding — the screens
 * that decide whether they stay — before reaching a control that could change
 * it. A Turkish café owner on a phone that shipped in English is the ordinary
 * case here, not the edge one.
 *
 * **Signed out on purpose**, which is why this is its own file: every other
 * spec in the suite runs with the shared `storageState`, and every auth route
 * redirects a signed-in visitor to the dashboard. `storageState: undefined`
 * is the only way to look at the front door at all.
 *
 * It also has to be a browser: the control writes a cookie through a server
 * action and the page then re-renders in the other language, which is three
 * things jsdom cannot do.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("the front door", () => {
  test("offers both languages, and switching one changes the page", async ({ page }) => {
    await page.goto("/sign-in");

    const toggle = page.getByRole("button", { name: /dil|language/i });
    await expect(toggle).toBeVisible();

    await toggle.click();
    // Both languages offered by name, not by a flag: a flag is a country.
    await expect(page.getByRole("menuitem", { name: "Türkçe" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "English" })).toBeVisible();

    await page.getByRole("menuitem", { name: "English" }).click();

    // The proof is the *page*, not the control: a toggle that highlights a
    // different option and leaves the screen alone is the bug in a costume.
    await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();

    await toggle.click();
    await page.getByRole("menuitem", { name: "Türkçe" }).click();
    await expect(page.getByRole("button", { name: /giriş yap/i })).toBeVisible();
  });
});
