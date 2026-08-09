import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { LocationScope } from "../auth/scope.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";

/**
 * Direct messages that arrived as *review items* (A22-C1).
 *
 * **Why this exists at all.** The product has DMs in two tables and both are
 * right for what put them there. A WhatsApp message that reaches the webhook is
 * a `messages` row keyed on a contact, because we know who wrote it and can
 * write back inside Meta's window. An Instagram DM comes off the
 * `conversations` edge during a *sync* (P1b-T4) and lands in `reviews` with
 * `item_type = 'dm'`, because a connector's job is to normalise what a platform
 * gives it and what it gives is an item with an author name and no contact.
 *
 * Nobody had ever put those on a screen together, so a DM ingested by a
 * connector was only visible in the review queue — where it was counted as a
 * review, and where answering it is deliberately not built. Taking it out of
 * that queue without this would have made it invisible, which is worse than
 * miscounted.
 *
 * **Read-only, and that is not an oversight.** Answering needs the consent gate
 * extended to Instagram plus Meta's 24-hour window (`CLAUDE.md`, P1b-T4), and
 * the reply composer already refuses a DM with that reason. This lists them so
 * a business can *read* what was sent to it.
 */

export type DirectMessageItem = {
  id: string;
  source: string;
  authorName: string | null;
  text: string | null;
  at: Date;
  locationId: string;
};

/**
 * The location scope, applied to `reviews` rather than to a contact.
 *
 * `src/contacts/scope.ts` cannot help here — these have no contact — so this is
 * the ordinary rule the review queue uses: the scope is the filter, and an empty
 * scope returns nothing rather than everything.
 */
function scopeClause(scope: LocationScope) {
  if (scope.all) return undefined;
  if (scope.locationIds.length === 0) return sql`false`;
  return inArray(schema.reviews.locationId, scope.locationIds);
}

export async function listDirectMessageItems(
  tx: TenantDatabase,
  organizationId: string,
  scope: LocationScope,
  options: { limit?: number; before?: Date } = {},
): Promise<DirectMessageItem[]> {
  const at = sql<Date>`coalesce(${schema.reviews.postedAt}, ${schema.reviews.createdAt})`;

  const rows = await tx
    .select({
      id: schema.reviews.id,
      source: schema.reviews.source,
      authorName: schema.reviews.authorName,
      text: schema.reviews.text,
      at,
      locationId: schema.reviews.locationId,
    })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.itemType, "dm"),
        scopeClause(scope),
        options.before ? lt(at, options.before) : undefined,
      ),
    )
    .orderBy(desc(at))
    .limit(options.limit ?? 50);

  return rows.map((row) => ({ ...row, at: new Date(row.at) }));
}
