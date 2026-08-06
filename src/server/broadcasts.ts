"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolveLocationScope } from "@/auth/scope";
import { withAuthenticatedTenant } from "@/auth/session";
import { runBroadcast } from "@/broadcasts/pipeline";
import { broadcastInputSchema, cancelBroadcast, createBroadcast } from "@/broadcasts/store";
import { schema } from "@/db/client";
import { requireFeature } from "@/lib/entitlements";
import { childLogger } from "@/lib/logger";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";
import { audienceSize } from "@/broadcasts/audience";
import { segmentFilters } from "@/broadcasts/audience";

/**
 * Broadcast mutations (P4-T4).
 *
 * Admin-only throughout. A broadcast reaches hundreds of people at once, so the
 * blast radius of a mistake is the whole audience — and unlike a reply typed
 * into the messages inbox, there is nobody on the other end to say "sorry,
 * wrong person" to.
 *
 * The compliance gate is not here. It runs per recipient inside the pipeline,
 * where it cannot be skipped by a caller who knows the ids.
 */

const log = childLogger({ module: "server/broadcasts" });

export async function createBroadcastAction(
  input: unknown,
): Promise<ActionResult<{ id?: string }>> {
  const parsed = broadcastInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput(parsed.error, parsed.error.issues[0]?.message ?? "Invalid broadcast.");
  }

  try {
    const created = await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "broadcasts");

        const row = await createBroadcast(tx, actor.organizationId, actor.userId, parsed.data);

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "broadcast.created",
          entity: `broadcast:${row.id}`,
          meta: {
            kind: parsed.data.kind,
            channel: parsed.data.channel,
            scheduledAt: parsed.data.scheduledAt,
          },
        });

        return row;
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/campaigns");
    return { ok: true, id: created.id };
  } catch (error) {
    log.warn({ err: error }, "createBroadcast failed");
    return toActionResult(error);
  }
}

export type SendBroadcastResult = ActionResult<{
  sent?: number;
  refused?: number;
  failed?: number;
  refusals?: Record<string, number>;
  abandoned?: string;
}>;

/**
 * Sends now.
 *
 * The same code path the sweep uses — `runBroadcast` — rather than a parallel
 * "immediate" one. A scheduled send that only ever runs at 3am in a worker
 * nobody watches is a send nobody has tested; making the button and the cron
 * identical means every manual send exercises the scheduled path.
 */
export async function sendBroadcastAction(input: { id: string }): Promise<SendBroadcastResult> {
  const parsed = z.object({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid broadcast.");

  try {
    const organizationId = await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "broadcasts");
        return actor.organizationId;
      },
      { minimumRole: "admin" },
    );

    // Outside the request transaction: this makes network calls, and holding a
    // pooled connection across two hundred SMTP round trips would make a slow
    // mail server look like a database outage.
    const outcome = await runBroadcast(organizationId, parsed.data.id);

    revalidatePath("/campaigns");
    revalidatePath(`/campaigns/${parsed.data.id}`);

    return {
      ok: true,
      sent: outcome.sent,
      refused: outcome.refused,
      failed: outcome.failed,
      refusals: outcome.refusals,
      ...(outcome.abandoned ? { abandoned: outcome.abandoned } : {}),
    };
  } catch (error) {
    log.warn({ err: error }, "sendBroadcast failed");
    return toActionResult(error);
  }
}

export async function cancelBroadcastAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid broadcast.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "broadcasts");
        await cancelBroadcast(tx, actor.organizationId, parsed.data.id);
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/campaigns");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "cancelBroadcast failed");
    return toActionResult(error);
  }
}

/**
 * How many people a segment would reach on a channel, before anything is saved.
 *
 * Resolved under the **caller's** scope, which is the same scope the send will
 * use — so the number on the button is the number that goes out, rather than an
 * organization-wide figure a branch manager cannot actually reach.
 */
export async function audienceSizeAction(input: {
  segmentId: string;
  channel: "email" | "sms" | "whatsapp";
}): Promise<ActionResult<{ size?: number }>> {
  const parsed = z
    .object({ segmentId: z.uuid(), channel: z.enum(["email", "sms", "whatsapp"]) })
    .safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid audience.");

  try {
    const size = await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "broadcasts");

        const filters = await segmentFilters(tx, actor.organizationId, parsed.data.segmentId);
        if (!filters) throw new Error("That segment does not exist.");

        const scope = await resolveLocationScope(
          tx,
          actor.organizationId,
          actor.userId,
          actor.role,
        );

        return audienceSize({
          tx,
          organizationId: actor.organizationId,
          scope,
          filters,
          channel: parsed.data.channel,
        });
      },
      { minimumRole: "admin" },
    );

    return { ok: true, size };
  } catch (error) {
    log.warn({ err: error }, "audienceSize failed");
    return toActionResult(error);
  }
}
