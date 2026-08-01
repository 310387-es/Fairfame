import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Database-backed suites. Separate from the default config because these need
 * `docker compose up -d` plus an applied migration, so they must not run in a
 * bare `pnpm test`.
 *
 *   pnpm test:db
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    setupFiles: ["tests/db/setup.ts"],
    // RLS behaviour is order-dependent around pooled connections; keep it serial.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
