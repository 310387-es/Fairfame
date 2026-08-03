import { eq } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { upsertReviews } from "./normalize.ts";
import { rateLimitFor } from "./providers.ts";
import { getConnector } from "./registry.ts";
import {
  acquireProviderSlot,
  computeBackoffMs,
  nextSyncAfterSuccess,
  RateLimitError,
} from "./throttle.ts";
import { capabilitySchema, ConnectorError, type Connection } from "./types.ts";

/**
 * Connecting a source, and pulling reviews from it.
 *
 * Every database touch here runs through the tenant-scoped connection, so an
 * ingest can only ever write rows belonging to the organization whose context
 * is set. That is enforced by RLS, not by the care taken in this file.
 */

const log = childLogger({ module: "connectors/sync" });

/** Maps a `connections` row to the shape connectors consume. */
export function toConnection(row: typeof schema.connections.$inferSelect): Connection {
  const capabilities = capabilitySchema.safeParse(row.capabilities);

  return {
    id: row.id,
    organizationId: row.organizationId,
    locationId: row.locationId,
    provider: row.provider,
    status: row.status,
    // A stored capability snapshot can go stale or be hand-edited; fall back to
    // what the connector reports rather than trusting the column blindly.
    capabilities: capabilities.success
      ? capabilities.data
      : getConnector(row.provider).capabilities,
    config: (row.config ?? {}) as Record<string, unknown>,
    encryptedTokens: row.encryptedTokens,
    cursor: row.cursor,
    lastSyncedAt: row.lastSyncedAt,
    nextSyncAt: row.nextSyncAt,
    failureCount: row.failureCount,
    createdAt: row.createdAt,
  };
}

export type ConnectSourceInput = {
  organizationId: string;
  provider: string;
  config: unknown;
};

/**
 * Creates (or re-activates) a connection for a location.
 *
 * `unique(location_id, provider)` means a location cannot hold two connections
 * to the same source, so re-connecting updates the existing row instead of
 * failing.
 */
