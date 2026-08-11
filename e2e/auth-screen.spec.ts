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

/**
 * "Continue with Google" (P5-T1).
 *
 * **The invariant is that the button and the endpoint agree**, in whichever
 * state this deployment happens to be. That is the actual rule —
 * `isGoogleAuthConfigured` is the single reader of both credentials, so the
 * screen drawing a button the server will not honour, or refusing to draw one
 * the server would, is the only way this can be wrong. A drawn button over an
 * unregistered provider is a 500 on the front door; an undrawn one over a
 * registered provider is a feature nobody can reach.
 *
 * **It deliberately does not read `process.env`, and the first version did.**
 * Playwright's runner does not load `.env` — only the dev server it drives
 * does — so the spec was comparing the browser's state against a *different
 * process's* environment. It passed for as long as both happened to be empty
 * and went red the moment a real client was configured, reporting a broken
 * feature that worked perfectly. Asking the running app both questions is the
 * only way to compare like with like.
 */
test.describe("signing in with Google", () => {
  const button = /continue with google|google ile devam et/i;

  for (const path of ["/sign-in", "/sign-up"]) {
    test(`${path} offers Google exactly when the server will honour it`, async ({
      page,
      baseURL,
    }) => {
      await page.goto(path);

      const drawn = (await page.getByRole("button", { name: button }).count()) > 0;

      // What the server thinks. A registered provider hands back an
      // accounts.google.com URL to redirect to; an unregistered one refuses.
      const response = await page.request.post("/api/auth/sign-in/social", {
        headers: { origin: baseURL ?? "http://localhost:3000" },
        data: { provider: "google", callbackURL: "/dashboard" },
        failOnStatusCode: false,
      });
      const registered =
        response.ok() &&
        String(((await response.json()) as { url?: string }).url ?? "").includes(
          "accounts.google.com",
        );

      expect(drawn, "the button and the provider registration must agree").toBe(registered);

      if (drawn) {
        // Above the fields, which is the whole positioning decision: the target
        // customer owns a Google account by definition.
        const googleBox = await page.getByRole("button", { name: button }).boundingBox();
        const emailBox = await page.locator("#email").boundingBox();
        expect(googleBox!.y, "Google should sit above the email field").toBeLessThan(emailBox!.y);
      } else {
        // The part that matters when it is absent: a working password form
        // beside the absence, rather than a broken screen.
        await expect(page.locator("#email")).toBeVisible();
      }
    });
  }
});

/**
 * Consent at the point of collection (P5-T2).
 *
 * On **both** screens, because "Continue with Google" creates accounts too — an
 * OAuth arrival with no matching user is a signup wearing a sign-in button, and
 * a notice that appeared only on `/sign-up` would miss whoever came in through
 * the other door.
 */
