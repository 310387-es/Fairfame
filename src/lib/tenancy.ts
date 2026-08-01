import { sql } from "drizzle-orm";
import { getAppDb, type Database } from "../db/client.ts";

/**
 * Tenant context — the only sanctioned path to tenant-owned data.
 *
 * How it works
 * ------------
 * Postgres policies (migration 0001) read two transaction-local GUCs,
 * `app.current_org` and `app.current_user`. `withTenant()` opens a transaction,
 * sets them with `set_config(..., is_local => true)`, and hands back a
 * transaction-scoped Drizzle handle. Because the settings are transaction-local
 * they are discarded on commit or rollback, so a pooled connection can never
 * leak one request's tenant into the next — the classic multi-tenant pooling
 * bug this design exists to prevent.
 *
 * Everything runs on `appDb`, which connects as a NOSUPERUSER / NOBYPASSRLS
 * role. Isolation therefore does not depend on the application remembering to
 * add `where organization_id = ...`; the database refuses to return the rows.
 *
 * Usage:
 *   const rows = await withTenant(ctx, (tx) => tx.select().from(reviews));
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TenantContext = {
  organizationId: string;
  /** The acting user, when there is one. Absent for scheduled jobs. */
  userId?: string;
};

/** Drizzle handle bound to a transaction that already carries tenant context. */
export type TenantDatabase = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
}

/**
 * Values reach Postgres as bound parameters, so this is not an injection guard.
 * It is a correctness guard: a malformed id would make `app.current_org()` raise
 * mid-policy, and the failure would surface far from its cause.
 */
function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new TenantContextError(`${label} must be a UUID, received "${value}".`);
  }
}

/**
 * Runs `fn` inside a transaction scoped to one organization.
 *
 * The callback receives a transaction handle; use it for every query in the
 * unit of work. Queries issued against `appDb` outside this callback have no
 * tenant context and will read as empty.
 */
export async function withTenant<T>(
  context: TenantContext,
  fn: (tx: TenantDatabase) => Promise<T>,
): Promise<T> {
  assertUuid(context.organizationId, "organizationId");
  if (context.userId !== undefined) {
    assertUuid(context.userId, "userId");
  }

  return getAppDb().transaction(async (tx) => {
    // is_local => true scopes both settings to this transaction.
    await tx.execute(sql`select set_config('app.current_org', ${context.organizationId}, true)`);
    await tx.execute(sql`select set_config('app.current_user', ${context.userId ?? ""}, true)`);

    return fn(tx);
  });
}

/**
 * Reads back the tenant context Postgres currently sees.
 * Intended for tests and diagnostics, not for request paths.
 */
export async function readTenantContext(
  tx: TenantDatabase,
): Promise<{ organizationId: string | null; userId: string | null }> {
  const result = await tx.execute<{ org: string | null; usr: string | null }>(
    sql`select app.current_org()::text as org, app.current_user_id()::text as usr`,
  );

  const row = result.rows[0];
  return { organizationId: row?.org ?? null, userId: row?.usr ?? null };
}
