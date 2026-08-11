import { expect, type Page } from "@playwright/test";

/**
 * Building an account the way the product does.
 *
 * Extracted from `auth.setup.ts` so a spec that must not disturb the shared
 * account can have one of its own. **Approval is global** — approving a review
 * shows it on every widget, badge and public page the organization has — so two
 * specs approving things in the same organization are not independent, and the
 * first one to run silently changes the preconditions of the second. That is
 * not a test-harness quirk to work around; it is the product's own rule (see
 * `src/widgets/approval.ts`), so the isolation belongs at the account.
 *
 * Everything goes through the product's own endpoints rather than through
 * inserted rows, for the reasons `auth.setup.ts` gives: a hand-written fixture
 * can be a shape the app would never produce, and this way sign-up,
 * organization creation and ingestion are exercised for free on every run.
 */

/** Recognisable at a glance in a dev database, and easy to delete in bulk. */
export const E2E_EMAIL_DOMAIN = "e2e.fairfame.test";

export type Account = { email: string; slug: string; stamp: number };

/**
 * Signs up, creates an organization, adds a location and ingests reviews.
 *
 * Leaves `page` signed in with that organization active, so the caller can
 * drive the UI immediately.
 */
export async function createAccount(page: Page, baseURL: string | undefined): Promise<Account> {
  // A suffix as well as the clock: two accounts created in the same millisecond
  // would collide on the organization slug, which is unique.
  const stamp = Date.now();
  const unique = `${stamp}-${Math.floor(performance.now() * 1000) % 100000}`;

  // BetterAuth refuses a state-changing call with no Origin — its CSRF guard.
  // Playwright's API client sends none by default, so it is set explicitly
  // rather than worked around by reaching past the endpoint into the database.
  const headers = { origin: baseURL ?? "http://localhost:3000" };

  // `page.request`, not the standalone `request` fixture: the two keep separate
  // cookie jars, so signing in through the fixture would leave the browser
  // context — the thing that actually loads pages — logged out.
  const api = page.request;
  const email = `e2e-${unique}@${E2E_EMAIL_DOMAIN}`;
  const slug = `e2e-${unique}`;

  const signUp = await api.post("/api/auth/sign-up/email", {
    headers,
    data: { email, password: `e2e-password-${stamp}`, name: "E2E Runner" },
  });
  expect(signUp.ok(), "sign-up should succeed").toBeTruthy();

  const org = await api.post("/api/auth/organization/create", {
    headers,
    data: { name: `E2E ${unique}`, slug },
  });
  expect(org.ok(), "organization create should succeed").toBeTruthy();

  // Creating an organization does not make it the session's active one, and
  // every authenticated screen reads the tenant from the session — so without
  // this the app correctly bounces us to "create an organization" forever.
  const created = (await org.json()) as { id: string };
  const active = await api.post("/api/auth/organization/set-active", {
    headers,
    data: { organizationId: created.id },
  });
  expect(active.ok(), "organization set-active should succeed").toBeTruthy();

  // A location, then a source connected to it. The mock connector backfills
  // reviews on its first sync, so this is also how the inbox gets something to
  // show — no hand-written review rows anywhere.
  //
  // `?dev=1` because the mock and fixture connectors are no longer offered to
  // customers (W1.4) — they are development instruments, and a suite that
  // reaches one has to say so the same way a developer does. The flag only
  // works outside production, which is the point of it.
  await page.goto("/locations?dev=1");

  // Creating opens a panel now rather than sitting on the page (W1.7). On an
  // empty account the button is *in* the empty state; once there are rows it
  // moves to the page header. Matching on the accessible name rather than the
  // position covers both, which is the point of the shared component.
  await page
    .getByRole("button", { name: /add location|şube ekle/i })
    .first()
    .click();

  // Targeted by the field's own id rather than by a visible label, so the setup
  // does not break the day somebody rewords the form in either locale.
  await page.locator("#name").fill("Kadıköy");
  await page
    .locator("form")
    .filter({ has: page.locator("#name") })
    .locator("button[type=submit]")
    .click();

  await expect(page.getByText("Kadıköy").first()).toBeVisible();

  // By the provider's own label rather than by position: the connect list is
  // sorted alphabetically, so `.first()` silently meant "whatever sorts first"
  // and would now be Google's OAuth link. "Mock source" comes from the registry
  // and is not translated, so this matches in either locale.
  await page
    .getByRole("button", { name: /mock source/i })
    .first()
    .click();

  /*
    The **first** source now lands on `/welcome` (positioning win 2).

    That is the digest-first onboarding working, and it is exactly what a new
    customer should get: reviews exist, nothing has read them, so the next
    screen composes the briefing rather than showing an empty dashboard. It
    also means this setup can no longer assume it is still on `/locations`.

    The setup waits for it and then leaves. Waiting is not politeness — it is
    the only deterministic signal that the connect action finished, and the
    first attempt at this raced: `waitForURL(/welcome|locations/)` matched
    `/locations` instantly, because that is where the click happened, and the
    client-side redirect then replaced the page a moment after the `goto`.

    Every test below wants an account with reviews rather than a briefing, so
    the setup navigates straight off. One analysis batch may already be in
    flight by then, which is the price of the screen doing its job.
  */
  await page.waitForURL(/\/welcome/, { timeout: 20_000 });
  await page.goto("/locations");

  /*
    Expand the row.

    Arriving fresh rather than staying put means the branch is collapsed — W4.2
    opens a row by itself only when it has *no* sources, and it now has one.
    The connect click used to leave it open, which is why this line was not
    needed before and is now.
  */
  await page
    .getByRole("button", { name: /ayrıntılarını göster|show .* details/i })
    .first()
    .click();

  await expect(page.getByRole("button", { name: /şimdi eşitle|sync now/i }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole("button", { name: /şimdi eşitle|sync now/i })
    .first()
    .click();

  return { email, slug, stamp };
}
