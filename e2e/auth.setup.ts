import { test as setup, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createAccount } from "./account";

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
 *
 * The account-building itself lives in `./account.ts`, because one spec needs a
 * second, isolated one — display approval is organization-wide, so a spec that
 * approves reviews changes what every other spec sees.
 */

const STATE = "e2e/.auth/state.json";

export { E2E_EMAIL_DOMAIN } from "./account";

setup("create an account with reviews to look at", async ({ page, baseURL }) => {
  const { email, slug, stamp } = await createAccount(page, baseURL);

  // A collection campaign too, so the public review page — the one a customer
  // opens from a QR code — has a real slug to be tested against. Created
  // through the form for the same reason as the location: a hand-inserted row
  // can be a shape the product would never produce.
  await page.goto("/requests");
  // Behind the create panel now (W1.7), same as the location above.
  await page
    .getByRole("button", { name: /new campaign|yeni kampanya/i })
    .first()
    .click();
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
