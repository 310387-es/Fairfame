import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "@playwright/test";

/**
 * The widget builder, end to end (P3-T1).
 *
 * The Definition of Done is "a user builds a widget in-app and it renders their
 * reviews on an external page", and that sentence spans a browser, two
 * origins-worth of routes and a database gate. There is no unit test that can
 * assert it: the preview is an iframe, the approval flow is a round trip, and
 * the payoff is a document served by a *different* route from the one the
 * builder lives on.
 *
 * So this walks it. Sign-up, organization, location, connected source and
 * ingested reviews all come from `auth.setup.ts`, which builds them through the
 * product's own endpoints — nothing here stands on hand-written rows.
 *
 * The assertion that matters most is the last one: an unapproved review must
 * not appear in the public document, checked against the real endpoint rather
 * than against the builder's own idea of what it approved.
 */

/** Either locale — the suite does not care which language the account is in. */
const CREATE = /oluştur|create/i;
const PUBLISH = /^(yayına al|publish)$/i;
const APPROVE_ALL = /onayla|approve all/i;

test.describe("building a widget", () => {
  test("creates, approves, publishes, and serves only approved reviews", async ({ page }) => {
    await page.goto("/widgets");

    // --- Create ------------------------------------------------------------
    await page.locator("#widget-name").fill("E2E vitrin");
    await page
      .locator("form")
      .filter({ has: page.locator("#widget-name") })
      .getByRole("button", { name: CREATE })
      .click();

    // Creating drops you into the builder rather than back onto the list.
    await expect(page).toHaveURL(/\/widgets\/[0-9a-f-]{36}$/);

    // --- The preview is a real render, not a mock --------------------------
    const preview = page.frameLocator('iframe[src*="/preview"]');
    // The frame's own root element, which only the widget renderer produces.
    await expect(preview.locator(".rvw")).toBeVisible();

    // --- Approve -----------------------------------------------------------
    // Nothing is approved yet, so the widget is empty and says so rather than
    // showing a spinner or a zero.
    await expect(preview.locator(".rvw-empty")).toBeVisible();

    const approveAll = page.getByRole("button", { name: APPROVE_ALL });
    await expect(approveAll).toBeVisible();
    await approveAll.click();

    // Everything matching is approved, so there is nothing left to approve.
    await expect(page.getByRole("button", { name: APPROVE_ALL })).toBeHidden();

    /**
     * And the preview catches up **without a reload**.
     *
     * This is a regression test for a shipped bug: the preview iframe's `src`
     * was derived from the widget's settings alone, and approving a review
     * changes what the widget renders without changing any setting — so the
     * frame sat on the "nothing approved yet" empty state while the list behind
     * it said everything was approved. Reloading the page hid it, which is why
     * it survived the first manual check.
     */
    await expect(preview.locator(".rvw-card").first()).toBeVisible();
    await expect(preview.locator(".rvw-empty")).toBeHidden();

    // --- Publish -----------------------------------------------------------
    await page.getByRole("button", { name: PUBLISH }).click();
    await expect(page.getByRole("button", { name: /yayından kaldır|unpublish/i })).toBeVisible();

    // --- The embed snippet -------------------------------------------------
    const snippet = await page.locator("pre code").first().textContent();
    expect(snippet).toContain("/embed/widget.js");

    const key = snippet?.match(/data-revira-widget="([a-z0-9]{24})"/)?.[1];
    expect(key, "the snippet should carry a public key").toBeTruthy();

    // --- What the public actually gets -------------------------------------
    // A separate route, no session involved. This is the page a stranger loads.
    const builderUrl = page.url();
    await page.goto(`/embed/w/${key}`);
    await expect(page.locator(".rvw-card").first()).toBeVisible();

    /**
     * The published payload, read past the browser cache.
     *
     * `Cache-Control: no-cache` is not decoration here: the embed endpoints are
     * deliberately cacheable for a minute in the browser and five at a CDN, so
     * a plain re-fetch would compare a fresh answer against a stored one and
     * report success no matter what the database says. (That staleness is a
     * real product property, not a test artefact — a withdrawal takes up to the
     * cache window to reach a visitor who has already loaded the page.)
     */
    const publicReviews = async (): Promise<string[]> => {
      const response = await page.request.get(`/api/public/widgets/${key}`, {
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { reviews: { id: string }[] };
      return body.reviews.map((review) => review.id);
    };

    const before = await publicReviews();
    expect(before.length).toBeGreaterThan(0);

    // Withdraw one, and watch that *specific* review leave. Deliberately not a
    // length check: a widget shows a fixed number of reviews, so withdrawing
    // one from an account with more than that many approved simply promotes the
    // next — the count stays put while the content changes, and a length
    // assertion would pass for a withdrawal that silently did nothing.
    await page.goto(builderUrl);
    // By id prefix, not `getByRole("checkbox").first()`: the settings panel's
    // own toggles ("Reviewer name", "Date") come earlier in the DOM, and the
    // loose selector silently unchecked one of those instead.
    const firstCheckbox = page.locator('[id^="approve-"]').first();
    await expect(firstCheckbox).toBeChecked();

    const withdrawn = (await firstCheckbox.getAttribute("id"))!.replace("approve-", "");
    expect(before, "the newest approved review should be on display").toContain(withdrawn);

    await firstCheckbox.uncheck();
    await expect(firstCheckbox).not.toBeChecked();

    // Polled, not read once. The tick is optimistic — it moves before the
    // server has answered, which is the point of it — so a single fetch here
    // would be racing the write it is meant to be checking.
    await expect
      .poll(publicReviews, { message: "the withdrawn review should leave the public payload" })
      .not.toContain(withdrawn);
  });

  test("the preview shows content and nothing else, in every layout", async ({ page }) => {
    /**
     * Two defects that only a real viewport can see, both reported from the
     * carousel:
     *
     *   1. The preview was a fixed 520px box, so a short widget — a one-row
     *      carousel is about 255px — sat above a slab of dead space. Not even
     *      reliably blank: the frame document is transparent on purpose so a
     *      real embed blends into a customer's page, so what showed through was
     *      the browser's own canvas, black for anyone in dark mode.
     *   2. The *document* scrolled sideways, not just the carousel row. With
     *      nine implicit grid columns the cards reach ~2440px and were still
     *      counted in the document's scrollable area, so the widget had two
     *      horizontal scrollbars. On a customer's phone that drags their whole
     *      page sideways.
     *
     * Neither is visible to a unit test: one is layout, the other is scroll
     * geometry.
     */
    await page.goto("/widgets");
    await page.locator("#widget-name").fill("E2E yerleşim");
    await page
      .locator("form")
      .filter({ has: page.locator("#widget-name") })
      .getByRole("button", { name: CREATE })
      .click();
    await expect(page).toHaveURL(/\/widgets\/[0-9a-f-]{36}$/);
    await page.getByRole("button", { name: APPROVE_ALL }).click();
    await expect(page.getByRole("button", { name: APPROVE_ALL })).toBeHidden();

    const measure = () =>
      page.evaluate(() => {
        const frame = document.querySelector('iframe[src*="/preview"]') as HTMLIFrameElement;
        const doc = frame.contentDocument!;
        const win = frame.contentWindow!;

        // Whether it *can* scroll, not what some property reports: only an
        // attempted scroll distinguishes a real overflow from a stale metric.
        win.scrollTo(300, 0);
        const scrolled = win.scrollX;
        win.scrollTo(0, 0);

        const row = doc.querySelector("ul");
        return {
          scrolled,
          rowScrolls: row ? row.scrollWidth > row.clientWidth : false,
          frameHeight: Math.round(frame.getBoundingClientRect().height),
          contentHeight: Math.round(
            (doc.querySelector(".rvw") as HTMLElement).getBoundingClientRect().height,
          ),
        };
      });

    for (const layout of [/kaydırmalı|carousel/i, /izgara|^grid$/i, /liste|^list$/i]) {
      await page.locator("#w-layout").click();
      await page.getByRole("option", { name: layout }).click();

      await expect
        .poll(measure, { message: `layout ${layout} should hug its content` })
        .toMatchObject({ scrolled: 0 });

      const { frameHeight, contentHeight } = await measure();
      // Within a pixel: the frame is sized from a rounded measurement.
      expect(Math.abs(frameHeight - contentHeight)).toBeLessThanOrEqual(2);
    }

    // The carousel keeps its *own* scroller — that is the layout, not a bug.
    await page.locator("#w-layout").click();
    await page.getByRole("option", { name: /kaydırmalı|carousel/i }).click();
    await expect.poll(measure).toMatchObject({ rowScrolls: true, scrolled: 0 });
  });

  test("the rating badge replaces the reviews, and the controls that picked them", async ({
    page,
  }) => {
    /**
     * The badge (P3-T2).
     *
     * A badge is a *layout*, so choosing it has to do two things at once:
     * change what the widget draws, and take away the controls that pick
     * individual reviews — minimum rating, how many, "only reviews with text",
     * and the approval list below. Those move the wall; they do not move an
     * average, and a control that does nothing is a promise the product does
     * not keep.
     *
     * That is the browser's half. **Whether the average is honest is not tested
     * here** — it is a property of a query, proved where a query can be
     * inspected: `tests/db/widgets-public.test.ts` renders the badge for a
     * branch with a 5 on display and a 1 withheld and requires it to read 3,0.
     * What this file adds is that the aggregate survives the whole trip into a
     * published document, and that the settings panel tells the truth about
     * which of its controls still apply.
     */
    await page.goto("/widgets");
    await page.locator("#widget-name").fill("E2E rozet");
    await page
      .locator("form")
      .filter({ has: page.locator("#widget-name") })
      .getByRole("button", { name: CREATE })
      .click();
    await expect(page).toHaveURL(/\/widgets\/[0-9a-f-]{36}$/);

    const preview = page.frameLocator('iframe[src*="/preview"]');
    await expect(preview.locator(".rvw-card").first()).toBeVisible();

    await page.locator("#w-layout").click();
    await page.getByRole("option", { name: /puan rozeti|rating badge/i }).click();

    // The preview is the real renderer, so this is the badge itself: a score,
    // formatted for the widget's language, and no cards.
    await expect(preview.locator(".rvw-badge")).toBeVisible();
    await expect(preview.locator(".rvw-badge-score")).toHaveText(/^\d([.,]\d)?$/);
    await expect(preview.locator(".rvw-card")).toHaveCount(0);

    /**
     * And the frame hugs it, in **both** dimensions.
     *
     * The layout test above checks the height for the grid, list and carousel —
     * all of them taller than the preview's minimum, so all of them passed
     * while the minimum was still being applied as a clamp. A badge is about
     * 44px tall: it sat in a 120px box with the browser's own canvas showing
     * underneath, black for anyone in dark mode.
     *
     * Width is the same defect on the other axis and has no other test: the
     * frame was full-bleed for every layout, so a "compact" badge arrived on a
     * customer's page as a small box in a wide rectangle, and in the builder as
     * a small box in a wide empty panel. Only an inline-sized root reports a
     * width — a block one would just be handing back the frame's own width.
     */
    /** The worst of the two gaps between the frame and the widget inside it. */
    const worstGap = () =>
      page.evaluate(() => {
        const frame = document.querySelector('iframe[src*="/preview"]') as HTMLIFrameElement;
        const root = frame.contentDocument!.querySelector(".rvw") as HTMLElement;
        const outer = frame.getBoundingClientRect();
        const inner = root.getBoundingClientRect();
        // Rounded, because the frame is sized from a rounded measurement.
        return Math.round(Math.max(outer.height - inner.height, outer.width - inner.width));
      });

    await expect
      .poll(worstGap, { message: "the preview should be the size of the badge and no bigger" })
      .toBeLessThanOrEqual(2);

    // The controls that cannot affect it are gone, not disabled — including the
    // approval list, which is rendered on the server and handed to the builder
    // precisely so it can leave the moment the layout changes.
    await expect(page.locator("#w-min")).toBeHidden();
    await expect(page.locator("#w-count")).toBeHidden();
    await expect(page.locator("#w-text")).toBeHidden();
    await expect(page.locator('[id^="approve-"]')).toHaveCount(0);

    // And they come back with the layout, without a save in between.
    await page.locator("#w-layout").click();
    await page.getByRole("option", { name: /izgara|^grid$/i }).click();
    await expect(page.locator("#w-count")).toBeVisible();
    await expect(page.locator('[id^="approve-"]').first()).toBeVisible();

    // So does the frame's width. The badge's measurement must not linger, or a
    // wall of reviews renders in a 200px column for the rest of the session.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const frame = document.querySelector('iframe[src*="/preview"]') as HTMLIFrameElement;
            const slot = frame.parentElement!;
            const pad = getComputedStyle(slot);
            const available =
              slot.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
            return Math.round(available - frame.getBoundingClientRect().width);
          }),
        { message: "a wall of reviews should go back to filling its slot" },
      )
      .toBeLessThanOrEqual(2);

    // --- What a visitor gets ------------------------------------------------
    await page.locator("#w-layout").click();
    await page.getByRole("option", { name: /puan rozeti|rating badge/i }).click();
    await page.getByRole("button", { name: /^(kaydet|save)$/i }).click();
    await page.getByRole("button", { name: PUBLISH }).click();
    await expect(page.getByRole("button", { name: /yayından kaldır|unpublish/i })).toBeVisible();

    const snippet = await page.locator("pre code").first().textContent();
    const key = snippet?.match(/data-revira-widget="([a-z0-9]{24})"/)?.[1];

    // A first-paint height in the snippet itself, so the badge does not open a
    // 420px hole in the customer's page for the tick before it measures itself.
    expect(snippet).toContain('data-revira-height="64"');

    // The JSON says what the number is drawn from, on the wire, so a consumer
    // rendering the badge themselves cannot mistake it for a curated average.
    const payload = (await (
      await page.request.get(`/api/public/widgets/${key}`, {
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      })
    ).json()) as { aggregate: { basis: string; average: number | null; count: number } };

    expect(payload.aggregate.basis).toBe("all_reviews_in_scope");
    expect(payload.aggregate.count).toBeGreaterThan(0);

    await page.goto(`/embed/w/${key}`);
    await expect(page.locator(".rvw-badge")).toBeVisible();
    // A badge quotes nothing, which is also why it can be honest about the score.
    await expect(page.locator(".rvw-card")).toHaveCount(0);

    /**
     * Finally, the loader — on a page that is not ours.
     *
     * Everything above tests our own routes rendering in our own tab. The embed
     * script's whole job happens somewhere else: a different origin, no
     * framework, no stylesheet of ours, and an iframe it has to size from a
     * `postMessage` across that origin boundary. The width branch is new and
     * lives *only* there, so nothing else in this file can catch it breaking.
     *
     * The host page gets a real socket rather than an intercepted route, and
     * that is not fussiness. A synthesized response has no address space Chrome
     * can classify, so it is treated as public — and a public page loading a
     * `localhost` script is refused by Private Network Access before a line of
     * the loader runs. A genuine loopback server is cross-origin (a different
     * port) without being cross-address-space, which is the shape a customer's
     * site has in production anyway.
     */
    // Captured before the navigation: afterwards `page.url()` is the host page.
    const loader = new URL("/embed/widget.js", page.url()).toString();
    const host = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><meta charset="utf-8"><body style="margin:0">` +
          `<span>Book now</span>` +
          `<script src="${loader}" data-revira-widget="${key}" data-revira-height="64"></script>` +
          `</body>`,
      );
    });

    try {
      await new Promise<void>((resolve) => {
        host.listen(0, "127.0.0.1", resolve);
      });
      await page.goto(`http://127.0.0.1:${(host.address() as AddressInfo).port}/`);

      // The badge really rendered, in a frame served from another origin.
      await expect(page.frameLocator("iframe").locator(".rvw-badge")).toBeVisible();

      /**
       * Measured through Playwright rather than in the page, because the host
       * page genuinely cannot see inside: the frame is cross-origin *and*
       * sandboxed without `allow-same-origin`, so `contentDocument` is null —
       * which is the isolation the embed is supposed to have.
       */
      await expect
        .poll(
          async () => {
            const outer = await page.locator("iframe").boundingBox();
            const inner = await page.frameLocator("iframe").locator(".rvw").boundingBox();
            if (!outer || !inner) return Number.POSITIVE_INFINITY;
            // Not "narrower than the viewport" — the size of the badge, within
            // the pixel the frame's rounded measurement can cost. A frame that
            // merely got smaller would still be a rectangle around a control
            // meant to sit inline.
            return Math.round(Math.max(outer.width - inner.width, outer.height - inner.height));
          },
          { message: "the loader should shrink the frame to the badge" },
        )
        .toBeLessThanOrEqual(2);

      // And inline, so it sits beside the "Book now" it was pasted next to
      // rather than taking a line of its own.
      await expect(page.locator("iframe")).toHaveCSS("display", "inline-block");
    } finally {
      await new Promise((resolve) => host.close(resolve));
    }
  });

  test("the builder has a way back out that does not depend on history", async ({ page }) => {
    // Reported: from the builder there was no route back to the list except the
    // sidebar. The browser's own back button covers "where I came from"; this
    // covers *up*, which has to work on a page opened cold from a bookmark or a
    // link — so it is asserted after a direct navigation, with no history to
    // fall back on.
    await page.goto("/widgets");
    await page.locator("#widget-name").fill("E2E geri");
    await page
      .locator("form")
      .filter({ has: page.locator("#widget-name") })
      .getByRole("button", { name: CREATE })
      .click();
    await expect(page).toHaveURL(/\/widgets\/[0-9a-f-]{36}$/);

    const builderUrl = page.url();
    await page.goto("about:blank");
    await page.goto(builderUrl);

    await page.getByRole("link", { name: /tüm bileşenler|all widgets/i }).click();
    await expect(page).toHaveURL(/\/widgets$/);
  });

  test("a draft widget is invisible to the public", async ({ page }) => {
    await page.goto("/widgets");

    await page.locator("#widget-name").fill("E2E taslak");
    await page
      .locator("form")
      .filter({ has: page.locator("#widget-name") })
      .getByRole("button", { name: CREATE })
      .click();

    await expect(page).toHaveURL(/\/widgets\/[0-9a-f-]{36}$/);

    const snippet = await page.locator("pre code").first().textContent();
    const key = snippet?.match(/data-revira-widget="([a-z0-9]{24})"/)?.[1];

    // Never published, so the public route must not know it exists — and must
    // answer exactly as it would for a key that never existed.
    const response = await page.request.get(`/embed/w/${key}`);
    expect(response.status()).toBe(404);
  });
});
