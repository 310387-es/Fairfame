/**
 * Which screens are two tabs of one thing (W3.1).
 *
 * The rail dropped from fifteen entries to thirteen by demoting two screens to
 * tabs: Campaigns beside Contacts, Surveys beside Get reviews. That left them
 * with **no rail entry of their own**, and the rail's active state was a simple
 * `pathname === href` — so opening the Surveys tab highlighted nothing at all
 * and the navigation quietly told the reader they were nowhere.
 *
 * So the parent has to claim the child, and this is the one place that says so.
 * The tab strip and the rail both read it, because the alternative is two lists
 * that agree today: a tab added to one and forgotten in the other produces
 * exactly the bug this fixes, and produces it silently.
 *
 * **Framework-free and db-free on purpose.** The rail is a client component and
 * the tab strip is a server one; anything either could not import would push
 * one of them back to its own copy.
 */

export type SectionTab =
  "contacts" | "broadcasts" | "requests" | "surveys" | "locations" | "connections";

export type Section = {
  /** The rail entry that stays lit while any tab in this section is open. */
  parent: string;
  tabs: { key: SectionTab; href: string }[];
};

export const SECTIONS: Section[] = [
  {
    parent: "/contacts",
    tabs: [
      { key: "contacts", href: "/contacts" },
      { key: "broadcasts", href: "/broadcasts" },
    ],
  },
  {
    parent: "/get-reviews",
    tabs: [
      { key: "requests", href: "/get-reviews" },
      { key: "surveys", href: "/surveys" },
    ],
  },
  /**
   * Branches and Connections (W4.2).
   *
   * The audit asks for Connections as a new top-level screen, and W3.1 had
   * already folded it into a single "Locations & Connections" rail entry — the
   * rail note in `sidebar-nav.tsx` says so, against a screen that did not exist
   * yet. Both can be true: it is its own screen, reached as a tab, and the rail
   * stays at thirteen entries rather than creeping back towards fifteen one
   * good idea at a time.
   *
   * `/locations` is the parent because a branch is the thing that exists first
   * — you cannot connect a source without one, and the connect card on
   * Connections says exactly that when there are none.
   */
  {
    parent: "/locations",
    tabs: [
      { key: "locations", href: "/locations" },
      { key: "connections", href: "/connections" },
    ],
  },
];

/** The strip a screen belongs to, or null when it is not a tabbed screen. */
export function sectionFor(tab: SectionTab): Section | null {
  return SECTIONS.find((section) => section.tabs.some((entry) => entry.key === tab)) ?? null;
}

/**
 * The rail entry that should be lit for a path, or null.
 *
 * Matches a tab's own sub-paths too (`/surveys/{id}` keeps Get reviews lit),
 * because a detail page is still inside the section — losing the highlight one
 * click deeper would be the same bug with a smaller blast radius.
 */
export function railParentFor(pathname: string): string | null {
  for (const section of SECTIONS) {
    for (const tab of section.tabs) {
      if (pathname === tab.href || pathname.startsWith(`${tab.href}/`)) return section.parent;
    }
  }
  return null;
}
