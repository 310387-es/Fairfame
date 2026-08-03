import { consumeRateLimit } from "../lib/rate-limit.ts";
import { rateLimitFor, type RateLimitPolicy } from "./providers.ts";
import { ConnectorError } from "./types.ts";

/**
 * Staying inside each platform's quota, and backing off when we do not.
 *
 * Two separate mechanisms, because there are two separate problems:
 *
 * 1. **Budget.** A deployment-wide cap on calls per provider per minute, held
 *    in Redis so every web process and worker shares one counter. Google's
 *    Business Profile quota is per *project*, not per process, so a per-process
 *    limiter would be arithmetic with no relationship to the thing being
 *    limited.
 *
 * 2. **Backoff.** When a provider says no — a 429, or repeated failures — the
 *    affected connection is parked until a computed time. The Phase 0 scheduler
 *    rescans every minute and re-enqueues everything it finds, so without a
 *    "not before" marker a broken source would be retried sixty times an hour,
 *    forever.
 */

/** Thrown when the provider (or our own budget) says "not now". */
export class RateLimitError extends ConnectorError {
  readonly retryAfterMs: number;

  constructor(provider: string, retryAfterMs: number, message?: string) {
    super(
      message ??
        `Rate limit reached for "${provider}"; retrying in ${Math.ceil(retryAfterMs / 1_000)}s.`,
      provider,
      // Emphatically retryable: this is flow control, not a fault.
      true,
    );
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Claims one call against the provider's per-minute budget.
 *
 * A fixed window keyed to the provider, not the connection: the quota belongs
 * to our app across all tenants, and a hundred organizations syncing Google at
 * once is exactly the case this exists to smooth.
 */
export async function acquireProviderSlot(
  provider: string,
  policy: RateLimitPolicy = rateLimitFor(provider),
  now = new Date(),
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const window = 60;
  const result = await consumeRateLimit(`provider:${provider}`, policy.requestsPerMinute, window);

  if (result.allowed) return { allowed: true, retryAfterMs: 0 };

  // Wait out the remainder of the current window, plus a little jitter so a
  // hundred blocked connections do not all wake in the same millisecond.
  const msIntoWindow = now.getTime() % (window * 1_000);
  const retryAfterMs = window * 1_000 - msIntoWindow + jitter(1_000);

  return { allowed: false, retryAfterMs };
}

function jitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}

/**
 * Exponential backoff with full jitter, capped by the provider's policy.
 *
 * Full jitter rather than plain doubling because failures are correlated: when
 * a provider has an outage, every connection fails on the same scan tick, and
 * an unjittered schedule marches them back in lockstep to fail together again.
 */
export function computeBackoffMs(
  failureCount: number,
  policy: RateLimitPolicy,
  random: () => number = Math.random,
): number {
  const base = Math.max(policy.minSyncIntervalMs, 30_000);
  const exponential = Math.min(base * 2 ** Math.max(0, failureCount - 1), policy.maxBackoffMs);

  // Never shorter than half the ceiling of this step: full jitter alone can
  // return near-zero, which turns a backoff into a retry storm.
  return Math.floor(exponential / 2 + random() * (exponential / 2));
}

/** When this connection may next be synced after a successful run. */
export function nextSyncAfterSuccess(policy: RateLimitPolicy, now = new Date()): Date {
  return new Date(now.getTime() + policy.minSyncIntervalMs);
}

/**
 * Reads a `Retry-After` header (RFC 9110): either delta-seconds or an HTTP date.
 * Returns null when absent or unparseable, so the caller can fall back to its
 * own backoff rather than trusting a malformed hint.
 */
export function parseRetryAfter(header: string | null, now = new Date()): number | null {
  if (!header) return null;

  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;

  return Math.max(0, date - now.getTime());
}

/**
 * Turns a provider's HTTP response into a RateLimitError when it is one.
 * Connectors call this so that 429 handling is identical across providers.
 */
export function assertNotRateLimited(
  provider: string,
  response: { status: number; headers: { get(name: string): string | null } },
  now = new Date(),
): void {
  if (response.status !== 429 && response.status !== 503) return;

  const policy = rateLimitFor(provider);
  const hinted = parseRetryAfter(response.headers.get("retry-after"), now);

  throw new RateLimitError(
    provider,
    // Trust the provider's hint when it gives one; it knows its own window.
    Math.min(hinted ?? policy.minSyncIntervalMs, policy.maxBackoffMs),
  );
}
