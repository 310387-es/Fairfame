import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

/**
 * Mobile triage layout, at a real viewport (P2-T9's remaining half).
 *
 * This is the check that could not exist before. jsdom has no layout engine, so
 * "does anything overflow at 390px" is not a question it can answer — every
 * previous attempt was either a class-string assertion, which proves nothing
 * about layout, or a person looking at a screenshot, which does not run again
 * tomorrow.
 *
 * The assertion is deliberately about *overflow* rather than about pixels.
 * Asserting positions would fail on every legitimate design change; asserting
 * that nothing escapes the viewport fails only when something is actually
 * broken — which, on a phone, means a horizontal scrollbar and a card whose
 * right-hand side cannot be reached.
 */

/** An iPhone-ish portrait viewport. */
const PHONE = { width: 390, height: 844 };

/** Elements that stick out past the right edge, named so a failure is readable. */
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll("body *")]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        // Zero-sized nodes and things deliberately parked off-screen (a sheet,
        // a popover's portal) are not overflow.
        if (rect.width === 0 || rect.height === 0) return false;
        if (getComputedStyle(el).position === "fixed") return false;

        /*
          Nor is anything inside a visually-hidden container.

          `.chart-fallback` — the data table every chart renders for screen
          readers and print — is the sr-only pattern: 1px square, `overflow:
          hidden`, `clip-path: inset(50%)`. The table inside it keeps its real
          width, so its rect runs hundreds of pixels past the viewport while
          being both invisible and unreachable: the dashboard measured
          `scrollWidth === clientWidth === 390` with eight "overflowing"
          elements, all of them in there.

          The helper already exempts this category — its comment says "things
          deliberately parked off-screen" — and only recognised the `position:
          fixed` spelling of it. A clipping ancestor is the other spelling.
        */
        for (let node = el.parentElement; node !== null; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.clipPath !== "none" && node.getBoundingClientRect().width <= 1) return false;
        }

        return rect.right > limit + 1;
      })
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join(".")}`);
  });
}

async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

test.use({ viewport: PHONE });

test.describe("the inbox on a phone", () => {
  test("fits the viewport, with nothing hanging off the side", async ({ page }) => {
    await page.goto("/reviews");
    await expect(page.getByRole("heading").first()).toBeVisible();

    expect(await overflowing(page)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
  });

  test("swaps the numbered pager for a load-more control", async ({ page }) => {
    // The two paging models from P2-T2, and the whole reason both exist: page
    // numbers to jump around on a desktop, a single forward step on a phone.
    await page.goto("/reviews");
    await expect(page.getByRole("heading").first()).toBeVisible();

    const pager = page.getByRole("navigation", { name: /sayfalama|pagination/i });
    await expect(pager).toBeHidden();
  });

  test("keeps the filter bar's labels readable rather than clipping them", async ({ page }) => {
    // The bug this guards: `ChipGroup`'s label column was a fixed 3.5rem, which
    // clipped the Turkish "GÖRÜNÜMLER" outright. It stacks below `sm` now, so
    // the assertion is that each label renders at its full width — a clipped
    // one is narrower than the text inside it.
    await page.goto("/reviews");

    const labels = page.locator("span.uppercase").filter({ hasText: /\S/ });
    const count = await labels.count();
    expect(count, "the filter bar should render at least one group label").toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const label = labels.nth(index);
      const clipped = await label.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(clipped, `"${await label.innerText()}" is clipped`).toBe(false);
    }

    expect(await overflowing(page)).toEqual([]);
  });
});

test.describe("the Phase 3 screens on a phone", () => {
  /**
   * The two screens Phase 3 added that carry *tables*, which is the shape most
   * likely to push a page sideways at 390px. `docs/19` asks for mobile-first
   * and `docs/18` records that layout is one of the two things a unit test
   * structurally cannot reach — jsdom has no layout engine.
   *
   * The assertion is deliberately about the **document**, not the tables. A
   * comparison table that scrolls inside its own container is the design; a
   * comparison table that drags the whole page sideways is the bug, and on a
   * phone that means the customer's thumb moves the layout instead of the list.
   */
  test("Insights fits, with its tables scrolling inside themselves", async ({ page }) => {
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // The document must not move. That is the whole bug on a phone.
    expect(await scrollsSideways(page)).toBe(false);

    /**
     * A comparison table is *deliberately* wider than 390px — four measures
     * plus a branch name will not fit, and squeezing them would give four
     * unreadable columns instead of a scrollable five. So the assertion is not
     * the shared `overflowing()` ("nothing is wider than the viewport") but a
     * stricter and more accurate one: anything that overflows must be held by
     * an ancestor that scrolls it.
     */
    const loose = await page.evaluate(() => {
      const scrolls = (el: Element) => {
        const overflow = getComputedStyle(el).overflowX;
        return overflow === "auto" || overflow === "scroll";
      };

      return [...document.querySelectorAll("main *")]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
        .filter((el) => {
          for (let node = el.parentElement; node; node = node.parentElement) {
            if (scrolls(node)) return false;
          }
          return true;
        })
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60));
    });

    expect(loose, "these hang off the side with nothing scrolling them").toEqual([]);

    // And the tables really are scrollable rather than merely squeezed — a
    // four-measure row cannot fit 390px, so the container has to take it.
    const scrollable = await page.evaluate(() =>
      [...document.querySelectorAll("table")].some(
        (table) =>
          (table.parentElement?.scrollWidth ?? 0) > (table.parentElement?.clientWidth ?? 0),
      ),
    );
    expect(scrollable, "a comparison table should scroll inside its own container").toBe(true);
  });

  /**
   * Connections and Branches (W4.2), which are the same two shapes as Insights:
   * a card grid that must reflow, and a table that must scroll inside itself.
   *
   * The Branches table is deliberately `min-w-[52rem]` — seven columns will not
   * fit a phone and squeezing them would give seven unreadable ones. So the
   * assertion is the strict version again: the *document* must not move, and
   * anything hanging off the side must have a scrolling ancestor.
   */
  test("Connections and Branches fit, with the table scrolling inside itself", async ({ page }) => {
    await page.goto("/connections");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await overflowing(page)).toEqual([]);

    await page.goto("/locations");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);

    const loose = await page.evaluate(() => {
      const scrolls = (el: Element) => {
        const overflow = getComputedStyle(el).overflowX;
        return overflow === "auto" || overflow === "scroll";
      };

      return [...document.querySelectorAll("main *")]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
        .filter((el) => {
          for (let node = el.parentElement; node; node = node.parentElement) {
            if (scrolls(node)) return false;
          }
          return true;
        })
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60));
    });

    expect(loose, "these hang off the side with nothing scrolling them").toEqual([]);
  });

  test("the widget builder fits, preview and all", async ({ page }) => {
    await page.goto("/widgets");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(await overflowing(page)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
  });
});

test.describe("the public review page on a phone", () => {
  // Unauthenticated: this is what a customer actually opens, from a QR code on
  // a table, on a phone. If anything in the product has to survive a small
  // screen it is this page.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("fits the viewport", async ({ page }) => {
    await page.goto(`/c/${campaignSlug()}`);
    await expect(page.getByRole("button", { name: /gönder|submit/i })).toBeVisible();

    expect(await overflowing(page)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
  });
});

/** The campaign the setup created, recorded for the suite to open. */
function campaignSlug(): string {
  const run = JSON.parse(readFileSync("e2e/.auth/run.json", "utf8")) as { campaignSlug: string };
  return run.campaignSlug;
}

test.describe("the digest on a phone", () => {
  /**
   * The archive (D3), which had no mobile coverage at all despite the digest
   * being the product's hero — a strip of week cards, each carrying a date
   * range, a pulse and a delta on one line, which is exactly the shape that
   * runs off the side once Turkish makes every label a third longer.
   *
   * The *detail* page is not reachable here on purpose: this account has no
   * generated digest, and composing one would mean a live model call inside a
   * layout test. Its two new pieces — `SectionCard` and `Meter` — are both
   * swept at this viewport on `/analytics`, which is where they carry their
   * widest content.
   */
  test("the archive fits, with nothing hanging off the side", async ({ page }) => {
    await page.goto("/weekly-plan");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(await overflowing(page)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
  });
});

test.describe("surveys on a phone", () => {
  /**
   * The builder (P4-T2), which carries the widest control Phase 4 adds: a
   * two-column grid of selects plus a hint paragraph that runs about 30% longer
   * in Turkish. The account has no surveys, and that is fine — the empty state
   * still renders the create form, which is where the overflow risk lives.
   */
  test("the builder fits, with nothing hanging off the side", async ({ page }) => {
    await page.goto("/surveys");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(await overflowing(page)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
  });
});

test.describe("broadcasts on a phone", () => {
  /**
   * The builder (P4-T4): a two-column grid of selects plus a four-figure
   * results row. The account has no segments, so this renders the "save a
   * segment first" state — which still carries the page shell and the empty
   * list, and is where a grid that forgot its breakpoint would show.
   */
  test("fits the viewport, with nothing hanging off the side", async ({ page }) => {
    await page.goto("/broadcasts");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(await overflowing(page)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
  });
});

test.describe("messages on a phone", () => {
  /**
   * The conversations inbox (P4-T3): two panes side by side on a desktop, which
   * on a phone has to become one column. The account has no conversations, so
   * this exercises the empty state — which still renders the page shell and is
   * where a two-column grid that forgot its breakpoint would show.
   */
  test("fits the viewport, with nothing hanging off the side", async ({ page }) => {
    await page.goto("/conversations");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(await overflowing(page)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
  });
});

test.describe("contacts on a phone", () => {
  /**
   * The CRM list (P4-T1), which is the widest thing Phase 4 adds so far: a name,
   * an email, a phone, a row of tags and a timestamp, all on one line from `sm`
   * up. On a phone that has to become a stack rather than a squeeze, and the
   * filter bar above it is three rows of chips that must wrap rather than run
   * off the side.
   *
   * The account this runs against has no contacts, and that is deliberately
   * fine: the empty state still renders the segments row, the search box and
   * every chip group, which is where the overflow risk actually lives.
   */
  test("the list and its filter bar fit, with nothing hanging off the side", async ({ page }) => {
    await page.goto("/contacts");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(await overflowing(page)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
  });

  test("the filter chips wrap rather than clipping their labels", async ({ page }) => {
    // Turkish runs about 30% longer than English (docs/15 §7), and these labels
    // are full sentences — "Mesaj izni kayıtlı". A chip whose text is cut off
    // is a filter nobody can identify.
    await page.goto("/contacts");

    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll("main a, main button")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => (el as HTMLElement).innerText.trim().slice(0, 30)),
    );

    expect(clipped).toEqual([]);
  });
});

test.describe("the agency console on a phone", () => {
  /**
   * The client roster (P4-T5): a three-column grid per row — name and role,
   * a summary line, then Open and Unlink — which has to stack below `sm`.
   *
   * The account this suite creates is not on the Agency tier, so what renders
   * is the locked card rather than the roster. That is still worth measuring:
   * the page shell, heading and card are the same, and a locked state that
   * overflowed would be the first thing an unentitled visitor saw. The roster
   * itself is exercised in `tests/db/agency.test.ts` and by hand.
   */
  test("fits the viewport, with nothing hanging off the side", async ({ page }) => {
    await page.goto("/agency");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(await overflowing(page)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
  });
});

/**
 * The four screens that were never in this suite at all.
 *
 * `/dashboard` is the first screen of the product, `/settings` holds the plan
 * grid and the compliance card, `/channels` the two-column blocker list and
 * `/team` the invite form and the member rows — and none of the four had ever
 * been measured on a phone. A suite that covers the screens somebody remembered
 * is a suite whose coverage is decided by memory, which is the same reason
 * `tests/db/public-leakage.test.ts` enumerates its routes off disk.
 *
 * Found while giving all four a design pass: three of them changed layout in
 * that pass, and nothing here would have noticed if a change had broken them.
 */
test.describe("the screens this suite had never measured", () => {
  for (const { path, name } of [
    { path: "/dashboard", name: "the dashboard" },
    { path: "/settings", name: "settings" },
    { path: "/channels", name: "channels" },
    { path: "/team", name: "team" },
    // The two screens Wave 5 added. `/compliance` carries a four-across figure
    // grid that has to become one column, and `/welcome` is the first screen a
    // new customer sees — on the phone the plan says they live on.
    { path: "/compliance", name: "compliance" },
    { path: "/welcome", name: "the welcome screen" },
  ]) {
    test(`${name} fits the viewport, with nothing hanging off the side`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      expect(await overflowing(page)).toEqual([]);
      expect(await scrollsSideways(page)).toBe(false);
    });
  }
});

/**
 * The two screens the audit measured as overflowing (P1-12, folded into Wave 1).
 *
 * `/get-reviews` came in at 595px on a 390px phone and `/locations` at 401px, and
 * neither was in this suite — which is precisely why nobody noticed. The cause
 * on both is the same: a **public link printed verbatim**. A campaign's URL and
 * a location's hosted-page URL are long, unbroken, and carry no spaces for a
 * browser to wrap at, so they push their container as wide as the string.
 *
 * These pages are checked with the strict rule rather than the scrolling-
 * ancestor exception used for Insights' comparison table: a URL is not a table.
 * Nothing here is legitimately wider than the phone.
 */
test.describe("the two screens that were overflowing", () => {
  test("requests fits, including the campaign's public link", async ({ page }) => {
    await page.goto("/get-reviews");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(await overflowing(page)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
  });

  /**
   * Branches is a table now (W4.2), so the page-level check moved to the
   * Connections test above — a seven-column table is *deliberately* wider than
   * 390px and the strict `overflowing()` no longer applies to it.
   *
   * What is still worth asserting here is the thing this test was named for:
   * the hosted page's URL, which is long, and which now lives in the row's
   * detail panel. A URL somebody cannot read or select is no more use than one
   * that breaks the layout.
   */
  test("the hosted page's URL is readable inside a branch's detail", async ({ page }) => {
    await page.goto("/locations");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await page
      .getByRole("button", { name: /ayrıntılarını göster|show details for/i })
      .first()
      .click();

    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll("main p, main code, main span, main a")]
        .filter((el) => /\/reviews\//.test(el.textContent?.trim() ?? ""))
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.textContent?.trim().slice(0, 60) ?? ""),
    );

    expect(clipped).toEqual([]);
  });

  /**
   * The specific defect, asserted on the element rather than on the page.
   *
   * A page can pass the two checks above while a link is *clipped* — hidden by
   * `overflow: hidden` on an ancestor rather than wrapped — and a URL somebody
   * cannot read or select is no more use than one that breaks the layout.
   */
  test("a long URL wraps instead of being clipped or cut off", async ({ page }) => {
    await page.goto("/get-reviews");

    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll("p, code, span, div")]
        .filter((el) => /^https?:\/\//.test(el.textContent?.trim() ?? ""))
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.textContent?.trim().slice(0, 60) ?? ""),
    );

    expect(clipped).toEqual([]);
  });
});
