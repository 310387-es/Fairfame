"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withAuthenticatedTenant } from "@/auth/session";
import { connectSource, syncConnectionWithin, toConnection } from "@/connectors/sync";
import { schema } from "@/db/client";
import { requireWithinLimit } from "@/lib/entitlements";
import { childLogger } from "@/lib/logger";
import { writeActiveLocationCookie } from "@/lib/active-location";
import { toActionResult, type ActionResult } from "@/server/action-result";
import { FIRST_PARTY_PROVIDER } from "@/connectors/firstparty";
import { getProvider, resolveMode } from "@/connectors/providers";
import { requestAnalysis, requestNotifications } from "@/jobs/client";
import { connectSourceSchema, parseCreateLocation, syncNowSchema } from "@/server/location-input";

/**
 * Location and source-connection mutations.
 *
 * Every action here is gated twice: by role (can this member do it?) and by
 * entitlement (does the plan allow it?). Both checks are server-side. The UI
 * mirrors them for affordance only and is never the thing enforcing them.
 */

const log = childLogger({ module: "server/locations" });

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
    return toActionResult(error);
  }
}

/**
 * Connects a source that needs no authorization handshake.
 *
 * That is the mock, and any credentialed provider currently running in mock
 * mode — connecting a mocked Google is how the whole pipeline gets exercised
 * before the real one is approved. A provider that is genuinely live has a
 * consent screen instead, and the UI sends people to /api/connect/{provider}
 * rather than here; refusing it explicitly keeps the two paths from blurring.
 *
 * The first sync runs inline rather than through the queue so the slice works
 * without a worker process, and so the user sees reviews the moment they
 * connect instead of staring at an empty Inbox.
 */
export async function connectSourceAction(input: {
  locationId: string;
  provider: string;
}): Promise<ActionResult> {
  const parsed = connectSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid location." };

  const provider = input.provider;
  const descriptor = getProvider(provider);
  if (!descriptor) return { ok: false, error: `Unknown source "${provider}".` };

  const resolution = resolveMode(provider);
  if (resolution.mode === "off") {
    return { ok: false, error: `"${descriptor.label}" is switched off here.` };
  }
  if (resolution.mode === "real" && descriptor.requiresOAuth) {
    return { ok: false, error: "This source needs authorization. Use the connect link instead." };
  }

  let organizationId = "";

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        organizationId = actor.organizationId;

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
          provider,
          config:
            provider === FIRST_PARTY_PROVIDER
              ? { locationId: parsed.data.locationId }
              : {
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
          meta: { provider, mode: resolution.mode, inserted: outcome.inserted },
        });
      },
      { minimumRole: "admin" },
    );

    // Analysis runs in the worker, not here: at free-tier pacing a 40-review
    // backfill takes minutes, and a server action must not hold a request open
    // for that. The Inbox shows the reviews immediately; insights fill in.
    await requestAnalysis(organizationId);
    await requestNotifications(organizationId);

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error, provider }, "connectSource failed");
    return toActionResult(error);
  }
}

/** Pulls any new reviews for one connection on demand. */
export async function syncNowAction(input: { connectionId: string }): Promise<ActionResult> {
  const parsed = syncNowSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid connection." };

  let organizationId = "";
  let changed = false;

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        organizationId = actor.organizationId;

        const [row] = await tx
          .select()
          .from(schema.connections)
          .where(eq(schema.connections.id, parsed.data.connectionId))
          .limit(1);

        if (!row) throw new Error("That connection does not exist.");
        if (row.organizationId !== actor.organizationId) {
          throw new Error("That connection does not exist.");
        }

        // An explicit "Sync now" ignores the polling interval, but still
        // claims a slot against the provider's shared budget.
        const outcome = await syncConnectionWithin(tx, toConnection(row), {
          ignoreSchedule: true,
        });

        changed = outcome.inserted + outcome.updated > 0;
      },
      { minimumRole: "member" },
    );

    if (changed) {
      await requestAnalysis(organizationId);
      await requestNotifications(organizationId);
    }

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "syncNow failed");
    return toActionResult(error);
  }
}
