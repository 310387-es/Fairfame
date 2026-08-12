import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `pnpm email:preview` sends one of every email the product can send.
 *
 * **Why this is a test and not a habit.** An email is the one surface with no
 * way to look at it: a template only renders when the event behind it happens,
 * so a template nobody has previewed is a template nobody has *seen*. That is
 * how a rollup shipped with blank fields and a link to `/reviews?review=undefined`
 * — every unit test passed, because each asserted the strings it knew about.
 *
 * `CLAUDE.md` has said "adding a template means adding it to
 * `scripts/email-preview.mts`" since that bug. It was a sentence, and a
 * sentence is not enforcement: a tenth renderer would ship uncovered and the
 * only signal would be somebody, later, opening their inbox.
 *
 * So this is a completeness test in the sense `docs/16` means — **enumerated
 * from disk, and failing when the list grows**. Existing suites prove a given
 * email renders correctly; none of them notices a *new* one. The direction
 * matters: renderer → preview. The reverse needs no test, because a preview
 * importing a renderer that does not exist fails `pnpm typecheck`.
 *
 * The scan is over all of `src/`, not just `messaging/templates.ts` where the
 * nine live today, so a renderer added in a new home is caught too.
 */

const ROOT = "src";
const PREVIEW = "scripts/email-preview.mts";

/** `renderDigestEmail`, `renderVerifyEmailEmail`, … — the exported entry point of a template. */
const RENDERER = /export\s+(?:async\s+)?function\s+(render[A-Za-z0-9_]*Email)\s*\(/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

function renderersIn(files: string[]): { name: string; file: string }[] {
  const found: { name: string; file: string }[] = [];
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(RENDERER)) {
      found.push({ name: match[1]!, file });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

describe("the email preview is the inventory of what we can put in an inbox", () => {
  const renderers = renderersIn(walk(ROOT));
  const preview = readFileSync(PREVIEW, "utf8");

  it("finds the renderers at all", () => {
    // Without this, a regex that stopped matching would turn every assertion
    // below into a vacuous pass and the file would go on reporting success
    // while checking nothing.
    expect(
      renderers.length,
      `No exported render*Email functions found under ${ROOT}/. Either they moved, or ` +
        "the pattern this file scans for did — fix the scan rather than deleting the test.",
    ).toBeGreaterThan(0);
  });

  it.each(renderers)("$name is exercised by the preview", ({ name, file }) => {
    expect(
      preview.includes(name),
      `${name} (${file}) renders an email the preview never sends, so nobody has looked ` +
        `at it. Add it to ${PREVIEW} with realistic content in both locales — the file is ` +
        "the inventory of what the product can put in someone's inbox, and an inventory " +
        "with a gap in it is worse than none, because it reads as complete.",
    ).toBe(true);
  });
});
