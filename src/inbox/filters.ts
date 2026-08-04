import type { ReviewStatus, Sentiment } from "../db/schema.ts";

/**
 * What the Inbox is currently showing, as one object (P2-T2).
 *
 * Filters live in the URL — that predates Phase 2 and is why a digest action can
 * link to "the reviews behind this recommendation". What is new is that the URL
 * shape is defined **once, here**, instead of being written out by hand in the
 * page, the pager and the filter bar. Those three each rebuilt the query string
 * from their own list of parameters, so every filter added in Phase 2 would have
 * been three edits, and forgetting one would silently drop a filter when you
 * clicked "next page" — the kind of bug that reads as "the list is wrong"
 * rather than as a missing parameter.
 *
 * Deliberately free of database imports: P2-T3 saves these objects into
 * `saved_views` and renders them from client components, and a module that
 * reaches `db/client` cannot be imported by a `"use client"` file at all.
 */

export const INBOX_SORTS = ["recent", "priority"] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

export const REPLY_STATES = ["unanswered", "answered"] as const;
export type ReplyState = (typeof REPLY_STATES)[number];

const SENTIMENTS = ["positive", "neutral", "negative"] as const;
const STATUSES = ["open", "in_progress", "done", "ignored"] as const;

/**
 * The assignee filter's two non-uuid values.
 *
 * `me` is stored literally rather than resolved to the reader's id, because a
 * *shared* saved view called "assigned to me" has to mean the person looking at
 * it. Baking in a user id at save time would give every teammate the author's
 * queue.
 */
export const ASSIGNEE_ME = "me";
export const ASSIGNEE_NOBODY = "unassigned";

export type InboxFilterState = {
  source: string | null;
  sentiment: Sentiment | null;
  theme: string | null;
  /** Free text — from the command palette's "see all", or typed. */
  query: string | null;
  reply: ReplyState | null;
  /** Empty means every status, which is not the same as listing all four. */
  status: ReviewStatus[];
  /** Star values, e.g. `[1, 2]`. Empty means any rating, including none. */
  rating: number[];
  /** A user id, `me`, `unassigned`, or null for "anyone". */
  assignee: string | null;
  /** Past its SLA deadline and not yet resolved. */
  overdue: boolean;
  /** Inclusive `YYYY-MM-DD`, UTC. */
  from: string | null;
  /** Inclusive `YYYY-MM-DD`, UTC — the whole of that day counts. */
  to: string | null;
  sort: InboxSort;
};

export const EMPTY_INBOX_FILTERS: InboxFilterState = {
  source: null,
  sentiment: null,
  theme: null,
  query: null,
  reply: null,
  status: [],
  rating: [],
  assignee: null,
  overdue: false,
  from: null,
  to: null,
  sort: "recent",
};

/**
 * The URL parameter each filter is written as.
 *
 * `query` is `?q=` because that is what people expect to type by hand and what
 * the palette links to; everything else is named after itself.
 */
const PARAM = {
  source: "source",
  sentiment: "sentiment",
  theme: "theme",
  query: "q",
  reply: "reply",
  status: "status",
  rating: "rating",
  assignee: "assignee",
  overdue: "overdue",
  from: "from",
  to: "to",
  sort: "sort",
} as const satisfies Record<keyof InboxFilterState, string>;

/** Anything Next.js hands us from a query string. */
export type RawParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : null;
}

/** `?status=open,done` — a repeated parameter works too. */
function many(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function memberOf<T extends string>(allowed: readonly T[], value: string | null): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A date that is not a date is no filter at all, rather than an error page. */
function isoDate(value: string | null): string | null {
  if (value === null || !ISO_DATE.test(value)) return null;
  return Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ? null : value;
}

/**
 * Reads filter state out of a query string.
 *
 * Every value here is user input — typed, pasted, or left over from an older
 * release — so anything unrecognised degrades to "no filter" rather than
 * throwing. A stale bookmark should show more reviews than intended, never a
 * crash.
 */
export function parseInboxFilters(params: RawParams): InboxFilterState {
  const statuses = many(params[PARAM.status])
    .map((value) => memberOf(STATUSES, value))
    .filter((value): value is ReviewStatus => value !== null);

  const ratings = many(params[PARAM.rating])
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 5);

  return {
    source: one(params[PARAM.source]),
    sentiment: memberOf(SENTIMENTS, one(params[PARAM.sentiment])),
    theme: one(params[PARAM.theme]),
    query: one(params[PARAM.query]),
    reply: memberOf(REPLY_STATES, one(params[PARAM.reply])),
    // Deduped and ordered so two URLs that mean the same thing serialize the
    // same way — which is what lets a saved view be compared to the current one.
    status: STATUSES.filter((value) => statuses.includes(value)),
    rating: [...new Set(ratings)].sort((left, right) => left - right),
    assignee: one(params[PARAM.assignee]),
    overdue: one(params[PARAM.overdue]) === "1",
    from: isoDate(one(params[PARAM.from])),
    to: isoDate(one(params[PARAM.to])),
    sort: memberOf(INBOX_SORTS, one(params[PARAM.sort])) ?? "recent",
  };
}

