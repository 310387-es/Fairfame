/**
 * Captures the product screenshots the landing page shows.
 *
 * **Why this exists rather than reusing the e2e fixture.** The browser suite
 * builds an account called "E2E Runner" in an organization called "E2E
 * 1754…", which is exactly right for a test database and exactly wrong on a
 * marketing page: the product's own chrome would introduce the product as a
 * test run. Renaming the fixture to suit marketing would couple the test suite
 * to the sales page, so this is its own script.
 *
 * **The account is the café the landing page already talks about.** The
 * briefing on `/` is composed over `Kahve Molası · Moda` (see
 * `src/digest/sample-data.ts`), so the screenshot beneath it shows the same
 * fictional business rather than a second invented one. Nothing here is a real
 * customer, and the reviews come from the mock connector.
 *
 * Everything goes through the product's own endpoints — sign-up, organization,
 * location, connect — for the reason `e2e/account.ts` gives: a hand-inserted
 * row can be a shape the app would never produce, and a screenshot of an
 * impossible state is worse than no screenshot.
 *
 * Run against a dev server: `pnpm marketing:shots`. Writes to
 * `public/marketing/`. The account it creates carries the e2e email domain, so
 * `pnpm test:e2e:clean` removes it along with the suite's own.
 */

import { chromium, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.MARKETING_SHOTS_URL ?? "http://localhost:3000";
const OUT = "public/marketing";

/** Matches `e2e/account.ts`, so the existing cleanup script finds this too. */
const EMAIL_DOMAIN = "e2e.revira.test";

/** The business the landing page's briefing is already about. */
const BUSINESS = "Kahve Molası";
const BRANCH = "Moda";
const OWNER = "Deniz Yılmaz";

async function build(page: Page): Promise<void> {
  const unique = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const headers = { origin: BASE };
  const api = page.request;

  const signUp = await api.post("/api/auth/sign-up/email", {
    headers,
    data: {
      email: `marketing-${unique}@${EMAIL_DOMAIN}`,
      password: `marketing-password-${unique}`,
      name: OWNER,
    },
  });
  if (!signUp.ok()) throw new Error(`sign-up failed: ${signUp.status()}`);

  const org = await api.post("/api/auth/organization/create", {
    headers,
    data: { name: BUSINESS, slug: `kahve-molasi-${unique}` },
  });
  if (!org.ok()) throw new Error(`organization create failed: ${org.status()}`);

  const { id } = (await org.json()) as { id: string };
  const active = await api.post("/api/auth/organization/set-active", {
    headers,
    data: { organizationId: id },
  });
  if (!active.ok()) throw new Error(`set-active failed: ${active.status()}`);

  // `?dev=1` because the mock connector is a development instrument and is not
  // offered to customers (W1.4).
  await page.goto(`${BASE}/locations?dev=1`);
  await page
    .getByRole("button", { name: /add location|şube ekle/i })
    .first()
    .click();
  await page.locator("#name").fill(BRANCH);
  await page
    .locator("form")
    .filter({ has: page.locator("#name") })
    .locator("button[type=submit]")
    .click();
  await page.getByText(BRANCH).first().waitFor();

  await page
    .getByRole("button", { name: /mock source/i })
    .first()
    .click();

  // The first source lands on `/welcome`, which composes the first briefing.
  // Waiting for it is the only deterministic signal that the connect finished.
  await page.waitForURL(/\/welcome/, { timeout: 30_000 });
}

const browser = await chromium.launch();
const context = await browser.newContext({
  // Relative paths in `page.request` resolve against this; without it every
  // API call throws "Invalid URL". The e2e suite gets it from playwright.config.
  baseURL: BASE,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

try {
  await build(page);
  mkdirSync(OUT, { recursive: true });

  for (const [route, name] of [["/reviews", "reviews"]] as const) {
    await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
    // Analysis runs in the background after ingest; give it a moment so the
    // queue is populated rather than mid-backfill.
    await page.waitForTimeout(2500);
    if (page.url().includes("sign-in")) throw new Error(`${route} bounced to sign-in`);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`captured ${OUT}/${name}.png`);
  }
} finally {
  await context.close();
  await browser.close();
}
