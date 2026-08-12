/**
 * What the contact list is currently showing, as one object (P4-T1).
 *
 * The Phase 4 counterpart to `src/reviews/filters.ts`, and it exists for the same
 * reason: the URL shape is defined **once, here**, rather than rebuilt by the
 * page, the pager, the filter bar and the segment store from four private lists
 * of parameter names. In the Inbox that saved a filter from being silently
 * dropped on "next page"; here it also means a **segment** — a saved audience —
 * is stored in the one format this module already knows how to validate.
 *
 * Deliberately free of database imports. `contact_segments` stores these as
 * query-string pairs and client components render them, and a module that
 * reaches `db/client` cannot be imported by a `"use client"` file at all.
 */

export const CONTACT_SORTS = ["recent", "name", "activity"] as const;
export type ContactSort = (typeof CONTACT_SORTS)[number];

/** Whether the person has opted out. Not the same question as consent. */
export const SUBSCRIPTION_STATES = ["subscribed", "unsubscribed"] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

/** Do we hold an address of this kind at all? */
export const CONTACT_CHANNELS = ["email", "phone"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/**
 * Channels a *local* permission can cover, in İYS's own vocabulary.
 *
 * `message` covers SMS and WhatsApp, `email` covers email. Deliberately İYS's
 * three-way split minus `call`, which this product never places.
 */
export const CONSENT_CHANNELS = ["email", "message"] as const;
export type ConsentChannelFilter = (typeof CONSENT_CHANNELS)[number];

export type ContactFilterState = {
  /** Free text over name, email and phone. */
  query: string | null;
  /** Tag slugs. **Every** one must be present — "VIP *and* complained". */
  tags: string[];
  /** Opted out, or not. Null means either. */
  subscription: SubscriptionState | null;
  /** Holds an address of this kind. Null means either. */
  channel: ContactChannel | null;
  /**
   * Holds a live local İYS permission for this channel.
   *
   * **This narrows a list; it does not authorise a send.** The only thing that
   * may decide whether a message leaves is `checkSendAllowed` in
   * `src/compliance/gate.ts`, which additionally asks the registry itself and
   * re-checks the opt-out at the moment of sending. A SQL predicate cannot make
   * a network call, so it must never be mistaken for the gate: a segment built
   * on this is a *candidate* audience, and P4-T4 still runs every recipient
   * through the gate one at a time.
   */
  consent: ConsentChannelFilter | null;
  /** Interacted with this branch. See `src/contacts/scope.ts` for what that means. */
  locationId: string | null;
  /** Inclusive `YYYY-MM-DD`, UTC — when the contact was first recorded. */
  from: string | null;
  /** Inclusive `YYYY-MM-DD`, UTC — the whole of that day counts. */
  to: string | null;
  sort: ContactSort;
};

export const EMPTY_CONTACT_FILTERS: ContactFilterState = {
  query: null,
  tags: [],
  subscription: null,
  channel: null,
  consent: null,
  locationId: null,
  from: null,
  to: null,
  sort: "recent",
};

/** The URL parameter each filter is written as. `q` because people type it. */
const PARAM = {
  query: "q",
  tags: "tag",
  subscription: "sub",
  channel: "has",
  consent: "consent",
  locationId: "location",
  from: "from",
  to: "to",
  sort: "sort",
} as const satisfies Record<keyof ContactFilterState, string>;

/** Anything Next.js hands us from a query string. */
export type RawParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : null;
}

/** `?tag=vip,kurumsal` — a repeated parameter works too. */
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A date that is not a date is no filter at all, rather than an error page.
 *
 * The round-trip is the part that matters. `Date.parse("2026-02-30")` does not
 * fail — JavaScript rolls it forward to 2 March — so a shape check plus
 * `isNaN` would accept a day that does not exist and silently filter from the
 * wrong one. Re-formatting the parsed date and comparing is the only way to
 * catch it. (`src/reviews/filters.ts` has the same guard, for the same reason.)
 */
