import pino, { type Logger, type LoggerOptions } from "pino";

/**
 * Structured application logger (pino).
 *
 * Server-side only — do not import from client components.
 * Production emits newline-delimited JSON so logs stay machine-readable.
 * Development pipes through pino-pretty for readability; set LOG_PRETTY=false
 * to get raw JSON in dev too.
 *
 * T2 replaces the raw `process.env` reads below with the Zod-validated config.
 */

// pino matches these literally: a bare key redacts at the top level, `*.key`
// redacts one level down. Secrets show up at both depths, so list both.
const SECRET_KEYS = [
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "encryptedTokens",
  "secret",
  "apiKey",
] as const;

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((key) => `*.${key}`),
];

const isProduction = process.env.NODE_ENV === "production";

/**
 * Base pino options, without any destination or transport.
 * Exported so tests can build a logger over an in-memory stream and assert on
 * the exact serialized output (see tests/lib/logger.test.ts).
 */
export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  // Named `app`, not `service`: a base binding called "service" collides with
  // the natural field name for "which dependency/queue/provider is this
  // about?", and the pretty transport then hides the more specific one.
  base: { app: "revira" },
  redact: { paths: redactPaths, censor: "[redacted]" },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

const usePrettyTransport = !isProduction && process.env.LOG_PRETTY !== "false";

export const logger: Logger = pino({
  ...loggerOptions,
  ...(usePrettyTransport
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname,app" },
        },
      }
    : {}),
});

/**
 * Child logger bound to a module or request scope.
 *
 * Prefer this over the root logger so every line carries its origin:
 *   const log = childLogger({ module: "connectors/mock" })
 */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
