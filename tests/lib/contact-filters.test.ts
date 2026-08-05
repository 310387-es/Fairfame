import { describe, expect, it } from "vitest";
import {
  contactFilterParams,
  contactFiltersToRecord,
  contactsHref,
  EMPTY_CONTACT_FILTERS,
  hasActiveContactFilters,
  MAX_FILTER_TAGS,
  parseContactFilters,
  parseContactPage,
  toggleContactFilter,
  type ContactFilterState,
} from "@/contacts/filters";

/**
 * The contact filter contract (P4-T1).
 *
 * This module is the only place a contact filter becomes a query string and
 * back, and a **segment is that query string with a name on it** — so a
 * round-trip that loses a value does not just mis-render a list, it silently
 * changes who a campaign will be sent to. That is what most of this asserts.
 *
 * Db-free, so it runs in the fast suite.
 */

const state = (overrides: Partial<ContactFilterState> = {}): ContactFilterState => ({
  ...EMPTY_CONTACT_FILTERS,
  ...overrides,
});

const LOCATION = "3f7f4d84-1f3b-4f0c-9c3f-2f7b7e5b8a11";

describe("round trip", () => {
  it("survives every filter", () => {
    const original = state({
      query: "ayşe",
      tags: ["kurumsal", "vip"],
      subscription: "subscribed",
      channel: "email",
      consent: "message",
      locationId: LOCATION,
      from: "2026-01-01",
      to: "2026-08-05",
      sort: "activity",
    });

    const params = Object.fromEntries(contactFilterParams(original).entries());
    expect(parseContactFilters(params)).toEqual(original);
  });

  it("serializes an empty filter set to nothing at all", () => {
    expect(contactFilterParams(EMPTY_CONTACT_FILTERS).toString()).toBe("");
    expect(contactsHref(EMPTY_CONTACT_FILTERS)).toBe("/contacts");
  });

  it("orders tags so two URLs meaning the same thing serialize the same way", () => {
    // A segment is compared to the current list by string equality, so
    // `?tag=vip,kurumsal` and `?tag=kurumsal,vip` must not read as different
    // audiences.
    const one = parseContactFilters({ tag: "vip,kurumsal" });
    const other = parseContactFilters({ tag: ["kurumsal", "vip"] });

    expect(one.tags).toEqual(other.tags);
    expect(contactFilterParams(one).toString()).toBe(contactFilterParams(other).toString());
  });

  it("stores what the URL would have said", () => {
    const record = contactFiltersToRecord(state({ subscription: "unsubscribed", sort: "name" }));
    expect(record).toEqual({ sub: "unsubscribed", sort: "name" });
  });
});

describe("tolerance", () => {
  it("degrades an unrecognised value to no filter rather than throwing", () => {
    const parsed = parseContactFilters({
      sub: "maybe",
      has: "fax",
      consent: "carrier-pigeon",
      sort: "sideways",
    });

    expect(parsed.subscription).toBeNull();
    expect(parsed.channel).toBeNull();
    expect(parsed.consent).toBeNull();
    // Sort has no "off", so it falls back to the default rather than to null.
    expect(parsed.sort).toBe("recent");
  });

  it("drops a location id that is not a uuid", () => {
    // Checked before it reaches SQL: Postgres rejects a malformed uuid with an
    // error, and a hand-edited URL should not be a 500.
    expect(parseContactFilters({ location: "'; drop table contacts; --" }).locationId).toBeNull();
    expect(parseContactFilters({ location: LOCATION }).locationId).toBe(LOCATION);
  });

  it("drops a date that is not a date", () => {
    expect(parseContactFilters({ from: "yesterday" }).from).toBeNull();
    expect(parseContactFilters({ from: "2026-02-30" }).from).toBeNull();
    expect(parseContactFilters({ from: "2026-02-28" }).from).toBe("2026-02-28");
  });

  it("caps the number of tags a URL can ask for", () => {
    const many = Array.from({ length: MAX_FILTER_TAGS + 5 }, (_, index) => `tag-${index}`);
    expect(parseContactFilters({ tag: many.join(",") }).tags).toHaveLength(MAX_FILTER_TAGS);
  });

  it("reads a page number, and never a negative one", () => {
    expect(parseContactPage({ page: "4" })).toBe(4);
    expect(parseContactPage({ page: "0" })).toBe(1);
    expect(parseContactPage({ page: "-2" })).toBe(1);
    expect(parseContactPage({})).toBe(1);
  });
});

describe("toggling", () => {
  it("clears the value that is already selected", () => {
    const on = toggleContactFilter(EMPTY_CONTACT_FILTERS, "subscription", "unsubscribed");
    expect(on.subscription).toBe("unsubscribed");
    expect(toggleContactFilter(on, "subscription", "unsubscribed").subscription).toBeNull();
  });

  it("adds and removes a tag rather than replacing the set", () => {
    const one = toggleContactFilter(EMPTY_CONTACT_FILTERS, "tags", "vip");
    const two = toggleContactFilter(one, "tags", "kurumsal");
    expect(two.tags).toEqual(["kurumsal", "vip"]);
    expect(toggleContactFilter(two, "tags", "vip").tags).toEqual(["kurumsal"]);
  });
});

describe("active filters", () => {
  it("does not count sort as a filter", () => {
    // "Clear filters" must not silently throw away the reader's chosen order.
    expect(hasActiveContactFilters(state({ sort: "name" }))).toBe(false);
    expect(hasActiveContactFilters(state({ query: "a" }))).toBe(true);
    expect(hasActiveContactFilters(state({ tags: ["vip"] }))).toBe(true);
  });

  it("keeps the sort when the filters are cleared", () => {
    expect(contactsHref({ ...EMPTY_CONTACT_FILTERS, sort: "name" })).toBe("/contacts?sort=name");
  });
});
