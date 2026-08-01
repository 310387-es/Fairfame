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

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,

  BETTER_AUTH_SECRET: z.string().min(32, {
    message: "must be at least 32 characters — generate with `openssl rand -base64 32`",
  }),
  BETTER_AUTH_URL: z.url({ message: "must be a valid URL" }),

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
  LOG_PRETTY: booleanish.optional(),

  // Stripe is a stub in Phase 0 — absent or empty is valid.
  STRIPE_SECRET_KEY: z
    .string()
    .optional()
    .transform((value) => (value === "" ? undefined : value)),
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
