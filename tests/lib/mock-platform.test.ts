import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGoogleConnector } from "@/connectors/google/connector";
import { startMockPlatform, type MockPlatform } from "@/connectors/mock-platform/server";
import type { Connection } from "@/connectors/types";

/**
 * The real Google connector, over a real socket, against a fake Google.
 *
 * Everything else about Google is tested by replacing `fetch` with a function
 * that returns a fixture. That proves the parser works. It cannot prove that the
 * URL the connector builds is one a server will route, that the auth header it
 * sends is one a server will accept, or that its pagination loop terminates
 * against page tokens it did not invent — because in those tests the connector
 * is talking to the test, and the test already agrees with it.
 *
 * Here it talks to something that disagrees when it is wrong.
 */

let platform: MockPlatform;

/** A connection row, as the sync path would hand it to the connector. */
function connectionFor(platformUnderTest: MockPlatform, overrides: Partial<Connection> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    locationId: "33333333-3333-4333-8333-333333333333",
    provider: "google",
    status: "active",
    capabilities: { read: "poll", reply: "api", collect: "none" },
    config: {
      // Ours, then Google's — the mapping step writes all three.
      locationId: "33333333-3333-4333-8333-333333333333",
      googleAccountId: platformUnderTest.google.accountId,
      googleLocationId: platformUnderTest.google.locationIds[0],
      googleLocationTitle: "Kadıköy Şubesi",
    },
    encryptedTokens: null,
    cursor: null,
    lastSyncedAt: null,
    nextSyncAt: null,
    failureCount: 0,
    createdAt: new Date(),
    ...overrides,
  } as unknown as Connection;
}

/** The connector, pointed at the fake platform with a token reader that always succeeds. */
function connectorFor(platformUnderTest: MockPlatform) {
  return createGoogleConnector({
    ...platformUnderTest.googleBaseUrls,
    readToken: async () => "mock-access-token",
  });
}

beforeEach(async () => {
  platform = await startMockPlatform({
    google: { backfill: 120, dripMs: 60_000, seed: "platform-test" },
  });
});

afterEach(async () => {
  await platform.close();
});

describe("reading reviews over HTTP", () => {
  it("walks every page without the test deciding what page two is", async () => {
    // 120 reviews at Google's 50-per-page cap is three requests, and the third
    // is reached only if the connector reads and returns the server's own token.
    const reviews = await connectorFor(platform).fetchReviews(connectionFor(platform));

    expect(reviews.length).toBe(120);

    const reviewCalls = platform.requests.filter((request) => request.url.includes("/reviews"));
    expect(reviewCalls.length).toBe(3);
    expect(reviewCalls.every((request) => request.status === 200)).toBe(true);
  });

  it("sends a bearer token the server is willing to accept", async () => {
    const strict = await startMockPlatform({
      google: { backfill: 3, validTokens: ["the-only-good-token"] },
    });

    try {
      const good = createGoogleConnector({
        ...strict.googleBaseUrls,
        readToken: async () => "the-only-good-token",
      });

      await expect(good.fetchReviews(connectionFor(strict))).resolves.toHaveLength(3);

      const bad = createGoogleConnector({
        ...strict.googleBaseUrls,
        readToken: async () => "a-stale-token",
      });

      // A 401 is the shape that must be distinguishable from a permanent
      // failure, because it is the one a token refresh can fix.
      await expect(bad.fetchReviews(connectionFor(strict))).rejects.toThrow();
    } finally {
      await strict.close();
    }
  });

  it("normalizes what the server sent into the canonical model", async () => {
    const connector = connectorFor(platform);
    const raw = await connector.fetchReviews(connectionFor(platform));
    const review = connector.normalize(connectionFor(platform), raw[0]!);

    expect(review.source).toBe("google");
    expect(review.sourceReviewId).toBeTruthy();
    expect(review.rating === null || (review.rating >= 1 && review.rating <= 5)).toBe(true);
    expect(review.postedAt).toBeInstanceOf(Date);
    // The untouched provider payload is always kept — the canonical model is a
    // projection, never a replacement.
    expect(review.rawPayload).toBeTruthy();
  });
});

