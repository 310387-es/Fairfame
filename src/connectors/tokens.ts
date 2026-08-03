import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { connectionContext, decryptSecret, encryptSecret } from "../lib/vault.ts";
import { OAuthError, refreshAccessToken, type FetchLike, type TokenSet } from "./oauth/client.ts";
import { oauthConfigFor } from "./providers.ts";
import { ConnectorError, type Connection } from "./types.ts";

/**
 * Credentials for a connection: sealed on the way in, refreshed on the way out.
 *
 * `connections.encrypted_tokens` holds a vault payload and nothing else — no
 * plaintext ever reaches the column, and the ciphertext is bound to the
 * connection's slot so it cannot be replayed into another tenant's row.
 *
 * The refresh is the interesting part. Access tokens expire on the hour and
 * every provider call needs a live one, so `getFreshAccessToken()` is the only
 * sanctioned way to read a token: it checks expiry, refreshes when needed,
 * persists the result, and hands back something usable. Callers never see the
 * refresh token at all.
 */

const log = childLogger({ module: "connectors/tokens" });

export const tokenSetSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  expiresAt: z.iso.datetime().nullable(),
  scope: z.string().nullable(),
  tokenType: z.string().min(1),
});

/** Refresh this long before the stated expiry. Clocks drift; requests take time. */
export const EXPIRY_SKEW_MS = 60_000;

/** The slot a connection's credentials are bound to. */
export type ConnectionSlot = {
  organizationId: string;
  locationId: string;
  provider: string;
};

export function slotOf(connection: Connection): ConnectionSlot {
  return {
    organizationId: connection.organizationId,
    locationId: connection.locationId,
    provider: connection.provider,
  };
}

function contextFor(slot: ConnectionSlot): string {
  return connectionContext(slot.organizationId, slot.locationId, slot.provider);
}

export function sealTokens(tokens: TokenSet, slot: ConnectionSlot): string {
  return encryptSecret(JSON.stringify(tokens), contextFor(slot));
}

/**
 * Opens a stored payload.
 *
 * Validated after decryption as well: the vault proves the bytes are ours and
 * untampered, not that their shape still matches what this code expects after
 * a format change.
 */
export function openTokens(payload: string, slot: ConnectionSlot): TokenSet {
  const parsed = tokenSetSchema.safeParse(JSON.parse(decryptSecret(payload, contextFor(slot))));

  if (!parsed.success) {
    throw new ConnectorError(
      `Stored credentials for "${slot.provider}" are not in a readable shape.`,
      slot.provider,
      false,
    );
  }

  return parsed.data;
}

/** The connection's tokens, or null when it has none (mock, first-party). */
export function tokensFor(connection: Connection): TokenSet | null {
  return connection.encryptedTokens === null
    ? null
    : openTokens(connection.encryptedTokens, slotOf(connection));
}

export function isExpired(tokens: TokenSet, now = new Date(), skewMs = EXPIRY_SKEW_MS): boolean {
  // No stated expiry means we cannot know; treating it as live is right —
  // refreshing on every call would hammer the provider's token endpoint.
  if (tokens.expiresAt === null) return false;

  const expiry = Date.parse(tokens.expiresAt);
  if (Number.isNaN(expiry)) return true;

  return expiry - skewMs <= now.getTime();
}

/** Writes sealed credentials onto a connection. */
export async function storeTokens(
  tx: TenantDatabase,
  connection: { id: string } & ConnectionSlot,
  tokens: TokenSet,
  now = new Date(),
): Promise<void> {
  await tx
    .update(schema.connections)
    .set({
      encryptedTokens: sealTokens(tokens, connection),
      status: "active",
      updatedAt: now,
    })
    .where(eq(schema.connections.id, connection.id));
}

/**
 * Merges a refresh response over what we already hold.
 *
 * The refresh token is kept unless the provider issued a new one. Google
 * returns none on a refresh, so storing the response verbatim would blank the
 * only credential that can outlive the hour — a bug that surfaces exactly once,
 * sixty minutes after go-live.
 */
export function mergeRefreshed(previous: TokenSet, refreshed: TokenSet): TokenSet {
  return {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? previous.refreshToken,
    scope: refreshed.scope ?? previous.scope,
  };
}

