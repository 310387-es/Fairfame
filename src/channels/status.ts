import { getIysGateway, iysRequired } from "../compliance/gate.ts";
import { isRegisteredVia } from "../compliance/iys-gateway.ts";
import { getEnv } from "../lib/env.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import type { MessageChannel } from "../messaging/messages.ts";
import { channelMode, listChannels, type ChannelDescriptor, type ChannelMode } from "./registry.ts";
import { listChannelConnections, type ChannelConnection } from "./store.ts";

/**
 * Whether a channel can actually carry a message right now (W2.2).
 *
 * Three questions, and the reason they are answered together is that a business
 * asking "why did my message not send?" cannot tell them apart:
 *
 *   1. **Is the channel provisioned?** WhatsApp: has this organization
 *      connected an account, or does the deployment have credentials? SMS: has
 *      whoever runs the installation chosen a gateway?
 *   2. **Is there a consent registry?** Every message this product sends a
 *      customer is a commercial message under Turkish law, so `IYS_GATEWAY=none`
 *      means *nothing may be sent*, however well WhatsApp is configured.
 *   3. **Is any of it real?** `mock` and `local` accept and reach nobody. A
 *      surface that showed those as "ready" would be the single most misleading
 *      thing in the product.
 *
 * The three are reported separately rather than reduced to one boolean, because
 * they have **different owners**: the business connects WhatsApp, the operator
 * chooses the gateway, and the company signs the BSP contract. A card that said
 * only "not ready" would send all three to each other.
 */

export type ChannelBlocker =
  /** Nothing to send with: no connection, or no deployment credentials. */
  | "not_connected"
  /** Connected, but the credentials failed the last time they were used. */
  | "connection_error"
  /** No İYS registry is wired, so no commercial message may leave at all. */
  | "no_consent_registry"
  /** Everything is configured, but nothing here has ever reached a phone. */
  | "not_live";

export type ChannelStatus = {
  descriptor: ChannelDescriptor;
  mode: ChannelMode;
  /** Present only for a channel an organization connects. */
  connection: ChannelConnection | null;
  /** Empty means a real message would go out. Today it never is. */
  blockers: ChannelBlocker[];
  /** True only when a message on this channel would reach a real person. */
  deliverable: boolean;
};

/**
 * The İYS half, which is the same for every channel.
 *
 * Separate because it is a property of the *deployment*, not of a channel, and
 * because it is the blocker that surprises people: WhatsApp can be perfectly
 * connected and every commercial send still refused.
 */
export function consentBlocker(env: { IYS_REQUIRED: boolean }): ChannelBlocker | null {
  if (!iysRequired(env)) return null;

  const gateway = getIysGateway();
  if (!gateway) return "no_consent_registry";

  // `local` accepts without contacting anyone. It is correct for development
  // and it is not a registration — `isRegisteredVia`'s allowlist is empty, and
  // that emptiness is the true answer until a BSP adapter lands.
  return isRegisteredVia(gateway.name) ? null : "no_consent_registry";
}

export async function channelStatuses(
  tx: TenantDatabase,
  organizationId: string,
): Promise<ChannelStatus[]> {
  const env = getEnv();
  const connections = await listChannelConnections(tx, organizationId);
  const byChannel = new Map<MessageChannel, ChannelConnection>(
    connections.map((row) => [row.channel, row]),
  );
  const consent = consentBlocker(env);

  return listChannels().map((descriptor) => {
    const mode = channelMode(descriptor.key, env);
    const connection =
      descriptor.provisioning === "connection" ? byChannel.get(descriptor.key) : undefined;
    const blockers: ChannelBlocker[] = [];

    if (descriptor.provisioning === "connection") {
      // A deployment with its own credentials can send without any row here —
      // that is how the product has worked since P4-T3 — so "not connected" is
      // only true when neither the organization nor the deployment has any.
      const deploymentHasCredentials = mode !== "off";
      if (connection?.status === "error") blockers.push("connection_error");
      else if (connection?.status !== "active" && !deploymentHasCredentials) {
        blockers.push("not_connected");
      }
    } else if (mode === "off") {
      blockers.push("not_connected");
    }

    if (consent) blockers.push(consent);
    if (mode !== "live") blockers.push("not_live");

    return {
      descriptor,
      mode,
      connection: connection ?? null,
      blockers,
      deliverable: blockers.length === 0,
    };
  });
}
