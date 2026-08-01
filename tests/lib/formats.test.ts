import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formats } from "@/i18n/formats";

/**
 * next-intl does not inherit Intl's named styles. Calling
 * `format.dateTime(date, "medium")` without declaring "medium" throws
 * MISSING_FORMAT at render time — a runtime failure that typechecking cannot
 * see and that only shows up on a page actually displaying that value.
 *
 * These tests read the source and assert every named format the app uses is
 * declared, so the failure becomes a failing test instead of a broken screen.
 */

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(path);
    }
  }
  return acc;
}

/** Named formats referenced as the second argument, e.g. (value, "medium"). */
function namedUsages(kind: "dateTime" | "number" | "relativeTime"): Map<string, string[]> {
  const pattern = new RegExp(`\\.${kind}\\([^,()]+,\\s*"([A-Za-z_][\\w]*)"`, "g");
  const found = new Map<string, string[]>();

  for (const file of sourceFiles("src")) {
    const contents = readFileSync(file, "utf8");
    for (const match of contents.matchAll(pattern)) {
      const name = match[1];
      if (!name) continue;
      found.set(name, [...(found.get(name) ?? []), file]);
    }
  }

  return found;
}

describe("declared formats", () => {
  it("declares the date styles the UI relies on", () => {
    expect(Object.keys(formats.dateTime).sort()).toEqual(["long", "medium", "short"]);
  });

  it("gives every dateTime format real options", () => {
    for (const [name, options] of Object.entries(formats.dateTime)) {
      expect(Object.keys(options).length, `${name} has no options`).toBeGreaterThan(0);
    }
  });
});

describe("format usage in source", () => {
  it("only names dateTime formats that are declared", () => {
    const declared = new Set(Object.keys(formats.dateTime));

    for (const [name, files] of namedUsages("dateTime")) {
      expect(
        declared.has(name),
        `format.dateTime(..., "${name}") is used in ${files.join(", ")} but not declared in src/i18n/formats.ts`,
      ).toBe(true);
    }
  });

  it("only names number formats that are declared", () => {
    const declared = new Set(Object.keys(formats.number));

    for (const [name, files] of namedUsages("number")) {
      expect(
        declared.has(name),
        `format.number(..., "${name}") is used in ${files.join(", ")} but not declared`,
      ).toBe(true);
    }
  });

  it("actually finds the Inbox usage — proving the scan works", () => {
    // A scan that silently matches nothing would pass the checks above while
    // testing nothing at all.
    const usages = namedUsages("dateTime");
    expect(usages.size).toBeGreaterThan(0);
    expect([...usages.values()].flat().some((file) => file.includes("review-list"))).toBe(true);
  });
});