export class ReauthorizationRequiredError extends ConnectorError {
  constructor(provider: string, detail: string) {
    super(
      `The connection to ${provider} is no longer authorized (${detail}). Reconnect it to continue.`,
      provider,
      // No amount of retrying revives a revoked grant.
      false,
    );
    this.name = "ReauthorizationRequiredError";
  }
}

export type FreshTokenOptions = {
  fetchImpl?: FetchLike;
  now?: Date;
};

/**
 * A live access token for a connection, opening its own tenant scope.
 *
 * The `Connector` interface hands implementations a `Connection`, not a
 * database handle — deliberately, so a connector cannot wander around the
 * tenant's data. But a real connector still has to authenticate, and the vault
 * is the only sanctioned place its credentials live. This is the narrow,
 * single-purpose door: it opens a transaction scoped to the connection's own
 * organization, reads and refreshes exactly that connection's token, and
 * closes.
 *
 * Safe to call from inside another tenant transaction (the sync path does):
 * it takes a separate pooled connection, and the row lock it holds is released
 * before the caller updates the same row at the end of its own transaction.
 */
export async function accessTokenForConnection(
  connection: Connection,
  options: FreshTokenOptions = {},
): Promise<string> {
  return withTenant({ organizationId: connection.organizationId }, (tx) =>
    getFreshAccessToken(tx, connection, options),
  );
}

/**
 * A live access token for this connection, refreshing first if needed.
 *
 * Takes `SELECT … FOR UPDATE` on the connection row before deciding anything.
 * Two workers syncing the same connection would otherwise both see an expired
 * token and both refresh; with providers that invalidate the previous refresh
 * token on use, the slower response would write a token the provider has
 * already revoked, and the connection would die until someone reconnected it
 * by hand.
 */
export async function getFreshAccessToken(
  tx: TenantDatabase,
  connection: Connection,
  options: FreshTokenOptions = {},
): Promise<string> {
  const { fetchImpl = fetch, now = new Date() } = options;
  const slot = slotOf(connection);

  const [locked] = await tx
    .select({ encryptedTokens: schema.connections.encryptedTokens })
    .from(schema.connections)
    .where(eq(schema.connections.id, connection.id))
    .for("update")
    .limit(1);

  if (!locked?.encryptedTokens) {
    throw new ReauthorizationRequiredError(slot.provider, "no stored credentials");
  }

  const current = openTokens(locked.encryptedTokens, slot);
  if (!isExpired(current, now)) return current.accessToken;

  if (!current.refreshToken) {
    throw new ReauthorizationRequiredError(
      slot.provider,
      "the access token expired with no refresh token",
    );
  }

  const config = oauthConfigFor(slot.provider);
  if (!config) {
    // The provider was live when the tokens were stored and is not now: a flag
    // was flipped or a credential removed. Refusing loudly beats guessing.
    throw new ConnectorError(
      `Provider "${slot.provider}" is not configured for live use, so its token cannot be refreshed.`,
      slot.provider,
      false,
    );
  }

  let refreshed: TokenSet;
  try {
    refreshed = await refreshAccessToken(
      {
        endpoints: config.endpoints,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: current.refreshToken,
      },
      fetchImpl,
      now,
    );
  } catch (error) {
    if (error instanceof OAuthError && !error.retryable) {
      // Park the connection so the UI can ask for a reconnect instead of the
      // scheduler retrying a dead grant every minute.
      await tx
        .update(schema.connections)
        .set({ status: "error", updatedAt: now })
        .where(eq(schema.connections.id, connection.id));

      throw new ReauthorizationRequiredError(slot.provider, error.code ?? error.message);
    }

    throw new ConnectorError(
      `Could not refresh the ${slot.provider} access token: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      slot.provider,
      true,
    );
  }

  const merged = mergeRefreshed(current, refreshed);
  await storeTokens(tx, { id: connection.id, ...slot }, merged, now);

  log.info(
    { organizationId: slot.organizationId, connectionId: connection.id, provider: slot.provider },
    "Refreshed provider access token",
  );

  return merged.accessToken;
}
