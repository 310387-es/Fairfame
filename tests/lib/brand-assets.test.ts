import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The brand assets in `public/` are copies, and this is what stops them being
 * forks (docs/24-brand-guidelines.md §2).
 *
 * `brand/` is where the identity lives — it is what the brand sheet renders,
 * what a designer opens, and what an external agency would be sent. But a
 * browser can only fetch what Next serves, and Next serves `public/`. So the
 * files exist twice, and the ordinary fate of a file that exists twice is that
 * somebody adjusts the seal's crossbar in one of them.
 *
 * The failure that would follow is quiet in the worst way: the favicon and the
 * rail would go on rendering *something*, in the right colours, at the right
 * size — just not the same mark as the PDF, the email header and the brand
 * sheet. Nobody reports a logo that looks fine on the screen they are on.
 *
 * The copies are byte-for-byte, and the list is read from disk rather than
 * written down here, so adding a public copy of a new variant does not also
 * require remembering to add it to a test.
 */

const PUBLIC_BRAND = "public/brand";

/**
 * PNG exports live under `brand/png/` but are served from the root of
 * `public/`, under the names the platforms ask for. Names differ, bytes must
 * not.
 */
const RENAMED = [
  ["public/favicon.svg", "brand/favicon.svg"],
  ["public/icon-32.png", "brand/png/fairfame-symbol-32.png"],
  ["public/icon-192.png", "brand/png/fairfame-symbol-192.png"],
  ["public/icon-512.png", "brand/png/fairfame-symbol-512.png"],
  ["public/apple-touch-icon.png", "brand/png/fairfame-symbol-180.png"],
] as const;

describe("the brand assets in public/", () => {
  const served = readdirSync(PUBLIC_BRAND);

  it("serves something", () => {
    // If this directory is ever emptied, every assertion below would pass
    // vacuously and the shell would render a broken image.
    expect(served.length).toBeGreaterThan(0);
  });

  it.each(served)("%s is byte-for-byte the file in brand/", (name) => {
    const source = readFileSync(`brand/${name}`);
    const copy = readFileSync(`${PUBLIC_BRAND}/${name}`);
    expect(copy.equals(source), `public/brand/${name} has drifted from brand/${name}`).toBe(true);
  });

  it.each(RENAMED)("%s is byte-for-byte %s", (copy, source) => {
    expect(readFileSync(copy).equals(readFileSync(source)), `${copy} has drifted`).toBe(true);
  });
});
