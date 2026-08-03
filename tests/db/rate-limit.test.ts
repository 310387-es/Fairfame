import { afterAll, describe, expect, it } from "vitest";
import { closeRateLimiter, consumeRateLimit } from "@/lib/rate-limit";

/**
 * The rate limiter, against a real Redis.
 *
 * It lives in the database suite rather than the unit suite because the thing
 * worth testing is the client's behaviour, not the arithmetic — and the bug
 * this guards against was invisible without a real connection: with the offline
 * queue disabled, the very first command after process start was rejected
 * before the socket finished connecting, so the limiter failed open at exactly
 * the moment a flood would arrive.
 *
 * The first assertion below therefore runs against a cold client on purpose.
 */

const key = `test:${crypto.randomUUID()}`;

afterAll(async () => {
  await closeRateLimiter();
});

describe("consumeRateLimit", () => {
  it("counts the very first call, on a client that has not connected yet", async () => {
    // No warm-up: this is the request that used to be waved through.
    const first = await consumeRateLimit(key, 3, 60);
    expect(first).toEqual({ allowed: true, remaining: 2, used: 1 });
  });

  it("counts up to the limit and then refuses", async () => {
    expect((await consumeRateLimit(key, 3, 60)).used).toBe(2);
    expect((await consumeRateLimit(key, 3, 60)).allowed).toBe(true);

    const over = await consumeRateLimit(key, 3, 60);
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it("keeps separate keys separate", async () => {
    const other = await consumeRateLimit(`${key}:other`, 3, 60);
    expect(other.allowed).toBe(true);
    expect(other.used).toBe(1);
  });

  it("expires the window rather than extending it on every hit", async () => {
    const windowed = `test:${crypto.randomUUID()}`;
    await consumeRateLimit(windowed, 5, 1);
    await consumeRateLimit(windowed, 5, 1);

    // The TTL is set once, by the first hit; later hits must not push it out,
    // or a steady trickle would keep a window open forever.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await consumeRateLimit(windowed, 5, 1)).used).toBe(1);
  });
});
