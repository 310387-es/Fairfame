/**
 * Placeholder environment for the unit suite.
 *
 * `getEnv()` validates the whole environment at once, so a unit test that
 * exercises any code path reading a single configuration value would otherwise
 * fail on an unrelated missing `DATABASE_URL`. These values are deliberately
 * obvious fakes: nothing in this suite connects to anything, and a test that
 * accidentally tried would fail against a host that plainly does not exist
 * rather than silently reaching a real service.
 *
 * Database-backed suites use `tests/db/setup.ts` instead, which loads the real
 * `.env`.
 */
const PLACEHOLDERS: Record<string, string> = {
  DATABASE_URL: "postgres://unit:unit@unit.invalid:5432/unit",
  APP_DATABASE_URL: "postgres://unit:unit@unit.invalid:5432/unit",
  REDIS_URL: "redis://unit.invalid:6379",
  BETTER_AUTH_SECRET: "unit-test-secret-that-is-long-enough-000",
  BETTER_AUTH_URL: "http://localhost:3000",
};

for (const [key, value] of Object.entries(PLACEHOLDERS)) {
  process.env[key] ??= value;
}
