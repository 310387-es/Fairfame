import { test, expect } from "@playwright/test";
import { createAccount } from "./account";

/**
 * An unverified account can work, and cannot write to strangers (P5-T4).
 *
 * **Its own account, deliberately unverified.** `auth.setup.ts` confirms the
 * shared account's address through the real link, because every other spec
 * wants an ordinary workspace; this one wants the state that account is no
 * longer in. Building a second one is the same isolation argument
 * `e2e/account.ts` already makes about display approval — a spec that needs
 * different preconditions owns them rather than mutating everybody else's.
 *
 * The refusal is asserted in the **browser** rather than against the action,
 * because the thing being checked is not that the server throws — that is
 * covered in `tests/db/verification-gate.test.ts` — but that a person who runs
 * into this is told what happened and handed the way out. A rule enforced
 * server-side and reported as a shrug is a rule that generates support tickets.
 */
test.describe("an account that has not confirmed its address", () => {
  // A full account build, and then a send attempt.
  test.setTimeout(120_000);

  test("is told what is waiting, and offered the email again", async ({ page, baseURL }) => {
    await createAccount(page, baseURL);

    await page.goto("/dashboard");

    /**
     * The banner, before anything is attempted.
     *
     * This is the half a toast cannot do. A refusal that only arrives after a
     * campaign has been written and the button pressed teaches somebody the
     * rule at the most expensive possible moment.
     */
    const banner = page.getByText(/confirm your email|e-posta adresinizi doğrulayın/i).first();
    await expect(banner).toBeVisible();

    // And it names what is blocked rather than issuing a bare instruction —
    // which is also what tells everyone else they can ignore it.
    await expect(page.getByText(/review invitations|yorum daveti/i).first()).toBeVisible();

    // The way out is attached to the refusal.
    const resend = page.getByRole("button", { name: /send the email again|yeniden gönder/i });
    await expect(resend).toBeVisible();
    await resend.click();
    await expect(page.getByText(/sent\.|gönderildi/i).first()).toBeVisible();
  });

  test("is refused, by name, when it tries to send review requests", async ({ page, baseURL }) => {
    await createAccount(page, baseURL);

    /**
     * A campaign of its own, because `createAccount` does not build one.
     *
     * The shared setup creates one *after* calling `createAccount` — it belongs
     * to `auth.setup.ts`, not to the account helper — so an account built here
     * lands on "Henüz kampanya yok" and there is nothing to send from. Created
     * through the form for the same reason everything else here is: a
     * hand-inserted row can be a shape the product would never produce.
     */
    await page.goto("/get-reviews");
    await page
      .getByRole("button", { name: /new campaign|yeni kampanya/i })
      .first()
      .click();
    await page.locator("#campaign-name").fill("E2E doğrulama kontrolü");
    await page
      .locator("form")
      .filter({ has: page.locator("#campaign-name") })
      .locator("button[type=submit]")
      .click();

    /**
     * Then the send box, driven exactly as an owner would.
     *
     * By `name` rather than by `id`: `RecipientPicker` suffixes its ids with the
     * campaign's uuid so two cards on one screen cannot collide, which makes the
     * id unguessable from here and the form field name the stable handle. The
     * paste box is on screen already — there is no control to open first.
     */
    const recipients = page.locator('textarea[name="recipients"]');
    await expect(recipients).toBeVisible();
    await recipients.fill("musteri@e2e.fairfame.test");

    await page.locator("form").filter({ has: recipients }).locator("button[type=submit]").click();

    /**
     * A named reason, not "something went wrong".
     *
     * Matched on the substance of the sentence rather than the whole string:
     * what must survive a rewording is that the reader is told the problem is
     * their *own address*. `.last()` because the banner at the top of every
     * screen says something similar — the toast is the one this test is about,
     * and it is the later match in the DOM.
     */
    await expect(
      page.getByText(/confirm your email|e-posta adresinizi doğrulayın/i).last(),
    ).toBeVisible();
  });
});
