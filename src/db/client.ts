import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
// Relative + explicit .ts extensions so scripts/ can import this module under
// Node's native type stripping, which does not read tsconfig path aliases.
import { getEnv } from "../lib/env.ts";
import * as schema from "./schema.ts";

/**
 * Two database handles, deliberately named so misuse is obvious at the call site.
 *
 * `adminDb` connects as the owning superuser. It is NOT subject to Row-Level
 * Security and must never serve a user request — it exists for migrations,
 * seeding, and the global `plans` catalog.
 *
 * `appDb` connects as `revira_app` (NOSUPERUSER, NOBYPASSRLS). RLS applies to
 * it, so without a tenant context it reads as empty. Do not query it directly
 * for tenant data either: go through `withTenant()` in src/lib/tenancy.ts,
 * which is what actually sets the context.
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

const env = getEnv();

export const adminPool: Pool = globalThis.__reviraAdminPool ?? createPool(env.DATABASE_URL, 4);
export const appPool: Pool = globalThis.__reviraAppPool ?? createPool(env.APP_DATABASE_URL, 10);

if (env.NODE_ENV !== "production") {
  globalThis.__reviraAdminPool = adminPool;
  globalThis.__reviraAppPool = appPool;
}

/** Unrestricted. Migrations, seeding, and the global plans catalog only. */
export const adminDb: Database = drizzle(adminPool, { schema });

/** RLS-enforced. Reads as empty until a tenant context is set — see withTenant(). */
export const appDb: Database = drizzle(appPool, { schema });

export { schema };
