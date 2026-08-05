import { expect, test, type Page } from "@playwright/test";
import { createAccount } from "./account";

/**
 * The hosted review page, end to end (P3-T3).
 *
 * The Definition of Done is a page that "renders with valid `LocalBusiness`
 * structured data, is indexable, and shows only approved reviews", and only two
 * of those three can be checked from source. **Indexable** is a property of the
 * response a crawler receives — the meta tag, the canonical link, the JSON-LD
 * that has to survive React's rendering and the framework's head handling — and
 * `robots.txt` and `sitemap.xml` are files that either exist at the right path
 * or do not.
 *
 * So this walks it from the business's side: publish the page from `/locations`,
 * follow the link the product gives you, and read what a stranger gets.
 *
 * The tenancy half is in `tests/db/seo-pages.test.ts`, where a second
 * organization can be created to leak *from*. This is about the document.
 *
 * **On its own account, deliberately.** This spec has to approve a review to
 * have anything to publish, and display approval is organization-wide — so
 * sharing the suite's account would silently hand `widgets.spec.ts` an
 * organization where everything is already approved, breaking its "nothing is
 * approved yet, so the widget says so" precondition. That is the product's own
 * rule leaking into the harness, and the honest place to absorb it is here.
 */

const APPROVE_ALL = /onayla|approve all/i;
const PUBLISH_PAGE = /sayfayı yayımla|publish page/i;

test.describe("a hosted review page", () => {
  test("is published from Locations, and is indexable when it gets there", async ({
    browser,
    baseURL,
  }) => {
    // `storageState: undefined` overrides the project's signed-in state: this
    // context starts with no cookies and builds its own organization.
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    try {
      await createAccount(page, baseURL);
      await runPublishFlow(page);
    } finally {
      await context.close();
    }
  });

  test("tells crawlers where to look, and where not to", async ({ page }) => {
    const robots = await page.request.get("/robots.txt");
    expect(robots.ok()).toBeTruthy();

    const body = await robots.text();
    // The one that would do real damage if crawled: a one-click unsubscribe.
    expect(body).toContain("Disallow: /u/");
    expect(body).toContain("Disallow: /embed/");
    expect(body).toContain("Sitemap:");

    const sitemap = await page.request.get("/sitemap.xml");
    expect(sitemap.ok()).toBeTruthy();
    expect(await sitemap.text()).toContain("/reviews/");
  });
});

async function runPublishFlow(page: Page) {
  // --- Approve something, or the page would be honest but empty ----------
  await page.goto("/widgets");
  await page.locator("#widget-name").fill("E2E sayfa");
  await page
    .locator("form")
    .filter({ has: page.locator("#widget-name") })
    .getByRole("button", { name: /oluştur|create/i })
    .click();
  await expect(page).toHaveURL(/\/widgets\/[0-9a-f-]{36}$/);

  const approveAll = page.getByRole("button", { name: APPROVE_ALL });
  if (await approveAll.isVisible()) await approveAll.click();
  await expect(page.locator('[id^="approve-"]').first()).toBeChecked();

  // --- Publish the page --------------------------------------------------
  await page.goto("/locations");

  const publish = page.getByRole("button", { name: PUBLISH_PAGE }).first();
  await expect(publish).toBeVisible();
  await publish.click();

  // The URL appears only once the page is live, which is the point of showing
  // it: before that there is nothing to copy.
  const url = page.locator("text=/\\/reviews\\//").first();
  await expect(url).toBeVisible();

  const href = (await url.textContent())!.trim();
  const path = new URL(href).pathname;
  expect(path).toMatch(/^\/reviews\/[a-z0-9-]+$/);

  // --- What a stranger gets ----------------------------------------------
  await page.goto(path);

  // An approved review is on it, and the business's name is the heading.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("article").first()).toBeVisible();

  /**
   * Indexable, stated rather than assumed.
   *
   * Every other public route in this product says `noindex`, so the absence
   * of that tag is not evidence of anything — a page that forgot to render
   * metadata at all would look identical. What is asserted is the canonical
   * link, which only the intended path emits.
   */
  await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", href);

  // --- The structured data, as a crawler would parse it -------------------
  const jsonLd = await page.locator('script[type="application/ld+json"]').textContent();
  expect(jsonLd, "the page should carry structured data").toBeTruthy();

  const parsed = JSON.parse(jsonLd!) as Record<string, unknown>;
  expect(parsed["@type"]).toBe("LocalBusiness");
  expect(parsed["@id"]).toBe(href);

  // The P3-T3 amendment, checked on the rendered page rather than only on the
  // function that builds it: no review or rating claim, ever.
  expect(Object.keys(parsed).join(" ")).not.toMatch(/rating|review/i);

  /**
   * And it fits a phone.
   *
   * `docs/19` asks for mobile-first and `docs/18` records that layout is one of
   * the two things a unit test structurally cannot reach — jsdom has no layout
   * engine, so "does anything hang off the side at 390px" is unanswerable
   * there. It matters more here than on an in-app screen: this is the page a
   * stranger lands on from a search result, on a phone, having never seen the
   * product.
   */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    // Named, so a failure says which element rather than only that one exists.
    culprits: [...document.querySelectorAll("main *")]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 3)
      .map((el) => el.tagName + "." + el.className),
  }));

  expect(overflow.culprits).toEqual([]);
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.viewport);
}
