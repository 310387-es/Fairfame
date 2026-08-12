import Redis from "ioredis";
import { Client } from "pg";
// Relative + explicit extension (not the `@/*` alias) so `scripts/check-infra.mts`
// can import this module under Node's native TypeScript stripping, which does
// not read tsconfig path mappings.
import { getEnv } from "./env.ts";

/**
 * One-shot connectivity probes for the local infrastructure.
 *
 * These open and close their own connections deliberately: they answer "is the
 * dependency reachable right now?", which is what T2 verification and the T11
 * `/health` endpoint need. The long-lived Drizzle pool (T3) and the BullMQ
 * connection (T8) are separate concerns and must not be borrowed from here.
 */

export type ProbeResult = {
  service: "postgres" | "redis";
  ok: boolean;
  detail: string;
  durationMs: number;
};

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
  const started = process.hrtime.bigint();
  try {
    const value = await fn();
    return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  } catch (error) {
    return { error, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  }
}

function describeError(error: unknown): string {
  // Node's happy-eyeballs dial failures arrive as an AggregateError whose own
  // `message` is empty — the useful text (ECONNREFUSED host:port) is in .errors.
  if (error instanceof AggregateError) {
    const inner = [...new Set(error.errors.map(describeError))].filter(Boolean);
    return inner.length > 0 ? inner.join("; ") : error.name;
  }

  if (error instanceof Error) {
    const { code } = error as NodeJS.ErrnoException;
    const message = error.message || error.name;
    return code !== undefined && !message.includes(code) ? `${message} (${code})` : message;
  }

  return String(error);
}

export async function pingDatabase(): Promise<ProbeResult> {
  const client = new Client({
    connectionString: getEnv().DATABASE_URL,
    // Fail fast rather than hanging a health check behind a TCP timeout.
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });

  const { value, error, ms } = await timed(async () => {
    await client.connect();
    const result = await client.query<{ version: string }>("select version() as version");
    return result.rows[0]?.version ?? "unknown";
  });

  // Always release the socket, even when connect() itself failed.
  await client.end().catch(() => undefined);

  return {
    service: "postgres",
    ok: error === undefined,
    detail: error === undefined ? (value ?? "unknown") : describeError(error),
    durationMs: ms,
  };
}

export async function pingRedis(): Promise<ProbeResult> {
  const redis = new Redis(getEnv().REDIS_URL, {
    // Without these, ioredis retries forever and a health check never returns.
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 5_000,
    lazyConnect: true,
  });

  // ioredis emits `error` on the instance. With no listener attached, Node
  // reports it as an unhandled error event; and the rejection surfaced by
  // connect() is the generic "Connection is closed." rather than the useful
  // underlying ECONNREFUSED. Capture the first real error for the message.
  let firstError: unknown;
  redis.on("error", (error: unknown) => {
    firstError ??= error;
  });

  const { value, error, ms } = await timed(async () => {
    await redis.connect();
    const pong = await redis.ping();
    const server = await redis.info("server");
    const version = /redis_version:([^\r\n]+)/.exec(server)?.[1] ?? "unknown";
    return `${pong} (redis ${version})`;
  });

  redis.disconnect();

  return {
    service: "redis",
    ok: error === undefined,
    detail: error === undefined ? (value ?? "unknown") : describeError(firstError ?? error),
    durationMs: ms,
  };
}

/** Probes both dependencies concurrently; never throws. */
export async function checkInfra(): Promise<{ ok: boolean; results: ProbeResult[] }> {
  const results = await Promise.all([pingDatabase(), pingRedis()]);
  return { ok: results.every((result) => result.ok), results };
}
