"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolveLocationScope } from "@/auth/scope";
import { withAuthenticatedTenant } from "@/auth/session";
import { getContact } from "@/contacts/queries";
import { requireFeature } from "@/lib/entitlements";
import { childLogger } from "@/lib/logger";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";
import { sendMessage } from "@/messaging/outbound";
import { TEMPLATES } from "@/connectors/whatsapp/templates";

/**
 * Sending a message from the inbox (P4-T3).
 *
 * Three gates, as everywhere in Phase 4: the `messaging` entitlement, the
 * member's role, and — the one that is specific to this phase — the contact's
 * **location scope**, resolved through `getContact` so the messages inbox
 * cannot reach somebody the contacts list hides.
 *
 * The compliance gate is *not* here. It is inside the transports, so a caller
 * who constructs their own client is not a way around it; what this file does
 * is carry the refusal back with its reason intact.
 *
 * **There is no `intent` parameter, and there must never be one.** What basis a
 * message rests on follows from what is being sent — see `intentFor` in
 * `src/messaging/outbound.ts`. A field here would let a screen declare its own
 * message exempt.
 */

const log = childLogger({ module: "server/messages" });

const REPLY_MAX = 1_000;

const sendSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("reply"),
    contactId: z.uuid(),
    channel: z.enum(["whatsapp", "sms"]),
    body: z.string().trim().min(1).max(REPLY_MAX),
  }),
  z.object({
    kind: z.literal("template"),
    contactId: z.uuid(),
    channel: z.enum(["whatsapp", "sms"]),
    // Checked against the registry rather than accepted as a string: an
    // unknown name would reach the platform and come back as a generic 400.
    template: z.enum(Object.keys(TEMPLATES) as [string, ...string[]]),
    values: z.array(z.string().max(500)).max(10),
  }),
]);

/**
 * The refusal travels in `code`, as `send:{reason}` — `send:no_consent` and so
 * on, parsed by the composer.
 *
 * `ActionResult`'s failure branch is `{ ok: false; error; code? }` by design —
 * one shape for every action in the product — and `code` is exactly the
 * machine-readable slot it provides. Widening the type here for one action
 * would give the UI two places to look for a reason.
 */
export type SendMessageResult = ActionResult<{ intent?: string }>;

export async function sendMessageAction(input: unknown): Promise<SendMessageResult> {
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput(parsed.error, parsed.error.issues[0]?.message ?? "Invalid message.");
  }

  const data = parsed.data;

  try {
    const outcome = await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "messaging");

        const scope = await resolveLocationScope(
          tx,
          actor.organizationId,
          actor.userId,
          actor.role,
        );
        const contact = await getContact({
          tx,
          organizationId: actor.organizationId,
          scope,
          contactId: data.contactId,
        });

        // "Not yours to see" and "does not exist" get the same answer, exactly
        // as they do on /contacts.
        if (!contact) throw new Error("That contact does not exist.");

        return sendMessage({
          tx,
          organizationId: actor.organizationId,
          contactId: data.contactId,
          channel: data.channel,
          request:
            data.kind === "reply"
              ? { kind: "reply", body: data.body }
              : { kind: "template", template: data.template, values: data.values },
          sentByUserId: actor.userId,
        });
      },
      { minimumRole: "member" },
    );

    revalidatePath("/conversations");
    revalidatePath(`/contacts/${data.contactId}`);

    return outcome.ok
      ? { ok: true, intent: outcome.intent }
      : { ok: false, error: outcome.reason, code: `send:${outcome.refusal}` };
  } catch (error) {
    log.warn({ err: error }, "sendMessage failed");
    return toActionResult(error);
  }
}
