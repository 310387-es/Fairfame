import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInstagramClient } from "@/connectors/instagram/client";
import { createInstagramConnector } from "@/connectors/instagram/connector";
import { startMockPlatform, type MockPlatform } from "@/connectors/mock-platform/server";
import type { Connection } from "@/connectors/types";
import { createWhatsAppClient } from "@/connectors/whatsapp/client";

/**
 * The real Instagram and WhatsApp connectors, over a real socket, against a
 * fake Meta.
 *
 * Same argument as the Google suite: replacing `fetch` with a fixture proves the
 * parser works and cannot prove the URL is routable, the auth header acceptable,
 * or the `since` filter honoured — because the test is the thing answering, and
 * it already agrees. Here something answers that does not.
 *
 * Both connectors share one mock because they share one API. Meta's error
 * envelope and numeric codes differ from Google's, which is the whole reason
 * this is a second mock rather than a parameter on the first.
 */

let platform: MockPlatform;

function instagramConnection(platformUnderTest: MockPlatform): Connection {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    locationId: "33333333-3333-4333-8333-333333333333",
    provider: "instagram",
    status: "active",
    capabilities: { read: "full", reply: "api", realtime: true },
    config: {
      locationId: "33333333-3333-4333-8333-333333333333",
      accountId: platformUnderTest.meta.accountId,
      username: "kahvemolasi",
    },
    encryptedTokens: null,
    cursor: null,
    lastSyncedAt: null,
    nextSyncAt: null,
    failureCount: 0,
    createdAt: new Date(),
  } as unknown as Connection;
}

function instagramFor(platformUnderTest: MockPlatform, token = "mock-meta-token") {
  return createInstagramConnector(
    createInstagramClient({
      baseUrl: platformUnderTest.metaBaseUrl,
      readToken: async () => token,
    }),
  );
}

beforeEach(async () => {
  platform = await startMockPlatform({
    meta: { backfill: 12, dripMs: 60_000, seed: "meta-test" },
  });
});

afterEach(async () => {
  await platform.close();
});

describe("Instagram over HTTP", () => {
  it("reads comments and mentions from the account's own edges", async () => {
    // Two edges, not one list — `/media` with comments expanded, and `/tags`.
    // A connector that flattened them would pass a fixture test and lose every
    // mention against the real API.
    const items = await instagramFor(platform).fetchReviews(instagramConnection(platform));

    expect(items.length).toBeGreaterThan(0);

    const paths = platform.requests.map((request) => request.url);
    expect(paths.some((path) => path.includes("/media"))).toBe(true);
    expect(paths.some((path) => path.includes("/tags"))).toBe(true);
    expect(platform.requests.every((request) => request.status === 200)).toBe(true);
  });

  it("normalizes a comment into the canonical model as a comment, not a review", async () => {
    const connector = instagramFor(platform);
    const connection = instagramConnection(platform);

    const raw = await connector.fetchReviews(connection);
    const normalized = raw.map((entry) => connector.normalize(connection, entry));

    expect(normalized.every((item) => item.source === "instagram")).toBe(true);

    // The distinction the schema exists to keep: a comment has no star rating,
    // and inventing one would put a made-up number into the reputation pulse.
    const comments = normalized.filter((item) => item.itemType === "comment");
    expect(comments.length).toBeGreaterThan(0);
    expect(comments.every((item) => item.rating === null)).toBe(true);
  });

  it("refuses an account the token does not administer", async () => {
    const connection = instagramConnection(platform);
    const wrong = {
      ...connection,
      config: { ...(connection.config as object), accountId: "17800000000000000" },
    } as Connection;

    await expect(instagramFor(platform).fetchReviews(wrong)).rejects.toThrow();
    expect(platform.requests.some((request) => request.status === 403)).toBe(true);
  });

  it("treats an expired token as its own kind of failure", async () => {
    const strict = await startMockPlatform({
      meta: { backfill: 3, validTokens: ["the-live-token"] },
    });

    try {
      await expect(
        instagramFor(strict, "the-live-token").fetchReviews(instagramConnection(strict)),
      ).resolves.toBeTruthy();

      await expect(
        instagramFor(strict, "an-expired-token").fetchReviews(instagramConnection(strict)),
      ).rejects.toThrow();

      expect(strict.requests.some((request) => request.status === 401)).toBe(true);
    } finally {
      await strict.close();
    }
  });

  it("surfaces a rate limit rather than a parse error", async () => {
    platform.meta.throttleOnce(30);

    await expect(
      instagramFor(platform).fetchReviews(instagramConnection(platform)),
    ).rejects.toThrow();

    expect(platform.requests.some((request) => request.status === 429)).toBe(true);
  });

  it("reads direct messages as their own item type", async () => {
    const connector = instagramFor(platform);
    const connection = instagramConnection(platform);

    const raw = await connector.fetchReviews(connection);
    const normalized = raw.map((entry) => connector.normalize(connection, entry));

    const dms = normalized.filter((item) => item.itemType === "dm");
    expect(dms.length).toBeGreaterThan(0);

    // A DM is private: there is no public permalink, and pointing at the
    // Instagram inbox would be a link to "somewhere in here".
    expect(dms.every((item) => item.url === null)).toBe(true);
    expect(dms.every((item) => item.rating === null)).toBe(true);
    expect(dms.every((item) => item.text !== null)).toBe(true);

    // The conversations edge was actually asked, with the platform selector —
    // without it the real API returns Facebook Page threads instead.
    const conversationCall = platform.requests.find((request) =>
      request.url.includes("/conversations"),
    );
    expect(conversationCall?.url).toContain("platform=instagram");
    expect(conversationCall?.status).toBe(200);
  });

  it("does not ingest the business's own replies as customer messages", async () => {
    const connector = instagramFor(platform);
    const connection = instagramConnection(platform);

    const raw = await connector.fetchReviews(connection);
    const dms = raw
      .map((entry) => connector.normalize(connection, entry))
      .filter((item) => item.itemType === "dm");

    // Every thread in the corpus contains the business's own answer, and
    // `from.id` is the only thing distinguishing it. Ingesting those would have
    // the product analysing its own support replies as customer sentiment.
    expect(dms.length).toBeGreaterThan(0);
    expect(dms.some((item) => item.text?.includes("ilginiz için teşekkürler"))).toBe(false);
    expect(dms.every((item) => item.authorName !== "kahvemolasi")).toBe(true);
  });

  it("still returns comments when the messaging permission was never granted", async () => {
    const limited = await startMockPlatform({
      meta: { backfill: 6, messagingGranted: false },
    });

    try {
      const connector = instagramFor(limited);
      const connection = instagramConnection(limited);
      const raw = await connector.fetchReviews(connection);
      const normalized = raw.map((entry) => connector.normalize(connection, entry));

      // `instagram_manage_messages` goes through app review separately. A
      // business that has comments but not messages must not lose its comments
      // to a hard failure on an edge it was never granted.
      expect(normalized.some((item) => item.itemType === "comment")).toBe(true);
      expect(normalized.some((item) => item.itemType === "dm")).toBe(false);
      expect(limited.requests.some((request) => request.status === 403)).toBe(true);
    } finally {
      await limited.close();
    }
  });

  it("advances the cursor on a DM, which names its timestamp differently", async () => {
    const connector = instagramFor(platform);
    const connection = instagramConnection(platform);

    const raw = await connector.fetchReviews(connection);
    const dmsOnly = raw.filter((entry) => (entry as unknown as { kind: string }).kind === "dm");

    // Comments carry `timestamp`; a DM carries `created_time`. A cursor that
    // only knew the first name would never advance on a sync of only messages,
    // and would re-read the same window forever.
    expect(dmsOnly.length).toBeGreaterThan(0);
    expect(connector.nextCursor!(connection, dmsOnly)).not.toBeNull();
  });

  it("finds comments that were not there on the previous sync", async () => {
    const clock = { now: new Date("2026-08-04T12:00:00.000Z") };
    const drip = await startMockPlatform({
      meta: { backfill: 6, dripMs: 60_000, seed: "meta-drip", now: () => clock.now },
    });

    try {
      const connector = instagramFor(drip);
      const connection = instagramConnection(drip);

      const first = await connector.fetchReviews(connection);
      clock.now = new Date(clock.now.getTime() + 3 * 60_000);
      const second = await connector.fetchReviews(connection);

      expect(second.length).toBeGreaterThan(first.length);

      // Ids are stable across the two reads, so the upsert dedups rather than
      // duplicating everything already ingested.
      const ids = second.map((entry) => connector.normalize(connection, entry).sourceReviewId);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await drip.close();
    }
  });
});

