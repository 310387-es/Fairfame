import { and, asc, desc, eq, gte, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { LocationScope } from "../auth/scope.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { CONTACT_ID, contactScopeClause, contactVisibleClause } from "./scope.ts";
import { tagsForContacts, type ContactTag } from "./tags.ts";
import type { ContactFilterState } from "./filters.ts";

/**
 * Reading the contact list (P4-T1).
 *
 * One predicate, built once, shared by the list, the total that drives the
 * pager, and the count shown beside every segment. Written twice, the pager
 * would sooner or later count rows the list does not show, and a segment would
 * promise an audience of forty that sends to thirty-eight — which is the
 * version of that bug that costs money.
 *
 * Everything here is additionally narrowed by `contactScopeClause`, which is the
 * only interpreter of "may this member see this person". See ./scope.ts.
 */

export const CONTACTS_PAGE_SIZE = 25;

/**
 * `%` and `_` are LIKE wildcards, so a search for "50%" would otherwise match
 * everyone. Escaped exactly as `inbox/queries.ts` and `search/queries.ts` do.
 */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Case- and diacritic-folded matching, identical to the review search.
 *
 * Migration 0022 explains why this is not `lower()` alone: in Turkish, `Şule`
 * and `Sule` are the same name typed on two keyboards, and a customer list that
 * cannot find the second is a list people scroll instead of searching.
 */
function foldedMatch(column: unknown, pattern: string): SQL {
  return sql`lower(immutable_unaccent(${column})) like lower(immutable_unaccent(${pattern}))`;
}

/** Bounds how expensive one pasted paragraph can make a query. */
const MAX_SEARCH_TERMS = 6;

/**
 * Every word must appear somewhere in the name, the email or the phone.
 *
 * Across fields rather than within one, so "ayse gmail" finds Ayşe at Gmail —
 * which is how people actually search a customer list.
 */
function searchPredicate(query: string): SQL | undefined {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .slice(0, MAX_SEARCH_TERMS);

  if (terms.length === 0) return undefined;

  return and(
    ...terms.map((term) =>
      or(
        foldedMatch(schema.contacts.name, likePattern(term)),
        foldedMatch(schema.contacts.email, likePattern(term)),
        // Phone numbers are stored as given, so a search for "532" has to match
        // mid-string. Folding is harmless here and keeps one expression.
        foldedMatch(schema.contacts.phone, likePattern(term)),
      ),
    ),
  );
}

/**
 * Holds a live local İYS permission for this channel.
 *
 * **Not the send gate.** `checkSendAllowed` is, and it additionally asks the
 * registry and re-reads the opt-out at the moment of sending — see the note on
 * `ContactFilterState.consent`. This predicate narrows a list to plausible
 * recipients; it never authorises anything.
 */
function consentPredicate(organizationId: string, channel: "email" | "message"): SQL {
  return sql`exists (
    select 1
      from ${schema.consentRecords} cr
     where cr.organization_id = ${organizationId}
       and cr.contact_ref = ${CONTACT_ID}::text
       and cr.type = 'iys'
       and cr.channel = ${channel}::consent_channel
       and cr.granted_at is not null
       and cr.revoked_at is null
  )`;
}

/** Carries every one of these tags — an intersection, not a union. */
function tagPredicates(slugs: string[]): SQL[] {
  return slugs.map(
    (slug) => sql`exists (
      select 1
        from ${schema.contactTags} ct
       where ct.contact_id = ${CONTACT_ID}
         and ct.slug = ${slug}
    )`,
  );
}

/** Interacted with this one branch. Narrower than, and on top of, the scope. */
function locationPredicate(locationId: string): SQL {
  return sql`exists (
    select 1
      from ${schema.reviewRequests} rr
     where rr.contact_id = ${CONTACT_ID}
       and rr.location_id = ${locationId}
  )`;
}

function endOfDay(isoDate: string): Date {
  return new Date(`${isoDate}T23:59:59.999Z`);
}

/**
 * The whole WHERE clause, from a filter state and a scope.
 *
 * Exported so P4-T4's campaign audience can resolve a segment through the same
 * predicate that produced the number the business was shown when they saved it.
 */
export function contactsWhere(input: {
  organizationId: string;
  scope: LocationScope;
  filters: ContactFilterState;
}): SQL | undefined {
  const { organizationId, scope, filters } = input;

  return and(
    eq(schema.contacts.organizationId, organizationId),
    contactScopeClause(scope),
    filters.query ? searchPredicate(filters.query) : undefined,
    ...tagPredicates(filters.tags),
    filters.subscription === "subscribed" ? isNull(schema.contacts.unsubscribedAt) : undefined,
    filters.subscription === "unsubscribed" ? isNotNull(schema.contacts.unsubscribedAt) : undefined,
    filters.channel === "email" ? isNotNull(schema.contacts.email) : undefined,
    filters.channel === "phone" ? isNotNull(schema.contacts.phone) : undefined,
    filters.consent ? consentPredicate(organizationId, filters.consent) : undefined,
    filters.locationId ? locationPredicate(filters.locationId) : undefined,
    filters.from
      ? gte(schema.contacts.createdAt, new Date(`${filters.from}T00:00:00.000Z`))
      : undefined,
    filters.to ? lte(schema.contacts.createdAt, endOfDay(filters.to)) : undefined,
  );
}

/**
 * When something last happened with this person.
 *
 * `greatest` over the three stamps we actually hold: the most recent ask, and
 * either side of a WhatsApp conversation. Null when nothing has happened, which
 * a bare `max()` would render as an epoch date on the screen.
 *
 * P4-T2 and P4-T3 add survey responses and messages; both become another
 * argument here.
 *
 * Typed `string | Date` because that is what actually arrives. `pg` parses a
 * declared `timestamptz` *column* into a Date, but the result of an expression
 * reached through `sql` comes back as the raw string — so claiming `Date` here
 * would type-check and then hand a string to anything calling `.getTime()`.
 * Both callers normalise with `new Date(...)`, which is right for either.
 */
const lastActivityAt = sql<string | Date | null>`greatest(
  (select max(rr.created_at) from ${schema.reviewRequests} rr where rr.contact_id = ${CONTACT_ID}),
  (select max(sr.created_at) from ${schema.surveyResponses} sr where sr.contact_id = ${CONTACT_ID}),
  (select max(sr.answered_at) from ${schema.surveyResponses} sr where sr.contact_id = ${CONTACT_ID}),
  (select wc.last_inbound_at from ${schema.whatsappConversations} wc where wc.contact_id = ${CONTACT_ID}),
  (select wc.last_outbound_at from ${schema.whatsappConversations} wc where wc.contact_id = ${CONTACT_ID})
)`;

/** Reviews this person actually left, not asks they were sent. */
const reviewCount = sql<number>`(
  select count(*)::int
    from ${schema.reviewRequests} rr
   where rr.contact_id = ${CONTACT_ID}
     and rr.review_id is not null
)`;

export type ContactRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  locale: string | null;
  unsubscribedAt: Date | null;
  createdAt: Date;
  lastActivityAt: Date | null;
  reviewCount: number;
  tags: ContactTag[];
};

