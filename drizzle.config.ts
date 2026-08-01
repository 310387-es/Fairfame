import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit reads this directly and does not load .env itself, so the
 * `db:*` scripts run it under `node --env-file=.env`.
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