export async function connectSource(
  tx: TenantDatabase,
  input: ConnectSourceInput,
): Promise<typeof schema.connections.$inferSelect> {
  const connector = getConnector(input.provider);
  const draft = await connector.connect(input.organizationId, input.config);

  if (draft.organizationId !== input.organizationId) {
    // Defence in depth: RLS would reject this anyway, but failing here names
    // the actual bug instead of surfacing an opaque policy violation.
    throw new ConnectorError(
      "Connector returned a connection for a different organization.",
      input.provider,
      false,
    );
  }

  const [row] = await tx
    .insert(schema.connections)
    .values({
      organizationId: draft.organizationId,
      locationId: draft.locationId,
      provider: draft.provider,
      status: draft.status,
      capabilities: draft.capabilities,
      config: draft.config,
      encryptedTokens: draft.encryptedTokens,
      cursor: draft.cursor,
    })
    .onConflictDoUpdate({
      target: [schema.connections.locationId, schema.connections.provider],
      set: {
        status: draft.status,
        capabilities: draft.capabilities,
        config: draft.config,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) throw new ConnectorError("Failed to persist the connection.", input.provider, false);
  return row;
}

export type SyncOutcome = {
  connectionId: string;
  provider: string;
  fetched: number;
  inserted: number;
  updated: number;
  cursor: string | null;
  /**
   * Set when no call was made. `rate_limited` means the provider budget was
   * spent this minute; `not_due` means the connection is still inside its
   * minimum interval or serving a backoff. Neither is a failure.
   */
  skipped?: "rate_limited" | "not_due";
  /** When the scheduler may try this connection again. */
  nextSyncAt?: Date | null;
};

/**
 * Fetch → normalize → upsert for one connection, inside an existing tenant
 * transaction.
 *
 * Pass `full: true` to ignore the stored cursor and re-pull everything; dedup
 * makes that safe.
 */
export async function syncConnectionWithin(
  tx: TenantDatabase,
  connection: Connection,
  options: { full?: boolean; ignoreSchedule?: boolean; now?: Date } = {},
): Promise<SyncOutcome> {
  const connector = getConnector(connection.provider);
  const policy = rateLimitFor(connection.provider);
  const now = options.now ?? new Date();

  if (connector.capabilities.read === "none") {
    throw new ConnectorError(
      `Provider "${connection.provider}" cannot read reviews.`,
      connection.provider,
      false,
    );
  }

  const idle = (reason: "rate_limited" | "not_due", nextSyncAt: Date | null): SyncOutcome => ({
    connectionId: connection.id,
    provider: connection.provider,
    fetched: 0,
    inserted: 0,
    updated: 0,
    cursor: connection.cursor,
    skipped: reason,
    nextSyncAt,
  });

  // The scan filters on next_sync_at too; this is the guard against two scan
  // cycles racing a slow sync. A full re-pull is an explicit operator action
  // rather than scheduled polling, so it is never held by the interval — but
  // it still claims a slot against the provider's budget below.
  const respectSchedule = !options.ignoreSchedule && !options.full;
  if (respectSchedule && connection.nextSyncAt && connection.nextSyncAt > now) {
    return idle("not_due", connection.nextSyncAt);
  }

  // The provider's per-minute budget is shared across every tenant and every
  // process, so it is claimed here rather than in the worker.
  const slot = await acquireProviderSlot(connection.provider, policy, now);
  if (!slot.allowed) {
    const deferUntil = new Date(now.getTime() + slot.retryAfterMs);
    await tx
      .update(schema.connections)
      .set({ nextSyncAt: deferUntil, updatedAt: now })
      .where(eq(schema.connections.id, connection.id));

    log.debug(
      {
        connectionId: connection.id,
        provider: connection.provider,
        retryAfterMs: slot.retryAfterMs,
      },
      "Sync deferred: provider budget spent",
    );
    return idle("rate_limited", deferUntil);
  }

  const since =
    options.full || connection.cursor === null ? undefined : parseCursor(connection.cursor);

  let raw;
  try {
    raw = await connector.fetchReviews(connection, since);
  } catch (error) {
    // A 429 from the provider itself is flow control, not a fault: park the
    // connection for as long as it asked and leave the failure count alone.
    if (error instanceof RateLimitError) {
      const deferUntil = new Date(now.getTime() + error.retryAfterMs);
      await tx
        .update(schema.connections)
        .set({ nextSyncAt: deferUntil, updatedAt: now })
        .where(eq(schema.connections.id, connection.id));

      return idle("rate_limited", deferUntil);
    }
    throw error;
  }

  const canonical = raw.map((item) => connector.normalize(connection, item));

  // A connector must not be able to aim rows at another location.
  for (const review of canonical) {
    if (review.locationId !== connection.locationId) {
      throw new ConnectorError(
        `Connector produced a review for location ${review.locationId}, expected ${connection.locationId}.`,
        connection.provider,
        false,
      );
    }
  }

  const outcome = await upsertReviews(tx, connection.organizationId, canonical);
  const cursor = connector.nextCursor?.(connection, raw) ?? connection.cursor;
  const nextSyncAt = nextSyncAfterSuccess(policy, now);

  await tx
    .update(schema.connections)
    .set({
      cursor,
      status: "active",
      lastSyncedAt: now,
      nextSyncAt,
      // A success clears the slate: the next failure starts backoff from the
      // bottom rather than from wherever the last incident left off.
      failureCount: 0,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(schema.connections.id, connection.id));

  log.info(
    {
      organizationId: connection.organizationId,
      connectionId: connection.id,
      provider: connection.provider,
      fetched: outcome.received,
      inserted: outcome.inserted,
      updated: outcome.updated,
    },
    "Connector sync completed",
  );

  return {
    connectionId: connection.id,
    provider: connection.provider,
    fetched: outcome.received,
    inserted: outcome.inserted,
    updated: outcome.updated,
    cursor,
    nextSyncAt,
  };
}

/** The provider a failure came from, so backoff uses that platform's policy. */
function providerOf(error: unknown): string {
  return error instanceof ConnectorError ? error.provider : "unknown";
}

function parseCursor(cursor: string): Date | undefined {
  const time = Date.parse(cursor);
  return Number.isNaN(time) ? undefined : new Date(time);
}

/**
 * Syncs one connection, opening its own tenant scope.
 *
 * A failed sync marks the connection `error` and rethrows, so the job layer can
 * decide about retries while the UI can already show something is wrong.
 */
export async function syncConnection(
  organizationId: string,
  connectionId: string,
  options: { full?: boolean; ignoreSchedule?: boolean } = {},
): Promise<SyncOutcome> {
  try {
    return await withTenant({ organizationId }, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.connections)
        .where(eq(schema.connections.id, connectionId))
        .limit(1);

      if (!row) {
        throw new ConnectorError(
          `Connection ${connectionId} not found for this organization.`,
          "unknown",
          false,
        );
      }

      return syncConnectionWithin(tx, toConnection(row), options);
    });
  } catch (error) {
    await markConnectionError(organizationId, connectionId, providerOf(error), error);
    throw error;
  }
}

/**
 * Records a failure and pushes the connection out to its next attempt.
 *
 * The backoff lives on the row rather than in the job, because the scheduler
 * rescans every minute regardless of what any individual job decided: without a
 * `next_sync_at` in the future, a source that is down would be retried sixty
 * times an hour indefinitely.
 */
async function markConnectionError(
  organizationId: string,
  connectionId: string,
  provider: string,
  error: unknown,
  now = new Date(),
): Promise<void> {
  const policy = rateLimitFor(provider);

  try {
    await withTenant({ organizationId }, async (tx) => {
      const [row] = await tx
        .select({ failureCount: schema.connections.failureCount })
        .from(schema.connections)
        .where(eq(schema.connections.id, connectionId))
        .limit(1);

      const failureCount = (row?.failureCount ?? 0) + 1;

      await tx
        .update(schema.connections)
        .set({
          status: "error",
          failureCount,
          nextSyncAt: new Date(now.getTime() + computeBackoffMs(failureCount, policy)),
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          updatedAt: now,
        })
        .where(eq(schema.connections.id, connectionId));
    });
  } catch (bookkeepingError) {
    // Never let bookkeeping mask the original failure.
    log.error(
      { organizationId, connectionId, err: bookkeepingError },
      "Could not mark connection as errored",
    );
  }
}

/** Every connection for an organization that is eligible for a scheduled sync. */
export async function listSyncableConnections(
  tx: TenantDatabase,
  organizationId: string,
): Promise<Connection[]> {
  const rows = await tx
    .select()
    .from(schema.connections)
    .where(eq(schema.connections.organizationId, organizationId));

  return rows.filter((row) => row.status === "active" || row.status === "error").map(toConnection);
}
