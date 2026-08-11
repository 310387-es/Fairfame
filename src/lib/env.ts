import { z } from "zod";

/**
 * Typed, Zod-validated environment configuration.
 *
 * Server-side only. Importing this from a client component is a bug — it would
 * leak secrets into the browser bundle — so the module throws if it is ever
 * evaluated outside Node.
 *
 * Validation is strict and fails fast at startup: a missing DATABASE_URL should
 * stop the process with a readable message, not surface as a null-pointer three
 * layers into a request.
 */

if (typeof window !== "undefined") {
  throw new Error("src/lib/env.ts is server-only and must not be imported from client code.");
}

const postgresUrl = z
  .url({ message: "must be a valid URL" })
  .refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: "must start with postgres:// or postgresql://",
  });

const redisUrl = z
  .url({ message: "must be a valid URL" })
  .refine((value) => /^rediss?:\/\//.test(value), {
    message: "must start with redis:// or rediss://",
  });

/** Accepts "true"/"1"/"false"/"0"; absent means undefined, not false. */
const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

/** Empty means absent — an unset credential must not read as configured. */
const optionalSecret = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value));

/**
 * How a credentialed provider behaves. Defaults to `mock` so that forgetting to
 * configure a provider degrades to seeded data rather than to a broken connect
 * flow — and so no environment reaches a live platform by accident.
 */
