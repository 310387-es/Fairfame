/**
 * Verifies that the app can actually reach the services in docker-compose.yml.
 *
 *   pnpm infra:check
 *
 * Reads .env through the same Zod-validated config the app uses, so a bad
 * DATABASE_URL fails here with the same message it would fail with at startup.
 * Exits non-zero when any dependency is unreachable, so CI can gate on it.
 */
import { checkInfra } from "../src/lib/infra.ts";

const { ok, results } = await checkInfra();

for (const result of results) {
  const status = result.ok ? "OK  " : "FAIL";
  const ms = `${result.durationMs.toFixed(0)}ms`;
  console.log(`[${status}] ${result.service.padEnd(8)} ${ms.padStart(6)}  ${result.detail}`);
}

if (!ok) {
  console.error("\nOne or more dependencies are unreachable. Is `docker compose up -d` running?");
  process.exit(1);
}

console.log("\nAll infrastructure reachable.");
