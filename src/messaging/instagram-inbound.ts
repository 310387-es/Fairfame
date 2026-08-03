import { and, eq, sql } from "drizzle-orm";
import type { WebhookSignal } from "../connectors/instagram/schemas.ts";
import { INSTAGRAM_PROVIDER } from "../connectors/instagram/client.ts";
import { getAdminDb, schema } from "../db/client.ts";
import { requestSync } from "../jobs/client.ts";
import { childLogger } from "../lib/logger.ts";

/**
 * Turning an Instagram webhook into work (P1b-T4).
 *
 * Deliberately thin. The webhook says "something changed on account X"; this
 * finds the connection that owns X and asks for a sync. It does **not** write a
 * review from the payload, for two reasons:
 *
 *   - Meta's change events carry different fields depending on the permission
 *     and the object, so a row built from one would be inconsistent with the
 *     same item read through the Graph API a minute later;
 *   - re-reading means the ingest path is identical whether an item arrived by
 *     webhook or by the scheduled scan, so there is one normalization to test
 *     rather than two.
 *
 * Cross-tenant by nature, like the WhatsApp webhook: Meta posts to one URL and
 * the account id decides whose it is. The lookup reads connection ids only.
 */

const log = childLogger({ module: "messaging/instagram-inbound" });

/**
 * Finds the connections these signals belong to and enqueues a sync each.
 *
 * Returns how many were queued, which is what the route logs. A signal for an
 * account nobody has connected is dropped — it means the business disconnected
 * and Meta has not stopped sending yet.
 */
export async function requestInstagramSync(signals: WebhookSignal[]): Promise<number> {
  const accountIds = [...new Set(signals.map((signal) => signal.accountId))];
  if (accountIds.length === 0) return 0;

  const rows = await getAdminDb()
    .select({
      id: schema.connections.id,
      organizationId: schema.connections.organizationId,
      accountId: sql<string>`${schema.connections.config} ->> 'accountId'`,
    })
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.provider, INSTAGRAM_PROVIDER),
        eq(schema.connections.status, "active"),
        sql`${schema.connections.config} ->> 'accountId' = any(${sql.param(accountIds)}::text[])`,
      ),
    );

  let queued = 0;

  for (const row of rows) {
    // `force` so the webhook is not swallowed by the connection's polling
    // interval — a real-time signal that waits five minutes is not real time.
    const ok = await requestSync({
      organizationId: row.organizationId,
      connectionId: row.id,
      full: false,
    });

    if (ok) queued += 1;
  }

  if (rows.length === 0) {
    log.info(
      { accounts: accountIds.length },
      "Instagram webhook for an account with no active connection; ignored",
    );
  }

  return queued;
}