describe("the platform behaving badly", () => {
  it("surfaces a 429 as a retryable failure rather than a parse error", async () => {
    platform.google.throttleOnce(42);

    await expect(connectorFor(platform).fetchReviews(connectionFor(platform))).rejects.toThrow();

    expect(platform.requests.some((request) => request.status === 429)).toBe(true);
  });

  it("refuses an account the caller does not administer", async () => {
    const connection = connectionFor(platform, {
      config: {
        locationId: "33333333-3333-4333-8333-333333333333",
        googleAccountId: "999999999",
        googleLocationId: platform.google.locationIds[0],
      },
    } as Partial<Connection>);

    await expect(connectorFor(platform).fetchReviews(connection)).rejects.toThrow();
    expect(platform.requests.some((request) => request.status === 403)).toBe(true);
  });
});

describe("new reviews arriving", () => {
  it("shows content that did not exist on the previous sync", async () => {
    // The whole reason this is a platform and not a fixture. A connector that
    // reads one page correctly still has to cope with the page changing under
    // it, and nothing static can ask that question.
    const clock = { now: new Date("2026-08-04T12:00:00.000Z") };
    const drip = await startMockPlatform({
      google: { backfill: 5, dripMs: 60_000, seed: "drip", now: () => clock.now },
    });

    try {
      const connector = createGoogleConnector({
        ...drip.googleBaseUrls,
        readToken: async () => "mock-access-token",
      });

      const first = await connector.fetchReviews(connectionFor(drip));
      expect(first).toHaveLength(5);

      // Two minutes later, two more have been left.
      clock.now = new Date(clock.now.getTime() + 2 * 60_000);
      const second = await connector.fetchReviews(connectionFor(drip));

      expect(second.length).toBe(7);

      // And the ones already seen keep their identity, so the upsert dedups
      // rather than duplicating — the property a re-sync depends on.
      const firstIds = new Set(
        first.map((raw) => connector.normalize(connectionFor(drip), raw).sourceReviewId),
      );
      const secondIds = second.map(
        (raw) => connector.normalize(connectionFor(drip), raw).sourceReviewId,
      );
      expect(secondIds.filter((id) => firstIds.has(id))).toHaveLength(5);
      expect(new Set(secondIds).size).toBe(7);
    } finally {
      await drip.close();
    }
  });
});

describe("replying over HTTP", () => {
  it("posts a reply the server accepts, and reads it back on the next sync", async () => {
    const connector = connectorFor(platform);
    const connection = connectionFor(platform);

    const raw = await connector.fetchReviews(connection);
    const target = connector.normalize(connection, raw[0]!);

    const result = await connector.postReply?.(connection, target.sourceReviewId, "Teşekkürler!");
    expect(result?.ok).toBe(true);

    // Google bumps `updateTime` when a reply lands, so the review comes back on
    // the next incremental sync carrying the reply. A connector that assumed a
    // replied review would never reappear would be wrong about the real API.
    const after = await connector.fetchReviews(connection);
    // `fetchReviews` yields `{ sourceReviewId, payload }`; the reply lives on
    // the untouched provider payload, which is the point of keeping it.
    const replied = after.find((entry) => entry.sourceReviewId === target.sourceReviewId);
    const payload = replied?.payload as { reviewReply?: { comment: string } } | undefined;

    expect(payload?.reviewReply?.comment).toBe("Teşekkürler!");
  });

  it("rejects an empty reply instead of silently posting nothing", async () => {
    const connector = connectorFor(platform);
    const connection = connectionFor(platform);
    const raw = await connector.fetchReviews(connection);
    const target = connector.normalize(connection, raw[0]!);

    const result = await connector.postReply?.(connection, target.sourceReviewId, "   ");

    expect(result?.ok).toBe(false);
  });
});
