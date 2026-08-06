import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { railParentFor, SECTIONS, sectionFor } from "@/lib/sections";

/**
 * Tabbed screens and the rail (W3.1).
 *
 * Demoting Campaigns and Surveys to tabs left them with no rail entry, and the
 * rail's active state was `pathname === href` — so opening a tab highlighted
 * nothing and the navigation told the reader they were nowhere. That is the bug
 * these hold.
 *
 * The last test is the important one: it reads the rail's own source and checks
 * every section parent is really an entry there. Two lists that agree today is
 * how this breaks again — a tab added to one and forgotten in the other, with
 * nothing failing.
 */

describe("a tabbed screen keeps its parent lit", () => {
  it("lights Get reviews while Surveys is open", () => {
    expect(railParentFor("/surveys")).toBe("/get-reviews");
  });

  it("lights Contacts while Campaigns is open", () => {
    expect(railParentFor("/campaigns")).toBe("/contacts");
  });

  it("keeps the parent lit one click deeper", () => {
    // A detail page is still inside the section; losing the highlight there
    // would be the same bug with a smaller blast radius.
    expect(railParentFor("/surveys/abc-123")).toBe("/get-reviews");
  });

  it("claims nothing it does not own", () => {
    // A prefix test done carelessly would have `/surveys` claim `/surveys-x`,
    // or `/contacts` claim an unrelated screen.
    expect(railParentFor("/analytics")).toBeNull();
    expect(railParentFor("/channels")).toBeNull();
    expect(railParentFor("/surveys-archive")).toBeNull();
  });
});

describe("the strip and the rail cannot disagree", () => {
  it("gives every tab a strip to render", () => {
    for (const section of SECTIONS) {
      for (const tab of section.tabs) {
        expect(sectionFor(tab.key), `no strip for "${tab.key}"`).not.toBeNull();
      }
    }
  });

  it("puts every section's parent in the rail", () => {
    /**
     * Read from the rail's source rather than imported, because the rail is a
     * client component whose module would drag React in. What matters is the
     * assertion, not the mechanism: a section pointing at a parent the rail
     * does not have is a highlight that can never appear, and nothing else in
     * the build would notice.
     */
    const rail = readFileSync("src/components/shell/sidebar-nav.tsx", "utf8");

    for (const section of SECTIONS) {
      expect(rail, `the rail has no entry for "${section.parent}"`).toContain(
        `href: "${section.parent}"`,
      );
    }
  });

  it("keeps every tab's own href out of the rail", () => {
    // The point of the demotion. A tab that is also a rail entry is the
    // fifteen-item rail coming back one line at a time.
    const rail = readFileSync("src/components/shell/sidebar-nav.tsx", "utf8");

    for (const section of SECTIONS) {
      for (const tab of section.tabs) {
        if (tab.href === section.parent) continue;
        expect(rail, `"${tab.href}" is a tab and should not be in the rail`).not.toContain(
          `href: "${tab.href}"`,
        );
      }
    }
  });
});
