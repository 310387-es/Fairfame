import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/client.ts";
import { roleAtLeast, type Role } from "../auth/permissions.ts";
import { requireFeature } from "../lib/entitlements.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { inboxFilterParams, parseInboxFilters, type InboxFilterState } from "./filters.ts";

/**
 * Saved views (P2-T3).
 *
 * A saved view is a filter combination with a name — "my overdue negatives",
 * "everything from Google this week". Two kinds, distinguished only by whether
 * `owner_user_id` is set: a private view belongs to one person, a shared view
 * belongs to the organization.
 *
 * What is stored is the **query string**, as a flat record of strings, not a
 * parsed object. That is deliberate. `parseInboxFilters` is already the tolerant
 * validator for exactly this shape — it is what reads the URL — so storing the
 * same thing means a saved view is validated by the code that was going to
 * validate it anyway, and a filter that is removed in a later release degrades
 * to "ignore that key" instead of needing a migration over every stored row.
 * A second Zod schema mirroring `InboxFilterState` would be a second definition
 * of what a filter is, and the two would drift.
 */

/**
 * How many views one person may keep.
 *
 * A cap rather than a plan limit: the chips render in a row, and a hundred of
 * them is not a power user, it is a broken screen. The *entitlement* gate —
 * whether this organization gets saved views at all — is P2-T8 and is separate.
 */
export const MAX_SAVED_VIEWS_PER_OWNER = 20;

/** The stored jsonb: whatever `inboxFilterParams` produced, as plain strings. */
const storedFiltersSchema = z.record(z.string(), z.string());

export const savedViewNameSchema = z.string().trim().min(1).max(60);

export type SavedViewRecord = {
  id: string;
  name: string;
  /** True when this belongs to the organization rather than to one person. */
  shared: boolean;
  filters: InboxFilterState;
  /** The `/reviews?…` this view opens. */
  href: string;
  position: number;
};

/**
 * A stored blob that is not a flat string record is treated as an empty filter
 * set rather than as an error: the view still opens, it just shows everything,
 * which is a far better failure than a screen that will not render.
 */
function toFilterState(stored: unknown): InboxFilterState {
  const parsed = storedFiltersSchema.safeParse(stored ?? {});
  return parseInboxFilters(parsed.success ? parsed.data : {});
}

/**
 * The views this person may see: their own, plus everything shared.
 *
 * Shared first, then each person's own — a team's agreed queues are the ones
 * that should be reachable without thinking, and a private view is easier to
 * find because you made it.
 */
export async function listSavedViews(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
): Promise<SavedViewRecord[]> {
  const rows = await tx
    .select({
      id: schema.savedViews.id,
      name: schema.savedViews.name,
      ownerUserId: schema.savedViews.ownerUserId,
      filters: schema.savedViews.filters,
      position: schema.savedViews.position,
    })
    .from(schema.savedViews)
    .where(
      and(
        eq(schema.savedViews.organizationId, organizationId),
        // RLS already keeps other tenants out; this keeps other *people* out.
        or(isNull(schema.savedViews.ownerUserId), eq(schema.savedViews.ownerUserId, userId)),
      ),
    )
    .orderBy(
      asc(sql`${schema.savedViews.ownerUserId} is not null`),
      asc(schema.savedViews.position),
      asc(schema.savedViews.name),
    );

  return rows.map((row) => {
    const filters = toFilterState(row.filters);
    return {
      id: row.id,
      name: row.name,
      shared: row.ownerUserId === null,
      filters,
      href: (() => {
        const params = inboxFilterParams(filters);
        const query = params.toString();
        return query ? `/reviews?${query}` : "/reviews";
      })(),
      position: row.position,
    };
  });
}

export class SavedViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SavedViewError";
  }
}

/**
 * Creating a view.
 *
 * A **shared** view is organization configuration — it appears on every
 * teammate's screen — so it needs admin. A private view needs nothing beyond
 * membership: it changes only what its author sees.
 */