const connectorMode = z.enum(["mock", "real", "off"]).default("mock");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /** Owner connection: migrations and seeds. Bypasses RLS — never serves requests. */
  DATABASE_URL: postgresUrl,
  /** Runtime connection: non-superuser, RLS-enforced. All tenant queries use this. */
  APP_DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,

  BETTER_AUTH_SECRET: z.string().min(32, {
    message: "must be at least 32 characters — generate with `openssl rand -base64 32`",
  }),
  BETTER_AUTH_URL: z.url({ message: "must be a valid URL" }),

  /**
   * WhatsApp Cloud API credentials (P1b-T3). Absent until the WhatsApp Business
   * Account exists, which is why every send path handles a null client rather
   * than assuming configuration.
   */
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  /** The sending phone number *id*, not the display number. */
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  /** Overridden by contract tests to point at a local server. */
  WHATSAPP_BASE_URL: z.string().url().optional(),
  /** The token Meta echoes back when verifying the webhook subscription. */
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  /** App secret, for the `X-Hub-Signature-256` check on inbound webhooks. */
  WHATSAPP_APP_SECRET: z.string().optional(),

  /**
   * The token Meta echoes when verifying the Instagram webhook (P1b-T4). The
   * signature check reuses `META_APP_SECRET` — one Meta app, one secret.
   */
  INSTAGRAM_VERIFY_TOKEN: z.string().optional(),

  /**
   * Whether İYS applies to this deployment. Defaults to **true**.
   *
   * İYS is Turkish law and Türkiye is the launch market, so the safe default is
   * that it applies: a deployment that has not thought about it refuses
   * commercial sends rather than making them. Set false only for a market
   * outside Türkiye — local consent is still required either way.
   */
  /**
   * Which İYS adapter to install (P1b-T5).
   *
   * `none` refuses every commercial send and is the default. `local` trusts our
   * own consent records and is development-only — it refuses in production. A
   * real BSP-backed adapter is added here at go-live.
   */
  IYS_GATEWAY: z.enum(["none", "local"]).default("none"),

  /**
   * The SMS gateway (P4-T3). Deployment plumbing, not a connectable source —
   * see the module note in `src/messaging/sms.ts`.
   *
   * Defaults to `none`, which refuses. In Türkiye the gateway is usually also
   * the İYS integration, so a deployment that has not chosen one cannot send
   * commercial SMS and should not be able to. `mock` accepts without leaving
   * the machine and refuses outright in production.
   */
  SMS_GATEWAY: z.enum(["none", "mock"]).default("none"),

  /**
   * How often the worker looks for a broadcast whose time has come (P4-T4).
   *
   * A minute by default, unlike the hourly sweeps: "send at 10am on Thursday"
   * is a promise about a time somebody chose, and an hour late is a different
   * campaign. Costs one partial-index scan when nothing is due.
   */
  BROADCAST_SWEEP_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),

  IYS_REQUIRED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  /** How often the worker scans for connections to sync. Defaults to 60s. */
  SYNC_SCAN_INTERVAL_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000),

  /**
   * How often the worker sweeps for reviews needing analysis. Defaults to 5min.
   *
   * Much slower than the connection scan on purpose: the sweep is a safety net
   * for work the post-sync fast path missed, and its query spans every tenant.
   */
  ANALYZE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(300_000),

  /**
   * How often the worker sweeps for reviews nobody has been alerted about.
   * Defaults to 2min — faster than the analysis sweep, because a late insight
   * is invisible while a late alert is the product failing at its promise.
   */
  NOTIFY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(120_000),
  /** How often lapsed response deadlines are looked for (P2-T7). */
  SLA_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(300_000),

  /**
   * How often collected consents are reported to İYS. Defaults to 15 minutes.
   *
   * The deadline is three business days, so the interval is not about latency —
   * it is about how many retries fit inside the margin when the registry is
   * unreachable. Ninety-six a day means most of a day of downtime costs nobody
   * a deadline.
   */
  IYS_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(900_000),

  /**
   * How often the worker checks for a missing weekly digest. Defaults to 1h.
   *
   * Not weekly: a weekly cron is a single point of failure whose retry interval
   * is seven days. An hourly check for a digest that does not exist yet is
   * idempotent and costs one query.
   */
  DIGEST_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(3_600_000),
  /** Scheduled PDF reports (P3-T5). Hourly; the ledger makes a missed hour harmless. */
  REPORT_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(3_600_000),
  /**
   * Where competitor figures come from (P3-T6).
   *
   * `none` refuses and is the default, so a deployment that has not chosen a
   * source shows no benchmark rather than a plausible one. `fixtures` invents
   * deterministic numbers for development, and every surface that renders them
   * says so. A real adapter arrives with the connectors at go-live.
   */
  COMPETITOR_SOURCE: z.enum(["none", "fixtures"]).default("none"),

  /**
   * Whether the development connectors may be offered at all (W1.4, fixed here).
   *
   * "Mock source" and "Fixture provider" are instruments, not products, and
   * W1.4 stopped advertising them beside Google on a screen shown to design
   * partners. The gate it used was `NODE_ENV !== "production"` plus `?dev=1`,
   * and the first half is the wrong question: **`next start` sets
   * `NODE_ENV=production` in every environment**, including CI and any preview
   * deployment. So the connectors vanished from the built app, the browser
   * suite could not connect one, and nobody found out for two waves — because
   * Playwright reuses a *dev* server locally and only CI runs the real bundle.
   *
   * An explicit flag instead, in the shape this codebase already uses for a
   * test seam (`IYS_GATEWAY`, `SMS_GATEWAY`, `COMPETITOR_SOURCE`): a real
   * deployment never sets it, so the default is the safe answer, and nothing
   * depends on `NODE_ENV` meaning what we hoped. `?dev=1` is still required on
   * top, so the connectors stay out of the way of somebody working normally.
   */
  ALLOW_DEV_CONNECTORS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /**
   * Public origin for the links we hand to customers — review-request short
   * links and the QR codes that encode them. Distinct from BETTER_AUTH_URL
   * because a public collection page may well live on a different hostname
   * (or a custom domain) from the dashboard. Falls back to BETTER_AUTH_URL.
   */
  APP_URL: z.url({ message: "must be a valid URL" }).optional(),

  /**
   * Outbound email. `log` renders the message and writes it to the log without
   * sending — the default, so no test or CI run can post mail anywhere.
   * `smtp` talks to SMTP_URL, which in local dev is the Mailpit container.
   */
  EMAIL_TRANSPORT: z.enum(["log", "smtp"]).default("log"),
  SMTP_URL: z
    .string()
    .refine((value) => /^smtps?:\/\//.test(value), {
      message: "must start with smtp:// or smtps://",
    })
    .default("smtp://localhost:1025"),
  EMAIL_FROM: z.string().min(3).default("Fairfame <no-reply@fairfame.local>"),

  /**
   * Abuse guard on the unauthenticated submission endpoint: at most N
   * submissions per window from one IP to one campaign.
   */
  PUBLIC_SUBMIT_LIMIT: z.coerce.number().int().min(1).max(1_000).default(5),
  PUBLIC_SUBMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(86_400).default(600),

  /**
   * The same guard for an anonymous survey answer (P4-T2), and deliberately
   * looser than the review one.
   *
   * A review is written by one customer who was asked; a survey card sits on a
   * table or comes with the bill, so a dozen people on one café's Wi-Fi
   * answering within ten minutes is the **normal case**, not abuse. At the
   * review endpoint's 5 the sixth genuine customer would be turned away — found
   * by hitting it, seeding a demo survey.
   *
   * It guards the *slug* path only. An invited answer arrives with an
   * unguessable token that may be used exactly once, so a limit there would
   * cost real answers and prevent nothing.
   */
  PUBLIC_SURVEY_LIMIT: z.coerce.number().int().min(1).max(1_000).default(30),

  // -------------------------------------------------------------------------
  // Connector infrastructure (P1b-T0)
  // -------------------------------------------------------------------------

  /**
   * Key-encryption keys for the OAuth token vault, newest first:
   *   TOKEN_VAULT_KEYS="k2:<base64 32 bytes>,k1:<base64 32 bytes>"
   * Absent means no provider may go `real` — there would be nowhere safe to
   * put the tokens. See src/lib/vault.ts.
   */
  TOKEN_VAULT_KEYS: optionalSecret,

  /**
   * Error reporting (Sentry). All three optional, and absent is the ordinary
   * state in development and in CI.
   *
   * `NEXT_PUBLIC_SENTRY_DSN` is the switch: an empty DSN makes every
   * `Sentry.init` a no-op, so a deployment that has not opted in reports
   * nothing rather than filling a shared project with a developer's typos.
   * `NEXT_PUBLIC_` because the browser needs it and Next inlines that prefix at
   * **build** time — setting it only at container start instruments the server
   * and silently leaves the client blind. It is not a secret; it ships inside
   * the client bundle by design and grants nothing but the ability to write
   * events into the project.
   *
   * `SENTRY_AUTH_TOKEN` **is** a secret — it uploads source maps and can write
   * to the org — and is needed only by `pnpm build`, never at runtime.
   *
   * These are declared here so a typo fails loudly at boot alongside every
   * other variable, but the Sentry init files read `process.env` directly
   * through `src/lib/sentry-options.ts`: that module runs in the browser and
   * the edge runtime too, where this schema's Node assumptions do not hold.
   */
  NEXT_PUBLIC_SENTRY_DSN: z.url({ message: "must be a valid Sentry DSN URL" }).optional(),
  SENTRY_AUTH_TOKEN: optionalSecret,
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
  /**
   * Overrides the environment tag, which otherwise follows `NODE_ENV`. Needed
   * for staging, which builds as `production` and would otherwise be
   * indistinguishable from it in every alert.
   */
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: z.string().trim().min(1).optional(),

  /**
   * Web Push identity (W5-9): `npx web-push generate-vapid-keys`.
   *
   * Optional, and absent is the ordinary state. A deployment with no key pair
   * simply does not offer the button — `pushConfig()` returns null and the
   * settings card says push is not configured here. Failing at boot would take
   * the whole app down over a channel nobody has to use, which is the same
   * reasoning `TOKEN_VAULT_KEYS` follows for connectors it does not have.
   *
   * `VAPID_SUBJECT` is the contact a push service is entitled to have for the
   * *application* — a `mailto:` or an https URL. It defaults to this
   * deployment's own origin, which is true and reachable.
   */
  VAPID_PUBLIC_KEY: optionalSecret,
  VAPID_PRIVATE_KEY: optionalSecret,
  VAPID_SUBJECT: z.string().trim().min(1).optional(),

  /**
   * Per-provider mode. `mock` keeps the MockConnector in place (the dev
   * default for every credentialed provider), `real` uses the provider's own
   * implementation, `off` hides it from the connect UI entirely.
   *
   * A provider set to `real` without credentials or a vault falls back to mock
   * rather than failing at connect time — see src/connectors/providers.ts.
   */
  CONNECTOR_GOOGLE_MODE: connectorMode,
  CONNECTOR_INSTAGRAM_MODE: connectorMode,
  CONNECTOR_WHATSAPP_MODE: connectorMode,
  /** The fixture-backed provider used to exercise this framework in tests. */
  CONNECTOR_FIXTURE_MODE: connectorMode,

  // Credentials arrive at go-live, once the company exists and each platform
  // has approved its app. Optional until then; their absence is what keeps the
  // corresponding provider on mock.
  GOOGLE_CLIENT_ID: optionalSecret,
  GOOGLE_CLIENT_SECRET: optionalSecret,
  /** One Meta app covers both Instagram and WhatsApp. */
  META_APP_ID: optionalSecret,
  META_APP_SECRET: optionalSecret,

  /**
   * **Signing in with Google, which is not the same Google as the four lines
   * above.**
   *
   * `GOOGLE_CLIENT_ID` is the *Business Profile connector*: it asks a business
   * owner for access to their listings, its scopes are
   * `business.manage`-shaped, and its consent screen has to survive Google's
   * app review before it may leave testing. This pair is **login only** —
   * `openid email profile`, which is BetterAuth's Google default and is why no
   * `scope` is configured against it — and needs no verification to work for
   * anyone.
   *
   * They are deliberately two OAuth clients and two variables. One client
   * doing both would tie the front door to a review queue: a connector scope
   * added later would put the whole app back into Google's verification, and
   * until it cleared, nobody could sign in. The `_AUTH_` infix exists so the
   * two cannot be pasted into each other's slot at go-live, which is the hour
   * when somebody is holding four Google credentials at once.
   *
   * Absent is the ordinary state, exactly like the connector credentials: the
   * button does not render, and `emailAndPassword` carries the product. It must
   * never be a runtime error — see `isGoogleAuthConfigured` in
   * `src/auth/social.ts`, which is the only reader.
   */
  GOOGLE_AUTH_CLIENT_ID: optionalSecret,
  GOOGLE_AUTH_CLIENT_SECRET: optionalSecret,

  // -------------------------------------------------------------------------
  // AI layer (P1a-T1)
  // -------------------------------------------------------------------------

  /**
   * Which LLM provider serves AI calls. `stub` is deterministic and offline —
   * the default, so no test run or unconfigured environment can spend money or
   * reach a provider.
   */
  AI_PROVIDER: z.enum(["stub", "gemini", "anthropic"]).default("stub"),

  /** Wall-clock budget for a single completion, including retries' own waits. */
  AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  /** Attempts after the first. Only retryable failures consume one. */
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  /**
   * Google Gemini — the development provider (free tier, no card).
   * `gemini-3.5-flash-lite` is the current stable Flash-Lite; check which
   * models your key actually has in AI Studio, since free-tier membership
   * changes and 2.5-era models retire in October 2026.
   */
  GEMINI_API_KEY: optionalSecret,
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  /** `gemini-embedding-2` auto-normalizes truncated dimensions; 001 does not. */
  GEMINI_EMBEDDING_MODEL: z.string().min(1).default("gemini-embedding-2"),
  GEMINI_BASE_URL: z.url().default("https://generativelanguage.googleapis.com"),

  /**
   * Batch analysis pacing. The free tier's binding constraint is requests per
   * minute, and exceeding it turns a backfill into a wall of 429s, so the
   * default sits deliberately below the published ceiling.
   */
  AI_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(12),
  AI_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(3),

  /** Anthropic — the documented production path. Needs API credits. */
  ANTHROPIC_API_KEY: optionalSecret,
  ANTHROPIC_MODEL: z.string().min(1).default("claude-opus-5"),

  /**
   * Per-task model overrides. Empty means "use the provider's default model".
   *
   * The tasks have genuinely different economics, which is why `AiTask` exists
   * at all: analysis runs on every review and can live on the cheapest model,
   * while a drafted reply is published under the business's own name and a
   * garbled one is worse than no reply. A model that is adequate at classifying
   * Turkish is not automatically adequate at writing it — the cheap tier
   * emitted Cyrillic characters mid-word in a Turkish draft during P1a-T6.
   *
   * The value is a model id for whichever provider `AI_PROVIDER` selects, so
   * these are deliberately provider-agnostic names.
   */
  AI_MODEL_ANALYZE: z.string().optional(),
  AI_MODEL_DRAFT_REPLY: z.string().optional(),
  AI_MODEL_DIGEST: z.string().optional(),
  ANTHROPIC_BASE_URL: z.url().default("https://api.anthropic.com"),

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
  LOG_PRETTY: booleanish.optional(),

  // Billing is skeleton-only in Phase 0, so every credential is optional and
  // an empty string means "absent" rather than "configured with nothing".
  STRIPE_SECRET_KEY: optionalSecret,
  /**
   * Verifies that a webhook really came from Stripe (W1.8).
   *
   * Separate from the secret key because it is a different secret with a
   * different lifecycle — it is minted per endpoint and rotates when the
   * endpoint does. Without it `parseWebhook` refuses, which is correct: an
   * unverified billing webhook is a way for anybody who knows the URL to grant
   * themselves a plan.
   */
  STRIPE_WEBHOOK_SECRET: optionalSecret,
  /** Türkiye billing (TRY + e-fatura). Stubbed until a later phase. */
  IYZICO_API_KEY: optionalSecret,
  IYZICO_SECRET_KEY: optionalSecret,
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid environment configuration:\n${details}\n\n` +
        `Copy .env.example to .env and fill in the missing values.`,
    );
  }

  return result.data;
}

/**
 * Validated environment. Exposed lazily so that merely importing a module that
 * touches `env` (during a build, a lint pass, or a unit test) does not blow up
 * before the process actually needs configuration.
 */
let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test-only escape hatch: validate an arbitrary source without touching the cache. */
export function parseEnvForTesting(source: NodeJS.ProcessEnv): Env {
  return parseEnv(source);
}

/**
 * Test-only: forget the cached environment so the next `getEnv()` re-reads
 * `process.env`. Needed by suites that flip a connector flag or supply a vault
 * key, since the cache is otherwise warmed by whichever test ran first.
 */
export function resetEnvForTesting(): void {
  cached = undefined;
}
