import { getProvider, resolveMode, type MessagingCapability } from "../connectors/providers.ts";
import type { MessageChannel } from "../messaging/messages.ts";

/**
 * Channels — where you *message* a customer (W2.2).
 *
 * A deliberate split from **sources**, which is where reviews come from. The
 * product had one registry for both, and the seam showed: "Connect WhatsApp
 * Business" sat on the Locations screen beside Google, and pressing it reached
 * `syncConnection`, which threw `Provider "whatsapp" cannot read reviews.` at a
 * customer in English in a Turkish product. W1.4 stopped offering it there and
 * left the note that this file answers.
 *
 * The two are different in a way that is not cosmetic:
 *
 *   - A **source** is polled, has a sync cursor, and produces rows. Its
 *     capability question is *can it read reviews*.
 *   - A **channel** is a pipe you push down and sometimes hear back from. Its
 *     capability question is *can it carry a message*, and — because every
 *     message this product sends to a customer is a commercial message under
 *     Turkish law — *may it carry one right now*.
 *
 * A provider can be both. Nothing here assumes otherwise; it is only that no
 * provider is both today.
 *
 * **The second difference is how a channel is provisioned**, and this is the
 * part that surprises people. WhatsApp is connected *per organization*: a
 * business authorizes its own WhatsApp Business Account and gets its own token.
 * SMS is not — it is deployment plumbing (`SMS_GATEWAY`), chosen once by
 * whoever runs the installation, and in Türkiye it is usually the same BSP that
 * reports permissions to İYS. So "why can I not send an SMS?" has two possible
 * answers with two different owners, and a channel surface that showed one
 * button for both would send the operator to the wrong place.
 */

export type ChannelProvisioning = "connection" | "deployment";

export type ChannelDescriptor = {
  key: MessageChannel;
  label: string;
  provisioning: ChannelProvisioning;
  messaging: MessagingCapability;
  /**
   * The provider key in `PROVIDERS`, where the channel is one. Absent for a
   * deployment-provisioned channel — there is nothing to connect and no OAuth.
   */
  provider?: string;
  /** Which env flag governs it, for diagnostics and the compliance card. */
  envVar: string;
  /** What blocks live traffic. Shown while the channel is on mock. */
  goLiveNote: string;
};

const WHATSAPP: ChannelDescriptor = {
  key: "whatsapp",
  label: "WhatsApp Business",
  provisioning: "connection",
  messaging: "two_way",
  provider: "whatsapp",
  envVar: "CONNECTOR_WHATSAPP_MODE",
  goLiveNote:
    "Needs a WhatsApp Business Account, an approved message template, and İYS registration.",
};

const SMS: ChannelDescriptor = {
  key: "sms",
  label: "SMS",
  provisioning: "deployment",
  // One way. A reply to an SMS does not reach us, which is why an inbound SMS
  // can never open a service window the way an inbound WhatsApp message does.
  messaging: "outbound",
  envVar: "SMS_GATEWAY",
  goLiveNote: "Needs an SMS provider (BSP), which in Türkiye is also the İYS integration.",
};

export const CHANNELS: Record<MessageChannel, ChannelDescriptor> = { whatsapp: WHATSAPP, sms: SMS };

export function describeChannel(key: MessageChannel): ChannelDescriptor {
  return CHANNELS[key];
}

/** Every channel, in a stable order — WhatsApp first, since it is the one you connect. */
export function listChannels(): ChannelDescriptor[] {
  return [WHATSAPP, SMS];
}

/**
 * Whether a provider is a messaging channel at all.
 *
 * A capability test rather than a name test, so the next outbound-only provider
 * is classified by what it declares rather than by somebody remembering to add
 * it to a list — the same rule `describeConnectableProviders` applies on the
 * source side.
 */
export function isMessagingProvider(providerKey: string): boolean {
  const provider = getProvider(providerKey);
  return provider !== null && (provider.messaging ?? "none") !== "none";
}

/**
 * How a channel is running *in this deployment*, before any organization is
 * considered.
 *
 * `off` is a real and correct answer, and the default: a deployment with no
 * WhatsApp credentials and `SMS_GATEWAY=none` cannot send, and saying so plainly
 * is the point of the compliance surface. Mock means the path is exercisable
 * but nothing leaves the machine — `docs/13` records that as the state of every
 * messaging channel today.
 */
export type ChannelMode = "live" | "mock" | "off";

export function channelMode(key: MessageChannel, env: { SMS_GATEWAY?: string }): ChannelMode {
  if (key === "sms") {
    if (env.SMS_GATEWAY === "mock") return "mock";
    // No allowlisted real gateway exists yet (`isRealSmsGateway` is empty by
    // design), so anything that is not `mock` is not sending.
    return "off";
  }

  // `real` in the provider vocabulary; `live` here, matching how `docs/13` and
  // the go-live report talk about it.
  const mode = resolveMode(WHATSAPP.provider ?? "whatsapp").mode;
  return mode === "real" ? "live" : mode === "mock" ? "mock" : "off";
}
