import { and, eq, isNull } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import type { Cadence } from "./period.ts";

/**
 * Reading and writing a person's report schedule (P3-T5).
 *
 * Kept apart from the pipeline for the reason every other module here splits
 * the same way: the pipeline is reached by a scheduler with no session, this is
 * reached by a signed-in member and handed a tenant transaction that already
 * carries their organization.
 */

export type ScheduleState = {
  enabled: boolean;
  cadence: Cadence;
  /** Null means every branch the recipient may see. */
  locationId: string | null;
};

/** The caller's own schedule for a scope, or null if they have never set one. */
export async function getSchedule(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
  locationId: string | null,
): Promise<ScheduleState | null> {
  const [row] = await tx
    .select({
      enabled: schema.reportSchedules.enabled,
      cadence: schema.reportSchedules.cadence,
      locationId: schema.reportSchedules.locationId,
    })
    .from(schema.reportSchedules)
    .where(
      and(
        eq(schema.reportSchedules.organizationId, organizationId),
        eq(schema.reportSchedules.userId, userId),
        // `IS NULL` rather than `= null`: the org-wide schedule is the row with
        // no location, and SQL equality never matches null.
        locationId === null
          ? isNull(schema.reportSchedules.locationId)
          : eq(schema.reportSchedules.locationId, locationId),
      ),
    )
    .limit(1);

  return row ? { ...row, cadence: row.cadence as Cadence } : null;
}

/**
 * Turns a schedule on, off, or changes its cadence.
 *
 * Upsert on `(organization, user, location)`, which is the unique key — the
 * same person asking twice for the same scope is one arrangement, not two, and
 * two rows would mail the same PDF twice.
 *
 * Disabling keeps the row rather than deleting it, so the cadence somebody
 * chose survives switching it off for a month and back on.
 */
export async function setSchedule(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
  input: ScheduleState,
): Promise<ScheduleState> {
  const [row] = await tx
    .insert(schema.reportSchedules)
    .values({
      organizationId,
      userId,
      locationId: input.locationId,
      cadence: input.cadence,
      enabled: input.enabled,
    })
    .onConflictDoUpdate({
      target: [
        schema.reportSchedules.organizationId,
        schema.reportSchedules.userId,
        schema.reportSchedules.locationId,
      ],
      set: { cadence: input.cadence, enabled: input.enabled, updatedAt: new Date() },
    })
    .returning({
      enabled: schema.reportSchedules.enabled,
      cadence: schema.reportSchedules.cadence,
      locationId: schema.reportSchedules.locationId,
    });

  if (!row) throw new Error("Could not save the report schedule.");
  return { ...row, cadence: row.cadence as Cadence };
}
