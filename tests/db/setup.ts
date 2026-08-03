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

/**
 * Then force the AI providers offline.
 *
 * `.env` carries a real Gemini key, and the analysis job (P1a-T4) runs whenever
 * a sync ingests reviews — so without this, `pnpm test:db` would quietly spend
 * a developer's quota and fail whenever the network or the free tier said no.
 * A test suite that depends on a third party is a test suite that goes red for
 * reasons unrelated to the code.
 *
 * Tests that want a specific provider pass one explicitly; these variables only
 * decide what the *default* resolution returns.
 */
process.env.AI_PROVIDER = "stub";
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

// Per-task model overrides go too. They name a real provider's model, so
// leaving them set makes the stub report `gemini-3.5-flash` on its audit row —
// a model that never ran. Same rule as the keys: if it points outward, it does
// not belong in a test run.
delete process.env.AI_MODEL_ANALYZE;
delete process.env.AI_MODEL_DRAFT_REPLY;
delete process.env.AI_MODEL_DIGEST;

/**
 * And keep mail off the wire.
 *
 * `.env` points at the Mailpit container, so once notifications ship (P1a-T5)
 * a plain `pnpm test:db` starts delivering hundreds of alerts into a
 * developer's dev inbox — and fails whenever that container is not running.
 * Tests that assert on mail pass a capture transport explicitly.
 */
process.env.EMAIL_TRANSPORT = "log";