test.describe("what you are agreeing to", () => {
  const OPENERS = [/terms of service|kullanım koşulları/i, /kvkk|aydınlatma/i];

  for (const path of ["/sign-in", "/sign-up"]) {
    test(`offers the terms and the KVKK notice from ${path}`, async ({ page }) => {
      await page.goto(path);

      for (const name of OPENERS) {
        await expect(page.getByRole("button", { name })).toBeVisible();
      }
    });

    /**
     * **The whole point of the modal**, asserted as the thing that used to
     * break: reading the notice must not cost you the form.
     *
     * Both openers were links, so a visitor half way through signing up who
     * checked what they were agreeing to lost their name, their email and their
     * password. This types into the form first *specifically* so that the
     * assertion afterwards is about the typing surviving, not merely about a
     * dialog appearing.
     */
    test(`reading the notice from ${path} keeps what was typed`, async ({ page }) => {
      await page.goto(path);

      const email = page.locator("#email");
      await email.fill("typed@e2e.fairfame.test");

      await page.getByRole("button", { name: OPENERS[0]! }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      // The document itself, not an empty shell — the modal renders the same
      // `LegalDocument` the page does.
      await expect(dialog.getByText(/the service|hizmet/i).first()).toBeVisible();

      // Still on the auth screen, and the field still holds what was typed.
      expect(new URL(page.url()).pathname).toBe(path);

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(email).toHaveValue("typed@e2e.fairfame.test");
    });
  }

  test("the notice says it is a draft, in the modal itself", async ({ page }) => {
    /**
     * The draft status has to be *in* the dialog, because there is nowhere else
     * for it to be — the standalone `/legal/*` pages were removed on 11 Aug 2026
     * and the modal is now the only place this text is read.
     *
     * `taslağ` as well as `taslak`, and it is not a typo: Turkish softens a
     * final `k` to `ğ` before a vowel suffix, so the notice reads "çalışma
     * **taslağ**ıdır" and the dictionary form never appears as a substring. A
     * matcher written from the English habit of stems-staying-put passes in one
     * language and fails in the other — which is exactly what an earlier one did.
     */
    await page.goto("/sign-up");

    for (const opener of OPENERS) {
      await page.getByRole("button", { name: opener }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/taslak|taslağ|draft/i).first()).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  });
});

/**
 * The marketing checkbox (P5-T2).
 *
 * Two separate claims, and the second is the one worth a browser: that the tick
 * actually reaches the database. A checkbox that renders, ticks and records
 * nothing is worse than no checkbox, because the screen tells the person it was
 * recorded.
 */
test.describe("the optional marketing consent", () => {
  test("starts unticked", async ({ page }) => {
    await page.goto("/sign-up");

    const box = page.getByRole("checkbox", { name: /fairfame/i });
    await expect(box).toBeVisible();

    // Unticked is the requirement, not a default. A pre-ticked box is a click,
    // not a consent, and it is the shape that makes a mailing list unlawful.
    await expect(box).not.toBeChecked();
  });

  test("is separate from accepting the terms", async ({ page }) => {
    await page.goto("/sign-up");

    // Exactly one checkbox on the screen. Accepting the terms is a condition of
    // having an account and is stated, not ticked — bundling the two would make
    // it impossible to tell which half was agreed to.
    await expect(page.getByRole("checkbox")).toHaveCount(1);
  });

  test("persists when it is ticked, and stays false when it is not", async ({ page, baseURL }) => {
    const headers = { origin: baseURL ?? "http://localhost:3000" };

    for (const consented of [true, false]) {
      const unique = `${Date.now()}-${Math.floor(performance.now() * 1000) % 100000}-${consented}`;
      const email = `e2e-consent-${unique}@e2e.fairfame.test`;

      const signUp = await page.request.post("/api/auth/sign-up/email", {
        headers,
        data: {
          email,
          password: `e2e-password-${unique}`,
          name: "Consent Runner",
          marketingEmailConsent: consented,
        },
      });
      expect(signUp.ok(), "sign-up should succeed").toBeTruthy();

      const session = await page.request.get("/api/auth/get-session");
      const body = (await session.json()) as {
        user: { marketingEmailConsent?: boolean; marketingEmailConsentAt?: string | null };
      };

      expect(body.user.marketingEmailConsent, `consent ${consented} should round-trip`).toBe(
        consented,
      );

      /**
       * And the date is stamped only alongside a true flag.
       *
       * The timestamp is the evidence half of the record and is written
       * server-side from the clock — a date the subject could choose is not
       * evidence. The database refuses the contradictory shape outright
       * (`users_marketing_consent_dated`), so this is the readable statement of
       * a rule that is already enforced one layer down.
       */
      if (consented) {
        expect(body.user.marketingEmailConsentAt).toBeTruthy();
      } else {
        expect(body.user.marketingEmailConsentAt ?? null).toBeNull();
      }

      await page.request.post("/api/auth/sign-out", { headers });
    }
  });
});

/**
 * The legal modal on a phone (11 Aug 2026).
 *
 * Its own `describe` so it can override the viewport without changing the rest
 * of the file. A modal is the one overlay that can trap somebody: too tall for
 * the screen and the close button goes off the bottom with the document, and
 * the page behind is inert, so there is nothing left to press. That is the
 * failure this measures — not that it looks right, but that it can be left.
 */
test.describe("the legal modal on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("fits the viewport and keeps its close control reachable", async ({ page }) => {
    await page.goto("/sign-up");
    await page.getByRole("button", { name: /terms of service|kullanım koşulları/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const box = (await dialog.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeLessThanOrEqual(844);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);

    // The body scrolls, not the page: a modal that makes the document behind it
    // scroll sideways is one somebody can lose.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "no horizontal overflow").toBeLessThanOrEqual(1);

    await expect(dialog.getByRole("button", { name: /close|kapat/i })).toBeInViewport();
  });
});

/**
 * The sample plan opens in a new tab (11 Aug 2026).
 *
 * Same argument as the legal modal, and the same failure it fixes: this link
 * sits beside a half-filled signup form, so following it in place threw away
 * the name, the email and the password of anybody curious enough to check what
 * they were signing up for — punishing the one visitor the panel is written
 * for.
 *
 * The assertion is the *tab*, not the attribute. `target="_blank"` in the DOM
 * is what a source grep would prove; that a second tab actually opens and the
 * first one still holds what was typed is the behaviour, and it is the only
 * thing a reader of this test cares about.
 */
test.describe("the sample plan link", () => {
  test("opens beside the form rather than replacing it", async ({ page, context }) => {
    await page.goto("/sign-up");

    const name = page.locator("#name");
    await name.fill("Kept across tabs");

    const link = page.getByRole("link", { name: /sample weekly plan|örnek bir haftalık plan/i });
    await expect(link).toBeVisible();

    const [opened] = await Promise.all([context.waitForEvent("page"), link.click()]);
    await opened.waitForLoadState("domcontentloaded");

    expect(new URL(opened.url()).pathname).toBe("/sample");
    await opened.close();

    // The form is untouched, which is the whole point.
    expect(new URL(page.url()).pathname).toBe("/sign-up");
    await expect(name).toHaveValue("Kept across tabs");
  });

  test("says so, for somebody who cannot see the icon", async ({ page }) => {
    // The external-link glyph is `aria-hidden`, so without the suffix a screen
    // reader announces a link that silently steals the tab.
    await page.goto("/sign-up");

    await expect(
      page.getByRole("link", { name: /opens in a new tab|yeni sekmede açılır/i }),
    ).toBeVisible();
  });
});
