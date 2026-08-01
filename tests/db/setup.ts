import { existsSync } from "node:fs";

/**
 * Loads .env for database-backed suites.
 *
 * The app itself gets env from Next.js and the scripts get it from
 * `node --env-file`; Vitest has neither, so use Node's built-in loader rather
 * than adding a dotenv dependency.
 */
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
