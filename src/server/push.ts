"use server";

import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { childLogger } from "@/lib/logger";
import { pushConfig, removeSubscription, saveSubscription } from "@/notifications/push";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Push subscription actions (W5-9).
 *
 * The browser owns the hard part: it asks the user, talks to its own push
 * service and produces an endpoint plus two keys. All this does is remember
 * them against the person and the organization, so a send has somewhere to go.
 *
 * `member`, not `admin`. Turning on notifications for *your own device* is not
 * an administrative act, and a member who cannot do it is a member who has to
 * ask their boss to make their phone buzz.
 */

const log = childLogger({ module: "server/push" });

const subscriptionSchema = z.object({
  // The push service's own URL. Length-bounded rather than pattern-matched:
  // every browser vendor uses a different host and a regex here would break the
  // day one of them changed it.
  endpoint: z.string().url().max(2_000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

/** The public key a browser needs to subscribe, or null where push is unconfigured. */
export async function pushPublicKeyAction(): Promise<{ key: string | null }> {
  return { key: pushConfig()?.publicKey ?? null };
}

export async function subscribeToPushAction(input: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): Promise<ActionResult> {
  const parsed = subscriptionSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "That subscription is not usable.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await saveSubscription(tx, {
          organizationId: actor.organizationId,
          userId: actor.userId,
          subscription: parsed.data,
        });
      },
      { minimumRole: "member" },
    );

    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "subscribeToPush failed");
    return toActionResult(error);
  }
}

export async function unsubscribeFromPushAction(input: {
  endpoint: string;
}): Promise<ActionResult> {
  const parsed = z.object({ endpoint: z.string().url().max(2_000) }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Unknown device.");

  try {
    await withAuthenticatedTenant(
      (tx, actor) => removeSubscription(tx, actor.organizationId, parsed.data.endpoint),
      { minimumRole: "member" },
    );

    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "unsubscribeFromPush failed");
    return toActionResult(error);
  }
}
