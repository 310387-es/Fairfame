import { describe, expect, it } from "vitest";
import {
  EMPTY_INBOX_FILTERS,
  hasActiveFilters,
  inboxFilterParams,
  inboxHref,
  MAX_LOAD_MORE,
  parseInboxFilters,
  parseInboxPosition,
  toggleFilter,
  type InboxFilterState,
} from "@/inbox/filters";

/**
 * The Inbox's URL contract (P2-T2).
 *
 * Filters live in the URL, which makes the query string a real interface: a
 * digest links into it, a colleague is sent it, a saved view stores it. What is
 * tested here is that it round-trips — because the failure mode of a serializer
 * that forgets a key is not an error, it is a page that silently shows more
 * reviews than the reader asked for.
 */

const filters = (overrides: Partial<InboxFilterState> = {}): InboxFilterState => ({
  ...EMPTY_INBOX_FILTERS,
  ...overrides,
});

describe("parseInboxFilters", () => {
  it("reads every filter out of a query string", () => {
    const parsed = parseInboxFilters({
      source: "google",
      sentiment: "negative",
      theme: "servis",
      q: "yavaş servis",
      reply: "unanswered",
      status: "open,in_progress",
      rating: "1,2",
      assignee: "me",
      overdue: "1",
      from: "2026-07-01",
      to: "2026-07-31",
      sort: "priority",
    });

    expect(parsed).toEqual({
      source: "google",
      sentiment: "negative",
      theme: "servis",
      query: "yavaş servis",
      reply: "unanswered",
      status: ["open", "in_progress"],
      rating: [1, 2],
      assignee: "me",
      overdue: true,
      from: "2026-07-01",
      to: "2026-07-31",
      sort: "priority",
    });
  });

  it("drops values it does not recognise instead of failing", () => {
    // A stale bookmark, or someone editing the URL. Showing more than intended
    // is recoverable; an error page is not.
    const parsed = parseInboxFilters({
      sentiment: "furious",
      status: "open,exploded",
      rating: "0,3,9,two",
      reply: "maybe",
      from: "last tuesday",
      to: "2026-13-45",
      sort: "alphabetical",
    });

    expect(parsed.sentiment).toBeNull();
    expect(parsed.status).toEqual(["open"]);
    expect(parsed.rating).toEqual([3]);
    expect(parsed.reply).toBeNull();
    expect(parsed.from).toBeNull();
    expect(parsed.to).toBeNull();
    expect(parsed.sort).toBe("recent");
  });

  it("normalises a set so two URLs that mean the same thing agree", () => {
    const one = parseInboxFilters({ status: "done,open", rating: "2,1,2" });
    const two = parseInboxFilters({ status: "open,done", rating: "1,2" });

    expect(one).toEqual(two);
    expect(inboxFilterParams(one).toString()).toBe(inboxFilterParams(two).toString());
  });

  it("accepts a repeated parameter as well as a comma-separated one", () => {
    expect(parseInboxFilters({ status: ["open", "done"] }).status).toEqual(["open", "done"]);
  });
});

describe("the URL round-trip", () => {
  it("returns the same state it was given", () => {
    const original = filters({
      source: "instagram",
      sentiment: "positive",
      theme: "kahve",
      query: "teşekkürler",
      reply: "answered",
      status: ["in_progress"],
      rating: [4, 5],
      assignee: "unassigned",
      overdue: true,
      from: "2026-01-01",
      to: "2026-01-31",
      sort: "priority",
    });

    const roundTripped = parseInboxFilters(
      Object.fromEntries(inboxFilterParams(original).entries()),
    );

    expect(roundTripped).toEqual(original);
  });

  it("writes nothing at all for an unfiltered inbox", () => {
    expect(inboxHref(EMPTY_INBOX_FILTERS)).toBe("/inbox");
  });

  it("carries every filter through a page link", () => {
    // The bug this prevents: clicking "next" and landing on a wider list.
    const state = filters({ status: ["open"], rating: [1], overdue: true, sort: "priority" });
    const href = inboxHref(state, { page: 3 });

    expect(href).toContain("page=3");
    const parsed = parseInboxFilters(
      Object.fromEntries(new URL(href, "https://example.com").searchParams.entries()),
    );
    expect(parsed).toEqual(state);
  });
});

describe("parseInboxPosition", () => {
  it("reads a page and a load-more count", () => {
    expect(parseInboxPosition({ page: "3", more: "2" })).toEqual({ page: 3, more: 2 });
  });

  it("defaults to the top of the list", () => {
    expect(parseInboxPosition({})).toEqual({ page: null, more: 0 });
  });

  it("caps how far a phone can keep loading", () => {
    // Past a hundred rows the answer is a filter, not another tap — and an
    // uncapped parameter is an invitation to ask for a hundred thousand.
    expect(parseInboxPosition({ more: "9999" }).more).toBe(MAX_LOAD_MORE);
  });

  it("treats nonsense as the first page", () => {
    expect(parseInboxPosition({ page: "-4", more: "banana" })).toEqual({ page: null, more: 0 });
  });

  it("is not part of a saved view", () => {
    // `inboxFilterParams` is what a view stores. Position must not survive it,
    // or reopening a view would land on a page of a list that has since moved.
    const params = inboxFilterParams(filters({ source: "google" }));

    expect(params.has("page")).toBe(false);
    expect(params.has("more")).toBe(false);
  });
});

describe("toggleFilter", () => {
  it("clears a single value that is already selected", () => {
    const state = filters({ sentiment: "negative" });

    expect(toggleFilter(state, "sentiment", "negative").sentiment).toBeNull();
    expect(toggleFilter(state, "sentiment", "positive").sentiment).toBe("positive");
  });

  it("adds and removes from a set", () => {
    const state = filters({ status: ["open"] });

    expect(toggleFilter(state, "status", "done").status).toEqual(["open", "done"]);
    expect(toggleFilter(state, "status", "open").status).toEqual([]);
  });

  it("flips a flag rather than nulling it", () => {
    expect(toggleFilter(filters(), "overdue", "1").overdue).toBe(true);
    expect(toggleFilter(filters({ overdue: true }), "overdue", "1").overdue).toBe(false);
  });

  it("leaves the other filters alone", () => {
    const state = filters({ source: "google", rating: [1], query: "gecikme" });
    const next = toggleFilter(state, "sentiment", "negative");

    expect(next.source).toBe("google");
    expect(next.rating).toEqual([1]);
    expect(next.query).toBe("gecikme");
  });
});

describe("hasActiveFilters", () => {
  it("is false for an untouched inbox", () => {
    expect(hasActiveFilters(EMPTY_INBOX_FILTERS)).toBe(false);
  });

  it("does not count sorting as filtering", () => {
    // "Clear filters" must not throw away the order the reader chose.
    expect(hasActiveFilters(filters({ sort: "priority" }))).toBe(false);
  });

  it("counts an empty-looking but real filter", () => {
    expect(hasActiveFilters(filters({ overdue: true }))).toBe(true);
    expect(hasActiveFilters(filters({ rating: [1] }))).toBe(true);
    expect(hasActiveFilters(filters({ assignee: "unassigned" }))).toBe(true);
  });
});
