"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { GOOGLE_PROVIDER } from "@/connectors/google/client";
import {
  applyGoogleMapping,
  listGoogleTargets,
  type GoogleTarget,
} from "@/connectors/google/mapping";
import { resolveMode } from "@/connectors/providers";
import { syncConnectionWithin, toConnection } from "@/connectors/sync";
import { requestAnalysis, requestNotifications } from "@/jobs/client";
import { schema } from "@/db/client";
import { childLogger } from "@/lib/logger";
import type { TenantDatabase } from "@/lib/tenancy";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Finishing a Google connection: choose which business location it syncs.
 *
 * Both actions are admin-only and tenant-scoped, and both re-read the
 * connection inside the tenant transaction rather than trusting the id that
 * arrived from the browser.
 */

const log = childLogger({ module: "server/google" });

const connectionInput = z.object({ connectionId: z.uuid() });

const mappingInput = connectionInput.extend({
  accountId: z.string().min(1).max(64),
  googleLocationId: z.string().min(1).max(64),
  title: z.string().max(300).optional(),
});

/** Loads the connection, or explains why it cannot be used. */
async function requireGoogleConnection(
  tx: TenantDatabase,
  organizationId: string,
  connectionId: string,
) {
  const [row] = await tx
    .select()
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.id, connectionId),
        eq(schema.connections.organizationId, organizationId),
        eq(schema.connections.provider, GOOGLE_PROVIDER),
      ),
    )
    .limit(1);

  if (!row) throw new Error("That Google connection does not exist.");
  return row;
}

export type ListTargetsResult = ActionResult<{ targets: GoogleTarget[] }>;

/** The business locations this connection could be mapped to. */
export async function listGoogleTargetsAction(input: {
  connectionId: string;
}): Promise<ListTargetsResult> {
  const parsed = connectionInput.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid connection.");

  if (resolveMode(GOOGLE_PROVIDER).mode !== "real") {
    // On mock there is no Google account to enumerate, and pretending
    // otherwise would put invented business names in front of an owner.
    return { ok: false, error: "Google is running on sample data in this environment." };
  }

  try {
    const targets = await withAuthenticatedTenant(
      async (tx, actor) => {
        const row = await requireGoogleConnection(
          tx,
          actor.organizationId,
          parsed.data.connectionId,
        );
        return listGoogleTargets(toConnection(row));
      },
      { minimumRole: "admin" },
    );

    return { ok: true, targets };
  } catch (error) {
    log.warn({ err: error }, "listGoogleTargets failed");
    return toActionResult(error);
  }
}

/** Maps the connection to a place and pulls its reviews straight away. */
export async function mapGoogleLocationAction(input: {
  connectionId: string;
  accountId: string;
  googleLocationId: string;
  title?: string;
}): Promise<ActionResult> {
  const parsed = mappingInput.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid selection.");

  let organizationId = "";
  let changed = false;

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await applyGoogleMapping(tx, {
          organizationId: actor.organizationId,
          connectionId: parsed.data.connectionId,
          actorUserId: actor.userId,
          accountId: parsed.data.accountId,
          googleLocationId: parsed.data.googleLocationId,
          title: parsed.data.title,
        });

        const row = await requireGoogleConnection(
          tx,
          actor.organizationId,
          parsed.data.connectionId,
        );

        organizationId = actor.organizationId;

        // Pull immediately so the owner sees reviews rather than an empty
        // inbox and a promise that the scheduler will get to it.
        const outcome = await syncConnectionWithin(tx, toConnection(row), {
          ignoreSchedule: true,
        });

        changed = outcome.inserted + outcome.updated > 0;
      },
      { minimumRole: "admin" },
    );

    // Insights follow in the worker; see the note in ./locations.ts.
    if (changed) {
      await requestAnalysis(organizationId);
      await requestNotifications(organizationId);
    }

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "mapGoogleLocation failed");
    return toActionResult(error);
  }
}
