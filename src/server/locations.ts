"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withAuthenticatedTenant } from "@/auth/session";
import { connectSource, syncConnectionWithin, toConnection } from "@/connectors/sync";
import { ConnectorError } from "@/connectors/types";
import { schema } from "@/db/client";
import { EntitlementError, requireWithinLimit } from "@/lib/entitlements";
import { childLogger } from "@/lib/logger";
import { writeActiveLocationCookie } from "@/lib/active-location";
import { connectSourceSchema, parseCreateLocation, syncNowSchema } from "@/server/location-input";

/**
 * Location and source-connection mutations.
 *
 * Every action here is gated twice: by role (can this member do it?) and by
 * entitlement (does the plan allow it?). Both checks are server-side. The UI
 * mirrors them for affordance only and is never the thing enforcing them.
 */

const log = childLogger({ module: "server/locations" });

export type ActionResult = { ok: true } | { ok: false; error: string; code?: string };

function toResult(error: unknown): ActionResult {
  if (error instanceof EntitlementError) {
    return { ok: false, error: error.message, code: `entitlement:${error.key}` };
  }
  if (error instanceof ConnectorError) {
    return { ok: false, error: error.message, code: `connector:${error.provider}` };
  }
  if (error instanceof Error) {
    return { ok: false, error: error.message };
  }
  return { ok: false, error: "Something went wrong." };
}

export async function createLocationAction(formData: FormData): Promise<ActionResult> {
  const parsed = parseCreateLocation(formData);

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const locationId = await withAuthenticatedTenant(
      async (tx, actor) => {
        // Plan limits are checked against live rows inside the same tenant
        // transaction, so two concurrent creates cannot both slip past.
        await requireWithinLimit({ organizationId: actor.organizationId, tx }, "max_locations");

        const [row] = await tx
          .insert(schema.locations)
          .values({
            organizationId: actor.organizationId,
            name: parsed.data.name,
            address: parsed.data.address,
            category: parsed.data.category,
          })
          .returning({ id: schema.locations.id });

        if (!row) throw new Error("Could not create the location.");

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "location.created",
          entity: `location:${row.id}`,
          meta: { name: parsed.data.name },
        });

        return row.id;
      },
      { minimumRole: "admin" },
    );

    // Make the location the user just created the one they are looking at.
    await writeActiveLocationCookie(locationId);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "createLocation failed");
    return toResult(error);
  }
}

/**
 * Connects the Mock source to a location and pulls its reviews immediately.
 *
 * The first sync runs inline rather than through the queue so the slice works
 * without a worker process, and so the user sees reviews the moment they
 * connect instead of staring at an empty Inbox. The scheduled worker from T8
 * keeps it fresh from then on.
 */
export async function connectMockSourceAction(input: {
  locationId: string;
}): Promise<ActionResult> {
  const parsed = connectSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid location." };

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        const [location] = await tx
          .select({ id: schema.locations.id })
          .from(schema.locations)
          .where(eq(schema.locations.id, parsed.data.locationId))
          .limit(1);

        // RLS already hides other tenants' locations; this turns a silent
        // no-op into a clear message.
        if (!location) throw new Error("That location does not exist.");

        const connection = await connectSource(tx, {
          organizationId: actor.organizationId,
          provider: "mock",
          config: {
            locationId: parsed.data.locationId,
            backfillCount: 40,
            dripIntervalMinutes: 60,
          },
        });

        const outcome = await syncConnectionWithin(tx, toConnection(connection));

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "connection.created",
          entity: `connection:${connection.id}`,
          meta: { provider: "mock", inserted: outcome.inserted },
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "connectMockSource failed");
    return toResult(error);
  }
}

/** Pulls any new reviews for one connection on demand. */
export async function syncNowAction(input: { connectionId: string }): Promise<ActionResult> {
  const parsed = syncNowSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid connection." };

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        const [row] = await tx
          .select()
          .from(schema.connections)
          .where(eq(schema.connections.id, parsed.data.connectionId))
          .limit(1);

        if (!row) throw new Error("That connection does not exist.");
        if (row.organizationId !== actor.organizationId) {
          throw new Error("That connection does not exist.");
        }

        await syncConnectionWithin(tx, toConnection(row));
      },
      { minimumRole: "member" },
    );

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "syncNow failed");
    return toResult(error);
  }
}
