import { and, eq } from "drizzle-orm";
import { schema } from "../../db/client.ts";
import { childLogger } from "../../lib/logger.ts";
import type { TenantDatabase } from "../../lib/tenancy.ts";
import { ConnectorError, type Connection } from "../types.ts";
import { createGoogleClient, GOOGLE_PROVIDER, type GoogleClientOptions } from "./client.ts";
import { formatAddress, idFromResourceName } from "./schemas.ts";

/**
 * Location mapping — the step between "the customer authorized us" and "we know
 * what to sync".
 *
 * It cannot happen during the OAuth callback, because listing someone's
 * business locations is itself an authenticated call: the tokens have to exist
 * first. So the callback leaves the connection `pending`, and this is what
 * promotes it.
 *
 * A Google account can administer dozens of locations, and picking the wrong
 * one silently syncs a different shop's reviews into this location's inbox —
 * which is why this is an explicit choice by a human rather than a "take the
 * first one" guess.
 */

const log = childLogger({ module: "connectors/google/mapping" });

export type GoogleTarget = {
  accountId: string;
  accountName: string;
  googleLocationId: string;
  title: string;
  address: string;
  mapsUri: string | null;
};

/** Guard against an agency account with a very long tail. */
const MAX_ACCOUNTS = 10;

/**
 * Every location the authorized user could map this connection to.
 *
 * Failures on a single account are swallowed: a user who administers one
 * account they no longer have permission on should still see the others rather
 * than an error page.
 */
export async function listGoogleTargets(
  connection: Connection,
  options: GoogleClientOptions = {},
): Promise<GoogleTarget[]> {
  const client = createGoogleClient(options);
  const accounts = (await client.listAccounts(connection)).slice(0, MAX_ACCOUNTS);
  const targets: GoogleTarget[] = [];

  for (const account of accounts) {
    const accountId = idFromResourceName(account.name);

    try {
      const locations = await client.listLocations(connection, accountId);

      for (const location of locations) {
        targets.push({
          accountId,
          accountName: account.accountName ?? accountId,
          googleLocationId: idFromResourceName(location.name),
          title: location.title ?? location.name,
          address: formatAddress(location.storefrontAddress),
          mapsUri: location.metadata?.mapsUri ?? null,
        });
      }
    } catch (error) {
      log.warn(
        { accountId, err: error },
        "Could not list locations for one Google account; skipping it",
      );
    }
  }

  return targets;
}

export type ApplyMappingArgs = {
  organizationId: string;
  connectionId: string;
  actorUserId: string | null;
  accountId: string;
  googleLocationId: string;
  title?: string | undefined;
};

/**
 * Writes the chosen place onto the connection and makes it syncable.
 *
 * Re-mapping an already-active connection clears the cursor: the new place has
 * its own review history, and keeping the old cursor would skip everything
 * older than the last sync of a different business.
 */
export async function applyGoogleMapping(
  tx: TenantDatabase,
  args: ApplyMappingArgs,
  now = new Date(),
): Promise<void> {
  const [connection] = await tx
    .select({ id: schema.connections.id, locationId: schema.connections.locationId })
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.id, args.connectionId),
        eq(schema.connections.organizationId, args.organizationId),
        eq(schema.connections.provider, GOOGLE_PROVIDER),
      ),
    )
    .limit(1);

  if (!connection) {
    throw new ConnectorError("That Google connection does not exist.", GOOGLE_PROVIDER, false);
  }

  await tx
    .update(schema.connections)
    .set({
      config: {
        locationId: connection.locationId,
        googleAccountId: args.accountId,
        googleLocationId: args.googleLocationId,
        ...(args.title ? { googleLocationTitle: args.title } : {}),
      },
      status: "active",
      cursor: null,
      nextSyncAt: null,
      failureCount: 0,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(schema.connections.id, args.connectionId));

  await tx.insert(schema.auditLogs).values({
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    action: "connection.mapped",
    entity: `connection:${args.connectionId}`,
    meta: {
      provider: GOOGLE_PROVIDER,
      googleAccountId: args.accountId,
      googleLocationId: args.googleLocationId,
    },
  });

  log.info(
    {
      organizationId: args.organizationId,
      connectionId: args.connectionId,
      googleLocationId: args.googleLocationId,
    },
    "Mapped a Google location",
  );
}
