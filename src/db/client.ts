import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
// Relative + explicit .ts extensions so scripts/ can import this module under
// Node's native type stripping, which does not read tsconfig path aliases.
import { getEnv } from "../lib/env.ts";
import * as schema from "./schema.ts";

/**
 * Application database handle.
 *
 * IMPORTANT (from T4 onward): this is the *unscoped* connection. Reading tenant
 * data through it bypasses the per-request tenant context, so once the
 * tenant-scoped accessor exists, application code must go through that instead.
 * Legitimate direct uses are migrations, seeding, and global catalog tables
 * (`plans`).
 */

export type Database = NodePgDatabase<typeof schema>;

declare global {
  // Reused across Next.js dev hot reloads so we do not leak a pool per reload.
  // `var` is required here: only var declarations augment globalThis.
  var __reviraPool: Pool | undefined;
}

function createPool(): Pool {
  return new Pool({
    connectionString: getEnv().DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export const pool: Pool = globalThis.__reviraPool ?? createPool();

if (getEnv().NODE_ENV !== "production") {
  globalThis.__reviraPool = pool;
}

export const db: Database = drizzle(pool, { schema });

export { schema };