/**
 * Writes filter state back into a query string.
 *
 * The inverse of `parseInboxFilters`, and the only place a filter becomes a URL.
 * Defaults are omitted, so an unfiltered Inbox is `/inbox` rather than a string
 * of empty parameters.
 */
export function inboxFilterParams(state: InboxFilterState): URLSearchParams {
  const params = new URLSearchParams();

  if (state.source) params.set(PARAM.source, state.source);
  if (state.sentiment) params.set(PARAM.sentiment, state.sentiment);
  if (state.theme) params.set(PARAM.theme, state.theme);
  if (state.reply) params.set(PARAM.reply, state.reply);
  if (state.status.length > 0) params.set(PARAM.status, state.status.join(","));
  if (state.rating.length > 0) params.set(PARAM.rating, state.rating.join(","));
  if (state.assignee) params.set(PARAM.assignee, state.assignee);
  if (state.overdue) params.set(PARAM.overdue, "1");
  if (state.from) params.set(PARAM.from, state.from);
  if (state.to) params.set(PARAM.to, state.to);
  if (state.query) params.set(PARAM.query, state.query);
  if (state.sort !== "recent") params.set(PARAM.sort, state.sort);

  return params;
}

/**
 * How far past the first page the phone has been asked to show.
 *
 * The Inbox pages two ways at once, because the two readings are different
 * jobs. On a desktop you want "page 4 of 7" and the ability to jump; on a phone
 * you thumb downwards and never think in pages. `more` is the phone's counter:
 * each tap of "Load more" renders one page-worth further, from the top of the
 * current page, in a single query — so nothing is re-read from a stale offset
 * and no row can appear twice at a seam.
 *
 * Capped. Past a hundred rows on a phone the answer is not another tap, it is a
 * filter, and the pager takes over so the reader can still move forward.
 */
export const MAX_LOAD_MORE = 4;

/** Where in the list we are. Not a filter — a saved view must not remember it. */
export type InboxPosition = {
  /** 1-based, or null when the URL did not say and something else may decide. */
  page: number | null;
  more: number;
};

export function parseInboxPosition(params: RawParams): InboxPosition {
  const page = Number.parseInt(one(params.page) ?? "", 10);
  const more = Number.parseInt(one(params.more) ?? "", 10);

  return {
    page: Number.isInteger(page) && page > 0 ? page : null,
    more: Number.isInteger(more) && more > 0 ? Math.min(more, MAX_LOAD_MORE) : 0,
  };
}

/** `/inbox?…`, with the position appended when it is not the default. */
export function inboxHref(state: InboxFilterState, position: Partial<InboxPosition> = {}): string {
  const params = inboxFilterParams(state);
  if (position.page && position.page > 1) params.set("page", String(position.page));
  if (position.more && position.more > 0) params.set("more", String(position.more));

  const query = params.toString();
  return query ? `/inbox?${query}` : "/inbox";
}

/**
 * Is anything actually narrowing the list?
 *
 * `sort` is excluded on purpose: reordering is not filtering, and "clear
 * filters" must not silently throw away the reader's chosen order.
 */
export function hasActiveFilters(state: InboxFilterState): boolean {
  return Boolean(
    state.source ||
    state.sentiment ||
    state.theme ||
    state.query ||
    state.reply ||
    state.status.length > 0 ||
    state.rating.length > 0 ||
    state.assignee ||
    state.overdue ||
    state.from ||
    state.to,
  );
}

/** The filters a chip can toggle. `sort` is set, never toggled — it has no "off". */
export type ToggleableFilter = Exclude<keyof InboxFilterState, "sort">;

/**
 * Toggling: selecting the value that is already active clears it.
 *
 * Every filter chip in the bar is a link to the result of this, which is why it
 * lives beside the parser rather than in the component — P2-T3's saved views
 * build the same objects without rendering anything.
 *
 * Three behaviours, because the state has three shapes: a set gains or loses the
 * value, a flag flips, and a single value clears when it is already the one
 * selected.
 */
export function toggleFilter(
  state: InboxFilterState,
  key: ToggleableFilter,
  value: string | number,
): InboxFilterState {
  const current = state[key];

  if (Array.isArray(current)) {
    const list: unknown[] = current;
    const next = list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
    return { ...state, [key]: next } as InboxFilterState;
  }

  if (typeof current === "boolean") {
    return { ...state, [key]: !current } as InboxFilterState;
  }

  return { ...state, [key]: current === value ? null : value } as InboxFilterState;
}
