import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
// Relative + explicit .ts extensions so scripts/ can import this module under
// Node's native type stripping, which does not read tsconfig path aliases.
import { getEnv } from "../lib/env.ts";
import * as schema from "./schema.ts";

/**
 * Two database handles, deliberately named so misuse is obvious at the call site.
 *
 * `getAdminDb()` connects as the owning superuser. It is NOT subject to
 * Row-Level Security and must never serve a user request — it exists for
 * migrations, seeding, BetterAuth, and the global `plans` catalog.
 *
 * `getAppDb()` connects as `revira_app` (NOSUPERUSER, NOBYPASSRLS). RLS applies
 * to it, so without a tenant context it reads as empty. Do not query it
 * directly for tenant data either: go through `withTenant()` in
 * src/lib/tenancy.ts, which is what actually sets the context.
 *
 * Both are lazy. Connecting — or even reading env — at module scope would mean
 * that merely importing a module downstream of this one requires a fully
 * configured environment, which breaks unit tests and build-time analysis for
 * no benefit.
 */

export type Database = NodePgDatabase<typeof schema>;

declare global {
  // Reused across Next.js dev hot reloads so we do not leak a pool per reload.
  // `var` is required here: only var declarations augment globalThis.
  var __reviraAdminPool: Pool | undefined;
  var __reviraAppPool: Pool | undefined;
}

function createPool(connectionString: string, max: number): Pool {
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

let adminDbHandle: Database | undefined;
let appDbHandle: Database | undefined;

export function getAdminPool(): Pool {
  globalThis.__reviraAdminPool ??= createPool(getEnv().DATABASE_URL, 4);
  return globalThis.__reviraAdminPool;
}

export function getAppPool(): Pool {
  globalThis.__reviraAppPool ??= createPool(getEnv().APP_DATABASE_URL, 10);
  return globalThis.__reviraAppPool;
}

/** Unrestricted. Migrations, seeding, BetterAuth, and the plans catalog only. */
export function getAdminDb(): Database {
  adminDbHandle ??= drizzle(getAdminPool(), { schema });
  return adminDbHandle;
}

/** RLS-enforced. Reads as empty until a tenant context is set — see withTenant(). */
export function getAppDb(): Database {
  appDbHandle ??= drizzle(getAppPool(), { schema });
  return appDbHandle;
}

/** Closes whatever was actually opened. For scripts and test teardown. */
export async function closeDatabasePools(): Promise<void> {
  const pools = [globalThis.__reviraAdminPool, globalThis.__reviraAppPool].filter(
    (pool): pool is Pool => pool !== undefined,
  );

  globalThis.__reviraAdminPool = undefined;
  globalThis.__reviraAppPool = undefined;
  adminDbHandle = undefined;
  appDbHandle = undefined;

  await Promise.all(pools.map((pool) => pool.end()));
}

export { schema };
