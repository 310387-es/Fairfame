"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { channelMode, describeChannel } from "@/channels/registry";
import { connectChannel, disconnectChannel } from "@/channels/store";
import { getEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Connecting and disconnecting a messaging channel (W2.2).
 *
 * **Admin, like connecting a source**, and for the same reason: it grants the
 * product standing permission to send messages as the business. It is a
 * stronger grant than a source, in fact — a review connector reads, this one
 * writes to other people's phones.
 *
 * **Only `mock` mode can be connected here, and that is deliberate rather than
 * unfinished.** A live WhatsApp Business Account is attached through Meta's
 * OAuth consent screen, and that flow is *not built* — there is no Meta app to
 * build it against, every WhatsApp path in this product is fixture-and-mock
 * only (`docs/13`), and an untestable OAuth round trip would look finished
 * while being the one thing nobody could check. The refusal below names that,
 * the same way `SMS_GATEWAY=none` and `IYS_GATEWAY=none` refuse rather than
 * pretending. `docs/13` carries the go-live step.
 */

const log = childLogger({ module: "server/channels" });

const channelSchema = z.object({ channel: z.enum(["whatsapp", "sms"]) });

/** Prefixed so a mock token can never be mistaken for a Meta one. */
const MOCK_TOKEN_PREFIX = "wa.mock-token-";

export async function connectChannelAction(input: { channel: string }): Promise<ActionResult> {
  const parsed = channelSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Unknown channel.");

  const { channel } = parsed.data;
  const descriptor = describeChannel(channel);

  // SMS is deployment plumbing, chosen once by whoever runs the installation.
  // There is nothing for a business to connect, and offering a button that
  // wrote a row would imply an account this product does not have.
  if (descriptor.provisioning !== "connection") {
    return {
      ok: false,
      error: `${descriptor.label} is configured by whoever runs this installation, not per business (${descriptor.envVar}).`,
    };
  }

  const mode = channelMode(channel, getEnv());
  if (mode === "off") {
    return { ok: false, error: `${descriptor.label} is switched off here (${descriptor.envVar}).` };
  }
  if (mode === "live") {
    return {
      ok: false,
      error: `Connecting a live ${descriptor.label} account goes through Meta's consent screen, which is not built yet. ${descriptor.goLiveNote}`,
    };
  }

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        const connection = await connectChannel(tx, {
          organizationId: actor.organizationId,
          channel,
          // Values a real handshake would return. Prefixed, so anything that
          // reaches a log or a support ticket says what it is.
          externalId: `mock-phone-${actor.organizationId.slice(0, 8)}`,
          displayName: `${descriptor.label} (mock)`,
          accessToken: `${MOCK_TOKEN_PREFIX}${crypto.randomUUID()}`,
          config: { mode: "mock" },
        });

        log.info(
          { organizationId: actor.organizationId, channel, connectionId: connection.id },
          "Channel connected on mock",
        );
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/channels");
    return { ok: true };
  } catch (error) {
    // `toActionResult` passes an Error's own message through, which is what
    // makes a missing `TOKEN_VAULT_KEYS` say so instead of "Something went
    // wrong" — the vault already explains itself and even prints the command
    // that generates a key. The only thing missing was letting it out.
    log.warn({ err: error, channel }, "connectChannel failed");
    return toActionResult(error);
  }
}

export async function disconnectChannelAction(input: { channel: string }): Promise<ActionResult> {
  const parsed = channelSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Unknown channel.");

  const { channel } = parsed.data;

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await disconnectChannel(tx, actor.organizationId, channel);
        log.info({ organizationId: actor.organizationId, channel }, "Channel disconnected");
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/channels");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error, channel }, "disconnectChannel failed");
    return toActionResult(error);
  }
}
