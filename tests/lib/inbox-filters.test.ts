import { describe, expect, it } from "vitest";
import {
  EMPTY_INBOX_FILTERS,
  hasActiveFilters,
  inboxFilterParams,
  inboxHref,
  MAX_LOAD_MORE,
  MAX_PINNED_REVIEWS,
  parseInboxFilters,
  parseInboxPosition,
  toggleFilter,
  type InboxFilterState,
} from "@/reviews/filters";

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
      ct: "wait_time",
      q: "yavaş servis",
      reply: "unanswered",
      status: "open,in_progress",
      rating: "1,2",
      assignee: "me",
      overdue: "1",
      from: "2026-07-01",
      to: "2026-07-31",
      reviews: "11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222",
      sort: "priority",
    });

    expect(parsed).toEqual({
      source: "google",
      sentiment: "negative",
      theme: "servis",
      // The state's name, not the parameter's: `ct` in a URL, `canonical` in
      // code. A canonical theme is not the same thing as a free-text tag, and
      // the two travel separately (W3.2).
      canonical: "wait_time",
      query: "yavaş servis",
      reply: "unanswered",
      status: ["open", "in_progress"],
      rating: [1, 2],
      assignee: "me",
      overdue: true,
      from: "2026-07-01",
      to: "2026-07-31",
      reviews: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
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
    expect(inboxHref(EMPTY_INBOX_FILTERS)).toBe("/reviews");
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

/**
 * Pinning the Inbox to exactly these reviews (W2.1).
 *
 * The one filter that names rows instead of describing a kind of row, and the
 * only one whose values come from a URL and go straight into a `WHERE … IN`.
 * So the guards are the test: shape, bound, and the round-trip property every
 * other filter here already has.
 */
describe("the exact-reviews filter", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";

  it("reads a comma-separated list", () => {
    expect(parseInboxFilters({ reviews: `${A},${B}` }).reviews).toEqual([A, B]);
  });

  it("drops anything that is not a uuid", () => {
    // Not fussiness. A non-uuid reaches Postgres as a *cast error*, not an
    // empty result — so a stale bookmark would 500 rather than show nothing.
    expect(
      parseInboxFilters({ reviews: `${A},not-an-id,'; drop table reviews--` }).reviews,
    ).toEqual([A]);
  });

  it("dedupes, so one review cannot be asked for twice", () => {
    expect(parseInboxFilters({ reviews: `${A},${A},${B}` }).reviews).toEqual([A, B]);
  });

  it("caps how many a single link may pin", () => {
    // A hand-written URL must not be able to ask the database for an unbounded
    // list by id. A digest action cites at most five.
    const many = Array.from(
      { length: MAX_PINNED_REVIEWS + 10 },
      (_, index) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    ).join(",");

    expect(parseInboxFilters({ reviews: many }).reviews).toHaveLength(MAX_PINNED_REVIEWS);
  });

  it("survives a round trip through the URL", () => {
    // The property the whole module exists for: a saved view compares by query
    // string, so a filter that does not serialize back to itself silently
    // changes what a saved view means.
    const state = filters({ reviews: [A, B] });
    expect(parseInboxFilters(Object.fromEntries(inboxFilterParams(state)))).toEqual(state);
  });

  it("counts as an active filter", () => {
    // Otherwise the Inbox shows "Clear filters" as absent while displaying
    // three reviews out of ninety, with nothing on screen saying why.
    expect(hasActiveFilters(filters({ reviews: [A] }))).toBe(true);
  });
});