describe("WhatsApp over HTTP", () => {
  function client(platformUnderTest: MockPlatform, accessToken = "mock-meta-token") {
    return createWhatsAppClient({
      accessToken,
      phoneNumberId: platformUnderTest.meta.phoneNumberId,
      baseUrl: platformUnderTest.metaBaseUrl,
    });
  }

  it("sends a message and gets back a real wamid", async () => {
    const result = await client(platform).sendText({
      to: "905321234567",
      body: "Merhaba, yorumunuz için teşekkürler.",
    });

    expect(result.ok).toBe(true);
    // The id matters: delivery receipts arrive asynchronously and key on it, so
    // a send that returned nothing usable would leave them unattachable.
    if (result.ok) expect(result.messageId).toMatch(/^wamid\./);

    expect(platform.meta.sent).toHaveLength(1);
    expect(platform.meta.sent[0]?.to).toBe("905321234567");
  });

  it("classifies a rate limit as retryable rather than as a bad message", async () => {
    platform.meta.throttleOnce(30);

    // The client raises the shared throttle error so connector backoff handles
    // it like any other provider, rather than marking the send failed forever.
    await expect(
      client(platform).sendText({ to: "905321234567", body: "Merhaba" }),
    ).rejects.toThrow();

    expect(platform.requests.some((request) => request.status === 429)).toBe(true);
  });

  it("refuses a phone number id that is not ours", async () => {
    const result = await createWhatsAppClient({
      accessToken: "mock-meta-token",
      phoneNumberId: "000000000000000",
      baseUrl: platform.metaBaseUrl,
    }).sendText({ to: "905321234567", body: "Merhaba" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(false);
    expect(platform.meta.sent).toHaveLength(0);
  });

  it("does not send anything when the token is rejected", async () => {
    const strict = await startMockPlatform({
      meta: { validTokens: ["the-live-token"] },
    });

    try {
      const result = await client(strict, "an-expired-token").sendText({
        to: "905321234567",
        body: "Merhaba",
      });

      expect(result.ok).toBe(false);
      expect(strict.meta.sent).toHaveLength(0);
    } finally {
      await strict.close();
    }
  });
});
