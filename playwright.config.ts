import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests (added 4 Aug 2026, after Phase 2).
 *
 * Deliberately **outside `pnpm verify`**. These need a live Next server and a
 * live Postgres; `verify` must stay runnable without either, or the gate stops
 * being something anyone can run before a commit. `pnpm test:e2e` is the door.
 *
 * They exist for the two things the unit suites structurally cannot reach:
 *
 *   - **Layout.** jsdom has no layout engine, so "does anything overflow at
 *     390px" is unanswerable there. It needs a real viewport.
 *   - **Keyboard and focus.** Tab order, focus rings and whether Escape
 *     restores focus are behaviours of a browser, not of a component tree.
 *
 * Everything else stays where it is. A rule that can be checked from source —
 * contrast, ICU, tenant isolation, the bulk guardrail — should be, because
 * those run in two seconds and these do not.
 */
export default defineConfig({
  testDir: "./e2e",
  // Serial by default: the suite signs one account in and shares it, and
  // parallel workers racing the same inbox would make failures unreadable.
  workers: 1,
  fullyParallel: false,
  // A failing browser test is usually a real failure or a real flake; retrying
  // once locally hides the second and tells us nothing about the first.
  retries: 0,
  reporter: process.env.CI ? "line" : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    // Kept only for failures — passing runs should leave nothing behind.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/state.json" },
      dependencies: ["setup"],
    },
  ],

  // Reuses the dev server if one is already up, which is the normal case on a
  // developer's machine and avoids fighting over port 3000.
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
