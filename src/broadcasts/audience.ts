import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { LocationScope } from "../auth/scope.ts";
import { contactsWhere } from "../contacts/queries.ts";
import { parseContactFilters, type ContactFilterState } from "../contacts/filters.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";

/**
 * Who a broadcast goes to (P4-T4).
 *
 * **The promise P4-T1 made, kept.** `contactsWhere` was exported with the note
 * "so P4-T4's campaign audience can resolve a segment through the same
 * predicate that produced the number the business was shown when they saved
 * it". This is that caller. A second interpretation of what a segment means
 * would be a screen promising an audience of forty and a send reaching
 * thirty-eight — the version of that bug that costs money.
 *
 * Two things are added on top of the segment's own filter, and both are about
 * not sending to somebody we should not:
 *
 *   1. **An opt-out is excluded here, not only at the gate.** The gate would
 *      refuse them anyway, but a recipient row saying "we intended to message
 *      this person and were stopped" is a record of an intention nobody should
 *      have formed. `contacts.unsubscribed_at` is checked before the list is
 *      built.
 *   2. **The channel has to be reachable.** An email broadcast to somebody with
 *      no address is not a refusal, it is a mistake in the audience.
 */

export const MAX_AUDIENCE = 5_000;

export type AudienceContact = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
};

/** The filter a broadcast was queued with, or the segment's current one. */
export function audienceFilters(stored: unknown): ContactFilterState {
  const record =
    typeof stored === "object" && stored !== null
      ? (stored as Record<string, string | string[] | undefined>)
      : {};
  return parseContactFilters(record);
}

/**
 * Resolves an audience.
 *
 * **`scope` is the creator's location scope, resolved at send time** — the same
 * rule scheduled reports follow (P3-T5). A branch manager must not be able to
 * queue a broadcast that reaches the whole chain, and re-resolving at send time
 * rather than at save time means somebody whose scope was narrowed stops
 * reaching the people they no longer see.
 */
export async function resolveAudience(input: {
  tx: TenantDatabase;
  organizationId: string;
  scope: LocationScope;
  filters: ContactFilterState;
  channel: "email" | "sms" | "whatsapp" | "link";
  limit?: number;
}): Promise<AudienceContact[]> {
  const { tx, organizationId, scope, filters, channel } = input;

  // `link` has no recipients at all — nothing is sent, people arrive on their
  // own. Returning empty rather than throwing: the UI refuses to create one,
  // and a stored row from an older release should do nothing rather than crash
  // a worker.
  if (channel === "link") return [];

  const reachable =
    channel === "email"
      ? sql`${schema.contacts.email} is not null`
      : sql`${schema.contacts.phone} is not null`;

  return tx
    .select({
      id: schema.contacts.id,
      name: schema.contacts.name,
      email: schema.contacts.email,
      phone: schema.contacts.phone,
    })
    .from(schema.contacts)
    .where(
      and(
        contactsWhere({ organizationId, scope, filters }),
        // Never form the intention. See the module note.
        isNull(schema.contacts.unsubscribedAt),
        reachable,
      ),
    )
    .orderBy(schema.contacts.createdAt)
    .limit(input.limit ?? MAX_AUDIENCE);
}

/** How many people a filter would reach, for the screen that is about to send. */
export async function audienceSize(input: {
  tx: TenantDatabase;
  organizationId: string;
  scope: LocationScope;
  filters: ContactFilterState;
  channel: "email" | "sms" | "whatsapp" | "link";
}): Promise<number> {
  if (input.channel === "link") return 0;

  const reachable =
    input.channel === "email"
      ? sql`${schema.contacts.email} is not null`
      : sql`${schema.contacts.phone} is not null`;

  const [row] = await input.tx
    .select({ value: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.contacts)
    .where(
      and(
        contactsWhere({
          organizationId: input.organizationId,
          scope: input.scope,
          filters: input.filters,
        }),
        isNull(schema.contacts.unsubscribedAt),
        reachable,
      ),
    );

  return row?.value ?? 0;
}

/** The segment behind a broadcast, if it still exists. */
export async function segmentFilters(
  tx: TenantDatabase,
  organizationId: string,
  segmentId: string,
): Promise<ContactFilterState | null> {
  const [row] = await tx
    .select({ filters: schema.contactSegments.filters })
    .from(schema.contactSegments)
    .where(
      and(
        eq(schema.contactSegments.organizationId, organizationId),
        eq(schema.contactSegments.id, segmentId),
      ),
    )
    .limit(1);

  return row ? audienceFilters(row.filters) : null;
}
