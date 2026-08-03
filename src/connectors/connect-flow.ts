import { and, eq } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { publicBaseUrl } from "../lib/urls.ts";
import type { TokenSet } from "./oauth/client.ts";
import { getProvider } from "./providers.ts";
import { sealTokens } from "./tokens.ts";
import { ConnectorError } from "./types.ts";

/**
 * Turning a finished OAuth handshake into a connection row.
 *
 * Deliberately provider-agnostic and deliberately *incomplete*: it stores the
 * credentials and leaves the connection `pending`. What is still missing is the
 * mapping — which Google location, which Instagram account — and that cannot be
 * asked before the tokens exist, because listing the user's places is itself an
 * authenticated call. Each provider's own task (T2–T4) adds that step and flips
 * the connection to `active`.
 *
 * Storing tokens against a half-finished connection is the right trade: an
 * authorization the customer has already granted must not be thrown away
 * because the next screen has not been built yet.
 */

const log = childLogger({ module: "connectors/connect-flow" });

/** The callback URL registered with each provider. Must match exactly. */
export function redirectUriFor(provider: string, baseUrl = publicBaseUrl()): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/connect/${provider}/callback`;
}

export type CompleteConnectionArgs = {
  organizationId: string;
  locationId: string;
  provider: string;
  tokens: TokenSet;
  actorUserId: string | null;
};

export async function completeOAuthConnection(
  tx: TenantDatabase,
  args: CompleteConnectionArgs,
  now = new Date(),
): Promise<{ connectionId: string }> {
  const descriptor = getProvider(args.provider);
  if (!descriptor) {
    throw new ConnectorError(`Unknown provider "${args.provider}".`, args.provider, false);
  }

  const [location] = await tx
    .select({ id: schema.locations.id })
    .from(schema.locations)
    .where(
      and(
        eq(schema.locations.id, args.locationId),
        eq(schema.locations.organizationId, args.organizationId),
      ),
    )
    .limit(1);

  // RLS would hide another tenant's location anyway; failing here names the
  // problem rather than surfacing a foreign-key violation.
  if (!location) {
    throw new ConnectorError("That location does not exist.", args.provider, false);
  }

  const encryptedTokens = sealTokens(args.tokens, {
    organizationId: args.organizationId,
    locationId: args.locationId,
    provider: args.provider,
  });

  const [row] = await tx
    .insert(schema.connections)
    .values({
      organizationId: args.organizationId,
      locationId: args.locationId,
      provider: args.provider,
      // Authorized, not yet mapped. The provider's own step completes it.
      status: "pending",
      capabilities: descriptor.capabilities,
      config: {},
      encryptedTokens,
    })
    .onConflictDoUpdate({
      target: [schema.connections.locationId, schema.connections.provider],
      set: {
        // Re-authorizing an existing connection replaces the credentials and
        // clears whatever error state drove the customer to reconnect. Its
        // config and cursor are left alone: the mapping is still valid.
        encryptedTokens,
        capabilities: descriptor.capabilities,
        failureCount: 0,
        lastError: null,
        nextSyncAt: null,
        updatedAt: now,
      },
    })
    .returning({ id: schema.connections.id });

  if (!row) {
    throw new ConnectorError("Could not persist the connection.", args.provider, false);
  }

  await tx.insert(schema.auditLogs).values({
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    action: "connection.authorized",
    entity: `connection:${row.id}`,
    // Never the tokens, never the scopes' values — just that it happened.
    meta: { provider: args.provider, locationId: args.locationId },
  });

  log.info(
    { organizationId: args.organizationId, provider: args.provider, connectionId: row.id },
    "Stored provider credentials",
  );

  return { connectionId: row.id };
}
