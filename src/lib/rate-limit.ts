import Redis from "ioredis";
import { getEnv } from "./env.ts";
import { childLogger } from "./logger.ts";

/**
 * A fixed-window rate limiter on Redis.
 *
 * It exists for one reason: the review submission endpoint is unauthenticated
 * by design (a QR code on a table has no login), so without a limit anyone who
 * reads a slug off a poster could write unbounded rows into that tenant.
 *
 * Deliberately fail-open. If Redis is unreachable the choice is between
 * rejecting genuine customer reviews and accepting a burst of junk; for a
 * public feedback form the first is the worse failure. Every fail-open is
 * logged at warn so the gap is visible rather than silent.
 */

const log = childLogger({ module: "lib/rate-limit" });

let client: Redis | undefined;

function getClient(): Redis {
  client ??= new Redis(getEnv().REDIS_URL, {
    /**
     * The offline queue stays ON, and that is deliberate.
     *
     * With it off, ioredis rejects any command issued before the socket has
     * finished connecting — and this client is created lazily on the first
     * submission, which then issues INCR in the same tick. The result was a
     * guaranteed fail-open on the first request after every process start:
     * exactly the moment a flood would arrive. Queueing lets that first command
     * wait for the handshake instead of losing the race.
     *
     * `commandTimeout` is what keeps that safe: a genuinely unreachable Redis
     * fails the command in a bounded time rather than parking a customer's
     * review submission behind a connection that will never come up.
     */
    enableOfflineQueue: true,
    commandTimeout: 1_500,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
  });
  return client;
}

export type RateLimitResult = {
  allowed: boolean;
  /** Attempts left in the current window; 0 once the limit is reached. */
  remaining: number;
  /** How many have been counted in this window, including this one. */
  used: number;
};

/**
 * Counts one hit against `key` and reports whether it fits inside `limit`.
 *
 * Fixed window rather than sliding: it costs one INCR, and the worst case (a
 * double-rate burst straddling a window boundary) is irrelevant at the volumes
 * a review form sees.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const namespaced = `ratelimit:${key}`;

  try {
    const used = await getClient().incr(namespaced);

    // Only the first hit sets the TTL; re-setting it on every hit would extend
    // the window indefinitely under sustained traffic and never let it reset.
    if (used === 1) {
      await getClient().expire(namespaced, windowSeconds);
    }

    return { allowed: used <= limit, remaining: Math.max(0, limit - used), used };
  } catch (error) {
    // An availability event, not a crash: log the reason, not a stack trace
    // that would bury the actual request flow in dev.
    log.warn(
      { key, reason: error instanceof Error ? error.message : String(error) },
      "Rate limiter unavailable; allowing the request",
    );
    return { allowed: true, remaining: limit, used: 0 };
  }
}

/** Releases the limiter's connection. For scripts and test teardown. */
export async function closeRateLimiter(): Promise<void> {
  const current = client;
  client = undefined;
  await current?.quit().catch(() => current.disconnect());
}