export async function createSavedView(
  tx: TenantDatabase,
  input: {
    organizationId: string;
    userId: string;
    role: Role;
    name: string;
    shared: boolean;
    filters: InboxFilterState;
  },
): Promise<SavedViewRecord> {
  // The plan gate, in the data layer rather than the action (P2-T8): the next
  // caller — an import, an API, a template that ships default views — gets the
  // same answer without having to remember to ask.
  await requireFeature({ organizationId: input.organizationId, tx }, "saved_views");

  const name = savedViewNameSchema.parse(input.name);

  if (input.shared && !roleAtLeast(input.role, "admin")) {
    throw new SavedViewError("Only an admin can save a view for the whole team.");
  }

  const ownerUserId = input.shared ? null : input.userId;

  const [existing] = await tx
    .select({
      count: sql<number>`count(*)::int`.mapWith(Number),
      next: sql<number>`coalesce(max(${schema.savedViews.position}), -1) + 1`.mapWith(Number),
    })
    .from(schema.savedViews)
    .where(
      and(
        eq(schema.savedViews.organizationId, input.organizationId),
        ownerUserId === null
          ? isNull(schema.savedViews.ownerUserId)
          : eq(schema.savedViews.ownerUserId, ownerUserId),
      ),
    );

  if ((existing?.count ?? 0) >= MAX_SAVED_VIEWS_PER_OWNER) {
    throw new SavedViewError(`A maximum of ${MAX_SAVED_VIEWS_PER_OWNER} saved views is allowed.`);
  }

  // The filter state goes in as the query string it came from, so what is
  // stored is exactly what the URL would have said.
  const filters = Object.fromEntries(inboxFilterParams(input.filters).entries());

  const [row] = await tx
    .insert(schema.savedViews)
    .values({
      organizationId: input.organizationId,
      ownerUserId,
      name,
      filters,
      position: existing?.next ?? 0,
    })
    // Saving twice under the same name updates it rather than failing on the
    // unique key. "Save view" on a name you already use reads as "update it",
    // and an error message about a constraint would be the wrong answer.
    .onConflictDoUpdate({
      target: [
        schema.savedViews.organizationId,
        schema.savedViews.ownerUserId,
        schema.savedViews.name,
      ],
      set: { filters, updatedAt: new Date() },
    })
    .returning({
      id: schema.savedViews.id,
      name: schema.savedViews.name,
      ownerUserId: schema.savedViews.ownerUserId,
      position: schema.savedViews.position,
    });

  if (!row) throw new SavedViewError("Could not save the view.");

  const params = inboxFilterParams(input.filters).toString();

  return {
    id: row.id,
    name: row.name,
    shared: row.ownerUserId === null,
    filters: input.filters,
    href: params ? `/reviews?${params}` : "/reviews",
    position: row.position,
  };
}

/**
 * Deleting a view.
 *
 * The predicate is the permission. A member may delete their own view; a shared
 * view needs admin. Expressed in the WHERE clause rather than as a read followed
 * by a check, so there is no window between deciding and doing — and so a member
 * naming a colleague's view id simply deletes nothing.
 */
export async function deleteSavedView(
  tx: TenantDatabase,
  input: { organizationId: string; userId: string; role: Role; id: string },
): Promise<boolean> {
  const mayDeleteShared = roleAtLeast(input.role, "admin");

  const deleted = await tx
    .delete(schema.savedViews)
    .where(
      and(
        eq(schema.savedViews.organizationId, input.organizationId),
        eq(schema.savedViews.id, input.id),
        mayDeleteShared
          ? or(
              isNull(schema.savedViews.ownerUserId),
              eq(schema.savedViews.ownerUserId, input.userId),
            )
          : eq(schema.savedViews.ownerUserId, input.userId),
      ),
    )
    .returning({ id: schema.savedViews.id });

  return deleted.length > 0;
}