export type ContactPage = {
  rows: ContactRow[];
  total: number;
  page: number;
  pageCount: number;
};

function orderBy(sort: ContactFilterState["sort"]): SQL[] {
  switch (sort) {
    case "name":
      // Folded, so `Ş` sorts beside `S` rather than after `Z` under a C
      // collation. Nameless contacts go last: a list that opens with six blank
      // rows looks broken.
      return [
        asc(sql`${schema.contacts.name} is null`),
        asc(sql`lower(immutable_unaccent(${schema.contacts.name}))`),
      ];
    case "activity":
      return [desc(sql`${lastActivityAt} nulls last`), desc(schema.contacts.createdAt)];
    case "recent":
      return [desc(schema.contacts.createdAt)];
  }
}

export async function listContacts(input: {
  tx: TenantDatabase;
  organizationId: string;
  scope: LocationScope;
  filters: ContactFilterState;
  page: number;
  pageSize?: number;
}): Promise<ContactPage> {
  const { tx, organizationId, scope, filters } = input;
  const pageSize = input.pageSize ?? CONTACTS_PAGE_SIZE;
  const where = contactsWhere({ organizationId, scope, filters });

  const [totals] = await tx
    .select({ value: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.contacts)
    .where(where);

  const total = totals?.value ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  // A page number past the end shows the last page rather than nothing: the
  // usual way to get there is deleting rows while holding a bookmark.
  const page = Math.min(Math.max(1, input.page), pageCount);

  const rows = await tx
    .select({
      id: schema.contacts.id,
      name: schema.contacts.name,
      email: schema.contacts.email,
      phone: schema.contacts.phone,
      locale: schema.contacts.locale,
      unsubscribedAt: schema.contacts.unsubscribedAt,
      createdAt: schema.contacts.createdAt,
      lastActivityAt,
      reviewCount: reviewCount.mapWith(Number),
    })
    .from(schema.contacts)
    .where(where)
    .orderBy(...orderBy(filters.sort))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const tags = await tagsForContacts(
    tx,
    organizationId,
    rows.map((row) => row.id),
  );

  return {
    rows: rows.map((row) => ({
      ...row,
      // `greatest` returns whatever the driver made of a timestamp; normalise
      // so callers never have to guess whether they hold a Date or a string.
      lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt) : null,
      tags: tags.get(row.id) ?? [],
    })),
    total,
    page,
    pageCount,
  };
}

/** How many contacts a filter matches. What a segment chip shows. */
export async function countContacts(input: {
  tx: TenantDatabase;
  organizationId: string;
  scope: LocationScope;
  filters: ContactFilterState;
}): Promise<number> {
  const [row] = await input.tx
    .select({ value: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.contacts)
    .where(
      contactsWhere({
        organizationId: input.organizationId,
        scope: input.scope,
        filters: input.filters,
      }),
    );

  return row?.value ?? 0;
}

export type ContactProfile = ContactRow & {
  updatedAt: Date;
};

/**
 * One contact, or null.
 *
 * Null covers both "no such row" and "not yours to see", deliberately: telling
 * a restricted member that a contact exists but is out of their scope leaks the
 * thing the scope was hiding.
 */
export async function getContact(input: {
  tx: TenantDatabase;
  organizationId: string;
  scope: LocationScope;
  contactId: string;
}): Promise<ContactProfile | null> {
  const [row] = await input.tx
    .select({
      id: schema.contacts.id,
      name: schema.contacts.name,
      email: schema.contacts.email,
      phone: schema.contacts.phone,
      locale: schema.contacts.locale,
      unsubscribedAt: schema.contacts.unsubscribedAt,
      createdAt: schema.contacts.createdAt,
      updatedAt: schema.contacts.updatedAt,
      lastActivityAt,
      reviewCount: reviewCount.mapWith(Number),
    })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.organizationId, input.organizationId),
        contactVisibleClause(input.scope, input.contactId),
      ),
    )
    .limit(1);

  if (!row) return null;

  const tags = await tagsForContacts(input.tx, input.organizationId, [row.id]);

  return {
    ...row,
    lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt) : null,
    tags: tags.get(row.id) ?? [],
  };
}
