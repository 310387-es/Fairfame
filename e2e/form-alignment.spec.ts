import { test, expect, type Page } from "@playwright/test";

/**
 * Field columns holding a `Select` are as tall as they look.
 *
 * A named Radix `Select` renders a hidden `<select>` after its trigger so the
 * value submits with the form. It is absolutely positioned and invisible — but
 * it is the column's real *last child*, and Tailwind v4's `space-y-*` puts its
 * margin on every child except the last. The spacing therefore landed under the
 * trigger, and the column carried 8px of dead air below its last visible
 * control.
 *
 * On a stacked form nobody would ever notice. In a row aligned by `items-end`
 * — the invite form on `/team` — it lifted the role select 8px clear of the
 * email field and the button beside it, which is how it was found.
 *
 * Only a browser can answer this: jsdom has no layout engine, so the height of
 * a column against the bottom of the control inside it is not a question it can
 * be asked. The fix is a rule in `globals.css`; this is what stops it silently
 * coming back when Tailwind changes how `space-y` is compiled, which is exactly
 * the kind of change nothing else here would catch.
 *
 * The assertion is about *dead space*, not about pixel positions. A column may
 * legitimately be laid out any number of ways; what it may not do is reserve
 * room under a control for a node that is not there.
 */

/** Trigger bottom vs column bottom, for every labelled select on the page. */
async function deadSpaceUnderSelects(page: Page): Promise<{ id: string; gap: number }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="select-trigger"]')]
      .map((trigger) => {
        const column = trigger.parentElement;
        if (!column) return null;
        // Only columns whose last visible control *is* the select: a real
        // sibling underneath it (a hint, a field error) is legitimate height.
        const visible = [...column.children].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.height > 1 && getComputedStyle(el).position !== "absolute";
        });
        if (visible.at(-1) !== trigger) return null;
        return {
          id: trigger.id || trigger.getAttribute("aria-label") || "(unnamed select)",
          gap: Math.round(
            column.getBoundingClientRect().bottom - trigger.getBoundingClientRect().bottom,
          ),
        };
      })
      .filter((entry): entry is { id: string; gap: number } => entry !== null),
  );
}

for (const path of ["/team", "/settings"]) {
  test(`no dead space under the selects on ${path}`, async ({ page }) => {
    await page.goto(path);
    const columns = await deadSpaceUnderSelects(page);

    // A page with no selects would pass vacuously and quietly stop testing
    // anything the day somebody moves the control.
    expect(columns.length, `${path} should have a labelled select to check`).toBeGreaterThan(0);
    expect(columns.filter((c) => c.gap !== 0)).toEqual([]);
  });
}

test("the invite row's controls sit on one line", async ({ page }) => {
  await page.goto("/team");

  const tops = await Promise.all(
    ["#invite-email", "#invite-role", "form:has(#invite-email) button[type=submit]"].map(
      async (selector) => (await page.locator(selector).first().boundingBox())!.y,
    ),
  );

  expect(new Set(tops).size, `controls started at ${tops.join(", ")}`).toBe(1);
});
