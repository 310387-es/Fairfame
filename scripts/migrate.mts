/**
 * Applies pending SQL migrations.
 *
 *   pnpm db:migrate
 *
 * Idempotent: drizzle records applied migrations in `drizzle.__drizzle_migrations`
 * and skips anything already there, so re-running is a no-op.
 *
 * Uses a dedicated short-lived pool rather than the app pool — a migration run
 * should not leave a hot connection pool behind in a one-shot process.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { getEnv } from "../src/lib/env.ts";

const MIGRATIONS_FOLDER = "./src/db/migrations";

const pool = new Pool({ connectionString: getEnv().DATABASE_URL, max: 1 });

try {
  const started = Date.now();
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  console.log(`Migrations up to date (${Date.now() - started}ms).`);
} catch (error) {
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
