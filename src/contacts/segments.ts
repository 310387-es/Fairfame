import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/client.ts";
import { roleAtLeast, type Role } from "../auth/permissions.ts";
import { requireFeature } from "../lib/entitlements.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import {
  contactFilterParams,
  contactFiltersToRecord,
  parseContactFilters,
  type ContactFilterState,
} from "./filters.ts";

/**
 * Segments — a named contact filter (P4-T1).
 *
 * Stores the **query string**, flat, for the reason `src/inbox/views.ts` sets
 * out: `parseContactFilters` is already the tolerant validator for exactly this
 * shape, so a segment is checked by the code that was going to check it anyway,
 * and a filter removed in a later release degrades to "ignore that key" rather
 * than needing a migration over every stored row. A second Zod schema mirroring
 * `ContactFilterState` would be a second definition of what a filter is.
 *
 * **A segment belongs to the organization, never to a person.** That is the one
 * departure from saved views and it is deliberate: P4-T4 points campaigns at
 * these, and messages sent to somebody's private list are messages the business
 * cannot account for afterwards. Creating one therefore needs admin.
 */

/**
 * How many segments an organization may keep.
 *
 * A cap rather than a plan limit — they render as a row of chips, and a hundred
 * of them is a broken screen rather than a power user. Whether the organization
 * gets the CRM at all is an entitlement, checked below.
 */
export const MAX_SEGMENTS = 20;

export const segmentNameSchema = z.string().trim().min(1).max(60);

/** The stored jsonb: whatever `contactFilterParams` produced, as plain strings. */
const storedFiltersSchema = z.record(z.string(), z.string());

export type SegmentRecord = {
  id: string;
  name: string;
  filters: ContactFilterState;
  /** The `/contacts?…` this segment opens. */
  href: string;
  position: number;
};

/**
 * A stored blob that is not a flat string record becomes an empty filter set
 * rather than an error: the segment still opens and shows everyone, which is a
 * far better failure than a screen that will not render.
 */
function toFilterState(stored: unknown): ContactFilterState {
  const parsed = storedFiltersSchema.safeParse(stored ?? {});
  return parseContactFilters(parsed.success ? parsed.data : {});
}

function hrefFor(filters: ContactFilterState): string {
  const query = contactFilterParams(filters).toString();
  return query ? `/contacts?${query}` : "/contacts";
}

export async function listSegments(
  tx: TenantDatabase,
  organizationId: string,
): Promise<SegmentRecord[]> {
  const rows = await tx
    .select({
      id: schema.contactSegments.id,
      name: schema.contactSegments.name,
      filters: schema.contactSegments.filters,
      position: schema.contactSegments.position,
    })
    .from(schema.contactSegments)
    .where(eq(schema.contactSegments.organizationId, organizationId))
    .orderBy(asc(schema.contactSegments.position), asc(schema.contactSegments.name));

  return rows.map((row) => {
    const filters = toFilterState(row.filters);
    return { id: row.id, name: row.name, filters, href: hrefFor(filters), position: row.position };
  });
}

export class SegmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentError";
  }
}

/**
 * Saves a segment.
 *
 * The entitlement is checked in the data layer rather than in the action, on the
 * P2-T8 precedent: the next caller — an import, an API, a template that ships
 * default segments — gets the same answer without having to remember to ask.
 */
export async function createSegment(
  tx: TenantDatabase,
  input: {
    organizationId: string;
    userId: string;
    role: Role;
    name: string;
    filters: ContactFilterState;
  },
): Promise<SegmentRecord> {
  await requireFeature({ organizationId: input.organizationId, tx }, "crm");

  if (!roleAtLeast(input.role, "admin")) {
    throw new SegmentError("Only an admin can save a segment.");
  }

  const name = segmentNameSchema.parse(input.name);

  const [existing] = await tx
    .select({
      count: sql<number>`count(*)::int`.mapWith(Number),
      next: sql<number>`coalesce(max(${schema.contactSegments.position}), -1) + 1`.mapWith(Number),
    })
    .from(schema.contactSegments)
    .where(eq(schema.contactSegments.organizationId, input.organizationId));

  if ((existing?.count ?? 0) >= MAX_SEGMENTS) {
    throw new SegmentError(`A maximum of ${MAX_SEGMENTS} segments is allowed.`);
  }

  const filters = contactFiltersToRecord(input.filters);

  const [row] = await tx
    .insert(schema.contactSegments)
    .values({
      organizationId: input.organizationId,
      name,
      filters,
      position: existing?.next ?? 0,
      createdByUserId: input.userId,
    })
    // Saving twice under one name updates it. "Save segment" on a name you
    // already use reads as "update it", and a unique-constraint error would be
    // the wrong answer to that.
    .onConflictDoUpdate({
      target: [schema.contactSegments.organizationId, schema.contactSegments.name],
      set: { filters, updatedAt: new Date() },
    })
    .returning({
      id: schema.contactSegments.id,
      name: schema.contactSegments.name,
      position: schema.contactSegments.position,
    });

  if (!row) throw new SegmentError("Could not save the segment.");

  return {
    id: row.id,
    name: row.name,
    filters: input.filters,
    href: hrefFor(input.filters),
    position: row.position,
  };
}

/** Deleting a segment. Admin, for the same reason creating one is. */
export async function deleteSegment(
  tx: TenantDatabase,
  input: { organizationId: string; role: Role; id: string },
): Promise<boolean> {
  if (!roleAtLeast(input.role, "admin")) {
    throw new SegmentError("Only an admin can delete a segment.");
  }

  const deleted = await tx
    .delete(schema.contactSegments)
    .where(
      and(
        eq(schema.contactSegments.organizationId, input.organizationId),
        eq(schema.contactSegments.id, input.id),
      ),
    )
    .returning({ id: schema.contactSegments.id });

  return deleted.length > 0;
}
