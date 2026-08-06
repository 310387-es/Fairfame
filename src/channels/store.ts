import { and, eq } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { channelContext, decryptSecret, encryptSecret } from "../lib/vault.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import type { MessageChannel } from "../messaging/messages.ts";

/**
 * Reading and writing an organization's messaging channels (W2.2).
 *
 * The only module that touches `channel_connections`, for the reason
 * `src/messaging/messages.ts` is the only writer of `messages`: credentials
 * have exactly one way in and one way out, and a second writer is how a token
 * ends up stored under the wrong binding.
 *
 * **Credentials are sealed to `channelContext`**, which is a different prefix
 * from the one review sources use. A WhatsApp channel token and a WhatsApp
 * source token belong to the same organization and the same provider name, and
 * without the distinct prefix each would decrypt in the other's slot.
 */

export type ChannelConnection = {
  id: string;
  channel: MessageChannel;
  status: "pending" | "active" | "error" | "disconnected";
  externalId: string | null;
  displayName: string | null;
  lastError: string | null;
  connectedAt: Date | null;
};

const COLUMNS = {
  id: schema.channelConnections.id,
  channel: schema.channelConnections.channel,
  status: schema.channelConnections.status,
  externalId: schema.channelConnections.externalId,
  displayName: schema.channelConnections.displayName,
  lastError: schema.channelConnections.lastError,
  connectedAt: schema.channelConnections.connectedAt,
};

/** Every channel this organization has connected. Never includes credentials. */
export async function listChannelConnections(
  tx: TenantDatabase,
  organizationId: string,
): Promise<ChannelConnection[]> {
  return tx
    .select(COLUMNS)
    .from(schema.channelConnections)
    .where(eq(schema.channelConnections.organizationId, organizationId));
}

export async function getChannelConnection(
  tx: TenantDatabase,
  organizationId: string,
  channel: MessageChannel,
): Promise<ChannelConnection | null> {
  const [row] = await tx
    .select(COLUMNS)
    .from(schema.channelConnections)
    .where(
      and(
        eq(schema.channelConnections.organizationId, organizationId),
        eq(schema.channelConnections.channel, channel),
      ),
    )
    .limit(1);

  return row ?? null;
}

export type ConnectChannelInput = {
  organizationId: string;
  channel: MessageChannel;
  /** The provider's own id — a WhatsApp phone number id. */
  externalId: string;
  displayName: string;
  /** Sealed before it is written; never stored or logged in the clear. */
  accessToken: string;
  config?: Record<string, unknown>;
  now?: Date;
};

/**
 * Connects a channel, or replaces the credentials on one already connected.
 *
 * Upsert rather than insert, because reconnecting is the ordinary case: a token
 * expires, a business moves to a different number, somebody authorizes again
 * after an error. A second row is not a second account — the unique index says
 * so — and making the caller decide between insert and update is how half of
 * them get it wrong.
 *
 * `lastError` is cleared on success, deliberately: a card still showing why
 * last week's attempt failed, next to a channel that now works, is a card
 * nobody believes.
 */
export async function connectChannel(
  tx: TenantDatabase,
  input: ConnectChannelInput,
): Promise<ChannelConnection> {
  const now = input.now ?? new Date();
  const sealed = encryptSecret(
    JSON.stringify({ accessToken: input.accessToken }),
    channelContext(input.organizationId, input.channel),
  );

  const [row] = await tx
    .insert(schema.channelConnections)
    .values({
      organizationId: input.organizationId,
      channel: input.channel,
      status: "active",
      externalId: input.externalId,
      displayName: input.displayName,
      config: input.config ?? {},
      encryptedTokens: sealed,
      lastError: null,
      connectedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.channelConnections.organizationId, schema.channelConnections.channel],
      set: {
        status: "active",
        externalId: input.externalId,
        displayName: input.displayName,
        config: input.config ?? {},
        encryptedTokens: sealed,
        lastError: null,
        connectedAt: now,
        updatedAt: now,
      },
    })
    .returning(COLUMNS);

  if (!row) throw new Error("Could not record the channel connection.");
  return row;
}

/**
 * Disconnects a channel, keeping the row.
 *
 * The credentials go; the record stays. "This was connected and is not any
 * more" is a different fact from "this was never connected", and a support
 * conversation needs to tell them apart. Nothing can be sent on a
 * `disconnected` channel because `channelCredentials` returns null for it.
 */
export async function disconnectChannel(
  tx: TenantDatabase,
  organizationId: string,
  channel: MessageChannel,
  now = new Date(),
): Promise<void> {
  await tx
    .update(schema.channelConnections)
    .set({ status: "disconnected", encryptedTokens: null, updatedAt: now })
    .where(
      and(
        eq(schema.channelConnections.organizationId, organizationId),
        eq(schema.channelConnections.channel, channel),
      ),
    );
}

/** Records why a send or a refresh failed, without dropping the connection. */
export async function recordChannelError(
  tx: TenantDatabase,
  organizationId: string,
  channel: MessageChannel,
  reason: string,
  now = new Date(),
): Promise<void> {
  await tx
    .update(schema.channelConnections)
    .set({ status: "error", lastError: reason, updatedAt: now })
    .where(
      and(
        eq(schema.channelConnections.organizationId, organizationId),
        eq(schema.channelConnections.channel, channel),
      ),
    );
}

export type ChannelCredentials = { accessToken: string; externalId: string };

/**
 * The credentials to send with, or null.
 *
 * Null for every reason a caller must treat the same: no row, disconnected,
 * errored, or a blob that will not open. **Active only** — a channel in `error`
 * has credentials that failed the last time they were used, and retrying them
 * on a customer-facing send is how a business gets rate-limited for a token
 * that was revoked a week ago.
 */
export async function channelCredentials(
  tx: TenantDatabase,
  organizationId: string,
  channel: MessageChannel,
): Promise<ChannelCredentials | null> {
  const [row] = await tx
    .select({
      status: schema.channelConnections.status,
      externalId: schema.channelConnections.externalId,
      encryptedTokens: schema.channelConnections.encryptedTokens,
    })
    .from(schema.channelConnections)
    .where(
      and(
        eq(schema.channelConnections.organizationId, organizationId),
        eq(schema.channelConnections.channel, channel),
      ),
    )
    .limit(1);

  if (!row || row.status !== "active" || !row.encryptedTokens || !row.externalId) return null;

  try {
    const opened: unknown = JSON.parse(
      decryptSecret(row.encryptedTokens, channelContext(organizationId, channel)),
    );

    const token =
      typeof opened === "object" && opened !== null && "accessToken" in opened
        ? (opened as { accessToken: unknown }).accessToken
        : null;

    return typeof token === "string" && token.length > 0
      ? { accessToken: token, externalId: row.externalId }
      : null;
  } catch {
    // A blob that will not open is a configuration problem, not a send-time
    // decision to make. Returning null lets the caller fall back to the
    // deployment's own credentials rather than failing the send outright.
    return null;
  }
}
