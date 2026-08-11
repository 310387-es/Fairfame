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

/**
 * Credentials this suite is not allowed to see, cleared before any test loads.
 *
 * **The paragraph above claimed this and did not enforce it.** Placeholders are
 * filled with `??=`, which only ever *adds* — so a credential inherited from the
 * shell or set by CI reached the code under test untouched, and "nothing in this
 * suite connects to anything" held only because no developer's environment
 * happened to export one. CI exported `STRIPE_SECRET_KEY` so the browser suite
 * could see the paid path, and three tests in `tests/lib/billing.test.ts` went
 * red: two because `providerForCurrency` prefers a *configured* provider and TRY
 * correctly moved to Stripe, and one because `createCheckoutSession` stopped
 * refusing and made a real HTTP request to Stripe, which answered 401.
 *
 * That last one is the reason this is a seal rather than a change to the CI
 * workflow. A unit test that reaches a payment provider is a hazard wherever it
 * runs: with a *valid* key the same line would not have failed at all, it would
 * have created a live Stripe object from `pnpm test`. The environment is the
 * thing to fix, not the one variable that exposed it.
 *
 * Everything here is a credential whose presence makes some module talk to a
 * third party, or silently changes which branch is under test. A test that needs
 * one sets it itself and restores it afterwards — `billing-checkout.test.ts` and
 * `provider-flags.test.ts` both do, and both are more honest for saying so at
 * the point of use than for depending on what the machine happened to hold.
 *
 * `tests/lib/test-env-seal.test.ts` fails if the seal stops working.
 */
export const SEALED_CREDENTIALS = [
  // Payment providers — the ones that cost money.
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "IYZICO_API_KEY",
  "IYZICO_SECRET_KEY",
  // Model providers. `pnpm ai:eval` and `ai:smoke` are how you call a real one.
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  // Anything that could put a message in front of a person.
  "EMAIL_TRANSPORT",
  "SMTP_URL",
  "WHATSAPP_ACCESS_TOKEN",
  "IYS_GATEWAY",
  "SMS_GATEWAY",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  // Platform credentials: their presence is what flips a connector off mock.
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_AUTH_CLIENT_ID",
  "GOOGLE_AUTH_CLIENT_SECRET",
  "META_APP_ID",
  "META_APP_SECRET",
  // A test run is not an environment worth reporting errors from.
  "SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
] as const;

for (const key of SEALED_CREDENTIALS) {
  delete process.env[key];
}
