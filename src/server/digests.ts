"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { setActionStatus } from "@/digest/queries";
import { requestDigest } from "@/jobs/client";
import { childLogger } from "@/lib/logger";
import { toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Digest actions (P1a-T7).
 *
 * Generation is queued, never run inline. The pipeline makes two or three model
 * calls and can take the better part of a minute; a server action that waited
 * would hold a request open and time out behind most proxies. The Home screen
 * (T8) shows the previous digest until the new one lands.
 */

const log = childLogger({ module: "server/digests" });

export async function generateDigestAction(input: { locationId: string }): Promise<ActionResult> {
  const parsed = z.object({ locationId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid location." };

  try {
    const queued = await withAuthenticatedTenant(
      async (_tx, actor) =>
        requestDigest({
          organizationId: actor.organizationId,
          locationId: parsed.data.locationId,
          force: true,
        }),
      // Regenerating spends the AI allowance, so it is not a member's call.
      { minimumRole: "admin" },
    );

    if (!queued) {
      return { ok: false, error: "Could not queue the digest. Try again shortly." };
    }

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "generateDigest failed");
    return toActionResult(error);
  }
}

const statusSchema = z.object({
  actionId: z.uuid(),
  status: z.enum(["open", "done", "dismissed"]),
});

/** Marks one of the three recommended actions done, dismissed, or open again. */
export async function setDigestActionStatusAction(input: {
  actionId: string;
  status: string;
}): Promise<ActionResult> {
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid action." };

  try {
    const updated = await withAuthenticatedTenant(
      async (tx, actor) =>
        setActionStatus(tx, {
          organizationId: actor.organizationId,
          actionId: parsed.data.actionId,
          status: parsed.data.status,
          userId: actor.userId,
        }),
      // Doing the work is ordinary work; anyone on the team can record it.
      { minimumRole: "member" },
    );

    if (!updated) return { ok: false, error: "That action does not exist." };

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "setDigestActionStatus failed");
    return toActionResult(error);
  }
}