function isoDate(value: string | null): string | null {
  if (value === null || !ISO_DATE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === value ? value : null;
}

/**
 * How many tags one filter may carry.
 *
 * Each adds an EXISTS clause to the query, so this bounds how expensive a
 * hand-edited URL can be. Past a handful the intersection is empty anyway.
 */
export const MAX_FILTER_TAGS = 8;

/**
 * Reads filter state out of a query string.
 *
 * Every value is user input — typed, pasted, or a segment saved against an
 * older release — so anything unrecognised degrades to "no filter" rather than
 * throwing. A stale bookmark should show more contacts than intended, never a
 * crash.
 */
export function parseContactFilters(params: RawParams): ContactFilterState {
  const tags = many(params[PARAM.tags]);
  const locationId = one(params[PARAM.locationId]);

  return {
    query: one(params[PARAM.query]),
    // Deduped and sorted so two URLs meaning the same thing serialize
    // identically — which is what lets a segment be compared to the list on
    // screen, and what stops "save segment" creating a near-duplicate.
    tags: [...new Set(tags)].sort().slice(0, MAX_FILTER_TAGS),
    subscription: memberOf(SUBSCRIPTION_STATES, one(params[PARAM.subscription])),
    channel: memberOf(CONTACT_CHANNELS, one(params[PARAM.channel])),
    consent: memberOf(CONSENT_CHANNELS, one(params[PARAM.consent])),
    // Checked for shape here rather than at the query, so a malformed id never
    // reaches a uuid comparison Postgres would reject with a 500.
    locationId: locationId && UUID.test(locationId) ? locationId : null,
    from: isoDate(one(params[PARAM.from])),
    to: isoDate(one(params[PARAM.to])),
    sort: memberOf(CONTACT_SORTS, one(params[PARAM.sort])) ?? "recent",
  };
}

/**
 * Writes filter state back into a query string.
 *
 * The inverse of `parseContactFilters`, and the only place a contact filter
 * becomes a URL. Defaults are omitted, so an unfiltered list is `/contacts`
 * rather than a string of empty parameters.
 */
export function contactFilterParams(state: ContactFilterState): URLSearchParams {
  const params = new URLSearchParams();

  if (state.query) params.set(PARAM.query, state.query);
  if (state.tags.length > 0) params.set(PARAM.tags, state.tags.join(","));
  if (state.subscription) params.set(PARAM.subscription, state.subscription);
  if (state.channel) params.set(PARAM.channel, state.channel);
  if (state.consent) params.set(PARAM.consent, state.consent);
  if (state.locationId) params.set(PARAM.locationId, state.locationId);
  if (state.from) params.set(PARAM.from, state.from);
  if (state.to) params.set(PARAM.to, state.to);
  if (state.sort !== "recent") params.set(PARAM.sort, state.sort);

  return params;
}

/** `/contacts?…`, with the page appended when it is not the first. */
export function contactsHref(state: ContactFilterState, page = 1): string {
  const params = contactFilterParams(state);
  if (page > 1) params.set("page", String(page));

  const query = params.toString();
  return query ? `/contacts?${query}` : "/contacts";
}

/** 1-based, and never zero or negative however the URL was edited. */
export function parseContactPage(params: RawParams): number {
  const page = Number.parseInt(one(params.page) ?? "", 10);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

/**
 * Is anything actually narrowing the list?
 *
 * `sort` is excluded on purpose: reordering is not filtering, and "clear
 * filters" must not silently throw away the reader's chosen order.
 */
export function hasActiveContactFilters(state: ContactFilterState): boolean {
  return Boolean(
    state.query ||
    state.tags.length > 0 ||
    state.subscription ||
    state.channel ||
    state.consent ||
    state.locationId ||
    state.from ||
    state.to,
  );
}

/**
 * Toggling: selecting the value that is already active clears it.
 *
 * Every chip in the filter bar is a link to the result of this, which is why it
 * lives beside the parser rather than in the component — the segment store
 * builds the same objects without rendering anything.
 */
export function toggleContactFilter(
  state: ContactFilterState,
  key: Exclude<keyof ContactFilterState, "sort">,
  value: string,
): ContactFilterState {
  if (key === "tags") {
    const next = state.tags.includes(value)
      ? state.tags.filter((entry) => entry !== value)
      : [...state.tags, value].slice(0, MAX_FILTER_TAGS);
    return { ...state, tags: [...new Set(next)].sort() };
  }

  return { ...state, [key]: state[key] === value ? null : value } as ContactFilterState;
}

/** The stored form of a segment: whatever `contactFilterParams` produced. */
export function contactFiltersToRecord(state: ContactFilterState): Record<string, string> {
  return Object.fromEntries(contactFilterParams(state).entries());
}
