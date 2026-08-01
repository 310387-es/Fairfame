import pino, { type Logger } from "pino";

/**
 * Structured application logger (pino).
 *
 * Server-side only — do not import from client components.
 * Output is newline-delimited JSON so logs stay machine-readable in every
 * environment; pretty-printing is a shell concern (pipe through a formatter),
 * not an application concern.
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

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
  base: { service: "revira" },
  redact: { paths: redactPaths, censor: "[redacted]" },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
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
