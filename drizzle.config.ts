import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit reads this directly and does not load .env itself, so the
 * `db:*` scripts run it under `node --env-file=.env`.
 *
 * **This config exists for `db:studio` only. There is no `db:generate`.**
 * Migrations here are written and reviewed by hand — see `docs/16` — and the
 * two approaches do not mix: generate diffs the schema against the newest
 * snapshot in `migrations/meta`, so with hand-written migrations it re-emits
 * everything written since the last snapshot as a fresh duplicate. Those
 * snapshots have been deleted rather than left as a half-truth inviting it.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  // Migrations are reviewed by hand before they are applied.
  verbose: true,
  strict: true,
});
