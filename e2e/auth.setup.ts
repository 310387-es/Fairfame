import { test as setup, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * One account, one organization, one location, a handful of reviews.
 *
 * Built through the product's **own** endpoints rather than by writing rows,
 * for two reasons. A fixture inserted straight into Postgres can be subtly
 * unlike anything the app would ever create — a missing `sla_due_at`, a review
 * with no priority — and a browser test standing on that is testing a shape
 * that does not occur. And doing it this way means sign-up, organization
 * creation and ingestion are exercised on every run, for free, before the first
 * assertion is written.
 *
 * The account is fresh per run and named so it is recognisable in a dev
 * database; `pnpm test:e2e:clean` removes them.
 */

const STATE = "e2e/.auth/state.json";

/** Recognisable at a glance in a dev database, and easy to delete in bulk. */
export const E2E_EMAIL_DOMAIN = "e2e.revira.test";

setup("create an account with reviews to look at", async ({ page, baseURL }) => {
  const stamp = Date.now();
  // BetterAuth refuses a state-changing call with no Origin — its CSRF guard.
  // Playwright's API client sends none by default, so it is set explicitly
  // rather than worked around by reaching past the endpoint into the database.
  const headers = { origin: baseURL ?? "http://localhost:3000" };

  // `page.request`, not the standalone `request` fixture: the two keep separate
  // cookie jars, so signing in through the fixture leaves the browser context —
  // the thing whose storageState we save — still logged out.
  const api = page.request;
  const email = `e2e-${stamp}@${E2E_EMAIL_DOMAIN}`;
  const slug = `e2e-${stamp}`;

  const signUp = await api.post("/api/auth/sign-up/email", {
    headers,
    data: { email, password: `e2e-password-${stamp}`, name: "E2E Runner" },
  });
  expect(signUp.ok(), "sign-up should succeed").toBeTruthy();

  const org = await api.post("/api/auth/organization/create", {
    headers,
    data: { name: `E2E ${stamp}`, slug },
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
  await page.goto("/locations");
  // Targeted by the field's own id rather than by a visible label, so the
  // setup does not break the day somebody rewords the form in either locale.
  await page.locator("#name").fill("Kadıköy");
  await page
    .locator("form")
    .filter({ has: page.locator("#name") })
    .locator("button[type=submit]")
    .click();

  await expect(page.getByText("Kadıköy").first()).toBeVisible();

  // Connect the mock source and let it backfill. This is what gives the inbox
  // something to be tested against, and it is the product's own ingestion path
  // rather than a pile of hand-written review rows — so the reviews the browser
  // sees carry the same status, priority and SLA that real ones would.
  await page
    .getByRole("button", { name: /bağla|connect/i })
    .first()
    .click();
  await expect(page.getByRole("button", { name: /şimdi eşitle|sync now/i }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole("button", { name: /şimdi eşitle|sync now/i })
    .first()
    .click();

  // A collection campaign too, so the public review page — the one a customer
  // opens from a QR code — has a real slug to be tested against. Created
  // through the form for the same reason as the location: a hand-inserted row
  // can be a shape the product would never produce.
  await page.goto("/requests");
  await page.locator("#campaign-name").fill("E2E ziyaret sonrası");
  await page
    .locator("form")
    .filter({ has: page.locator("#campaign-name") })
    .locator("button[type=submit]")
    .click();

  // The card links to the campaign's public page by absolute URL, so match on
  // the path rather than on a leading slash.
  const slugLink = page.locator('a[href*="/c/"]').first();
  await expect(slugLink).toBeVisible();
  const campaignSlug = new URL((await slugLink.getAttribute("href"))!).pathname.split("/c/")[1]!;

  mkdirSync("e2e/.auth", { recursive: true });
  await page.context().storageState({ path: STATE });

  // Recorded so the cleanup script knows what this run created.
  writeFileSync(
    "e2e/.auth/run.json",
    JSON.stringify({ email, slug, campaignSlug, stamp }, null, 2),
  );
});
