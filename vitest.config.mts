import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors the `@/*` path alias in tsconfig.json without pulling in an
    // extra plugin dependency.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Everything under test here is server-side: db, tenancy, connectors, jobs.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Placeholder env so a unit test touching one config value doesn't fail on
    // an unrelated missing variable. See the file for why these are fakes.
    setupFiles: ["tests/setup-unit-env.ts"],
    // Database-backed suites need Docker; they run via `pnpm test:db`.
    exclude: ["tests/db/**"],
    // RLS and connector suites (T11) talk to a real Postgres; keep them serial
    // and give them room beyond the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
