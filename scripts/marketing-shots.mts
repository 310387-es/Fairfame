/**
 * Captures real product screenshots for the places that show one.
 *
 * **The landing page is no longer one of them** (11 Aug 2026). `/` draws its
 * own product windows instead — `components/marketing/flow-tour.tsx` and
 * `pillars.tsx` both say why: a screenshot goes stale silently and has to be
 * re-shot per locale, while a drawn window is translated by the same message
 * catalogue as the app. What still shows a genuine capture is the **README**,
 * whose header is `public/marketing/reviews.png`.
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
const EMAIL_DOMAIN = "e2e.fairfame.test";

/** The business the landing page's briefing is already about. */
const BUSINESS = "Kahve Molası";
const BRANCH = "Moda";
const OWNER = "Deniz Yılmaz";

/**
 * What gets captured, and why each one.
 *
 * The queue is the daily loop, and it is the one the README header shows.
 * Analytics and Get reviews are captured but displayed nowhere today — kept
 * because they cost one page visit each on a run that is already signing up an
 * account, and they are what a doc or a post reaches for. **Anything written
 * here that nothing displays is a spare, not an asset**: leave it out of the
 * repo unless a page actually points at it, or it becomes 300KB of binary
 * nobody can tell is dead.
 */
const ROUTES = [
  { route: "/reviews", name: "reviews", needsAnalysis: false },
  { route: "/get-reviews", name: "get-reviews", needsAnalysis: false },
  { route: "/analytics", name: "analytics", needsAnalysis: true },
] as const;

async function build(page: Page): Promise<boolean> {
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
  await page.waitForURL(/\/welcome/, { timeout: 30_000 });

  /*
    Let onboarding finish, rather than navigating away from it.

    `e2e/account.ts` deliberately leaves `/welcome` immediately, because the
    browser suite wants an account with reviews rather than a briefing. This
    script wants the opposite: Analytics, the weekly plan and the theme tables
    are all empty until the reviews have been *analysed*, and the first capture
    run produced exactly that — "10 tanesi henüz analiz edilmedi", a blank
    sentiment chart and "Henüz tema yok" on a marketing screenshot.

    The screen redirects to `/weekly-plan/{id}` the moment analysis completes,
    so that URL is the signal. Generous timeout: this is real model work over
    real reviews, which is the point.
  */
  let analysed = false;
  try {
    await page.waitForURL(/\/weekly-plan\//, { timeout: 240_000 });
    analysed = true;
  } catch {
    /*
      Degrade, do not fail.

      Analysis is real model work, and the model is a third party with a daily
      quota. When it is exhausted the reviews still ingest and most of the
      product still works — so the run captures everything that does not depend
      on analysis and skips what does, rather than throwing away three good
      screenshots because one screen needs a provider that is down. A stale
      asset is worse than a missing one only if nobody is told; the caller is.
    */
    console.warn(
      "! analysis did not finish (model quota or provider error) — skipping analysis-dependent shots",
    );
  }

  /*
    A collection campaign, so `/get-reviews` is a working screen rather than its
    empty state. The first capture run photographed "Henüz kampanya yok" and
    would have shipped it: an empty state is an honest picture of an account
    nobody has used, and a dishonest picture of the product.
  */
  await page.goto(`${BASE}/get-reviews`);
  await page
    .getByRole("button", { name: /new campaign|yeni kampanya/i })
    .first()
    .click();
  await page.locator("#campaign-name").fill("Ziyaret sonrası");
  await page
    .locator("form")
    .filter({ has: page.locator("#campaign-name") })
    .locator("button[type=submit]")
    .click();
  await page.locator('a[href*="/c/"]').first().waitFor({ timeout: 15_000 });

  return analysed;
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
  const analysed = await build(page);
  mkdirSync(OUT, { recursive: true });

  for (const { route, name, needsAnalysis } of ROUTES) {
    if (needsAnalysis && !analysed) {
      console.warn(`- skipped ${name}: needs analysed reviews`);
      continue;
    }
    await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
    // Analysis runs in the background after ingest; give it a moment so the
    // screen is populated rather than mid-backfill.
    await page.waitForTimeout(3000);
    if (page.url().includes("sign-in")) throw new Error(`${route} bounced to sign-in`);

    /*
      Assert, do not hope.

      The first run of this script shipped a screen reading "10 tanesi henüz
      analiz edilmedi" with a blank chart, confidently. A capture script that
      cannot fail produces bad assets quietly, so each shot proves it shows a
      working product before it is written to disk.

      The trial badge in the rail is deliberately *not* checked. It is true —
      the account really is on a trial, and the page advertises a 14-day trial
      two screens further down. Hiding it was three failed attempts of
      gold-plating for something that is merely unflattering, not misleading.
    */
    const bad = await page.evaluate(() => {
      const text = document.body.innerText;
      const problems: string[] = [];
      if (/henüz analiz edilmedi|not yet analysed/i.test(text)) problems.push("reviews unanalysed");
      if (/Henüz tema yok|No themes yet/i.test(text)) problems.push("no themes");
      return problems;
    });
    if (bad.length > 0) throw new Error(`${route}: ${bad.join(", ")}`);

    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`captured ${OUT}/${name}.png`);
  }
} finally {
  await context.close();
  await browser.close();
}
