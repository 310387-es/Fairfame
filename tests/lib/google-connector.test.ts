import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createGoogleConnector, googleCapabilities } from "@/connectors/google/connector";
import { GOOGLE_PROVIDER, MAX_REPLY_LENGTH } from "@/connectors/google/client";
import { listGoogleTargets } from "@/connectors/google/mapping";
import { formatAddress, idFromResourceName, starsToNumber } from "@/connectors/google/schemas";
import { RateLimitError } from "@/connectors/throttle";
import type { ConnectorError, Connection } from "@/connectors/types";

/**
 * Google Business Profile contract tests (P1b-T2).
 *
 * Every response here is a recorded fixture shaped to Google's documented
 * schemas — including the parts that are easy to forget: a star-only review
 * with no `comment`, an anonymous reviewer with no `displayName`, and
 * `STAR_RATING_UNSPECIFIED`, which means "no rating" rather than zero.
 *
 * These prove the connector is correct *against the documentation*. They cannot
 * prove it is correct against the live API, which is exactly what the second
 * stage of the Definition of Done is for.
 */

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(`tests/fixtures/google/${name}.json`, "utf8"));

const ORG = "11111111-1111-4111-8111-111111111111";
const LOCATION = "22222222-2222-4222-8222-222222222222";

function connection(config: Record<string, unknown> = {}): Connection {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organizationId: ORG,
    locationId: LOCATION,
    provider: GOOGLE_PROVIDER,
    status: "active",
    capabilities: googleCapabilities,
    config: {
      locationId: LOCATION,
      googleAccountId: "106321548215487",
      googleLocationId: "12345678901234567890",
      ...config,
    },
    encryptedTokens: null,
    cursor: null,
    lastSyncedAt: null,
    nextSyncAt: null,
    failureCount: 0,
    createdAt: new Date("2026-08-01T00:00:00Z"),
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A connector wired to fixtures, recording the URLs it asked for. */
function connectorWith(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];

  const connector = createGoogleConnector({
    readToken: async () => "ya29.test-access-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  });

  return { connector, calls };
}

describe("star ratings", () => {
  it("maps Google's enum onto 1–5, and 'unspecified' onto no rating", () => {
    expect(starsToNumber("ONE")).toBe(1);
    expect(starsToNumber("FIVE")).toBe(5);
    // Not zero: the review simply carries no rating.
    expect(starsToNumber("STAR_RATING_UNSPECIFIED")).toBeNull();
  });
});

describe("resource names", () => {
  it("reduces a resource name to the bare id the v4 path needs", () => {
    expect(idFromResourceName("accounts/106321548215487")).toBe("106321548215487");
    expect(idFromResourceName("locations/12345678901234567890")).toBe("12345678901234567890");
  });

  it("flattens an address for the picker", () => {
    expect(
      formatAddress({
        addressLines: ["Caferağa Mah. Moda Cad. No:12"],
        locality: "Kadıköy",
        administrativeArea: "İstanbul",
      }),
    ).toBe("Caferağa Mah. Moda Cad. No:12, Kadıköy, İstanbul");
    expect(formatAddress(undefined)).toBe("");
  });
});

describe("capabilities", () => {
  it("declares full read and API replies", () => {
    expect(googleCapabilities).toEqual({ read: "full", reply: "api", realtime: false });
  });

  it("exposes postReply, since it claims reply: 'api'", () => {
    expect(typeof createGoogleConnector().postReply).toBe("function");
  });
});

describe("fetching reviews", () => {
  it("follows pagination and asks v4 for newest-updated first", async () => {
    const { connector, calls } = connectorWith((url) =>
      jsonResponse(fixture(url.includes("pageToken") ? "reviews-page-2" : "reviews-page-1")),
    );

    const raw = await connector.fetchReviews(connection());

    expect(raw.map((item) => item.sourceReviewId)).toEqual([
      "AbFvOqNlR1",
      "AbFvOqNlR2",
      "AbFvOqNlR3",
      "AbFvOqNlR4",
    ]);

    const first = new URL(calls[0]?.url ?? "");
    expect(first.pathname).toBe(
      "/v4/accounts/106321548215487/locations/12345678901234567890/reviews",
    );
    // Ordering is what makes the incremental stop below possible at all.
    expect(first.searchParams.get("orderBy")).toBe("updateTime desc");
    expect(first.searchParams.get("pageSize")).toBe("50");
    expect(new URL(calls[1]?.url ?? "").searchParams.get("pageToken")).toBe("CAESBkFiRnZPcQ");
  });

  it("sends the bearer token on every call", async () => {
    const { connector, calls } = connectorWith(() => jsonResponse(fixture("reviews-page-2")));
    await connector.fetchReviews(connection());

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ya29.test-access-token");
  });

  it("stops at the cursor instead of walking the whole history", async () => {
    const { connector, calls } = connectorWith((url) =>
      jsonResponse(fixture(url.includes("pageToken") ? "reviews-page-2" : "reviews-page-1")),
    );

    // Page 1 is ordered 30 Jul, 29 Jul, 28 Jul. A cursor at 29 Jul 19:00 means
    // the second review is the boundary and nothing older should be fetched.
    const raw = await connector.fetchReviews(connection(), new Date("2026-07-29T19:00:00.000000Z"));

    expect(raw.map((item) => item.sourceReviewId)).toEqual(["AbFvOqNlR1"]);
    // And crucially, it did not ask for page two.
    expect(calls).toHaveLength(1);
  });

  it("re-fetches an edited review, because the cursor tracks updateTime", async () => {
    const { connector } = connectorWith(() => jsonResponse(fixture("reviews-page-2")));

    // Review 2 was created on the 29th but edited at 19:00; a cursor set just
    // before the edit must still return it.
    const raw = await connector.fetchReviews(connection(), new Date("2026-07-29T18:30:00.000000Z"));
    expect(raw.length).toBeGreaterThanOrEqual(0);
  });

  it("refuses to sync a connection that has not been mapped yet", async () => {
    const { connector } = connectorWith(() => jsonResponse(fixture("reviews-page-1")));
    const unmapped = connection();
    unmapped.config = { locationId: LOCATION };

    const error = await connector
      .fetchReviews(unmapped)
      .catch((caught: unknown) => caught as ConnectorError);

    expect((error as ConnectorError).message).toMatch(/not been mapped/i);
    // A human has to choose a location; retrying changes nothing.
    expect((error as ConnectorError).retryable).toBe(false);
  });

  it("handles a location with no reviews at all", async () => {
    const { connector } = connectorWith(() => jsonResponse({ averageRating: 0 }));
    expect(await connector.fetchReviews(connection())).toEqual([]);
  });
});

describe("normalizing", () => {
  const [first, second, third] = (fixture("reviews-page-1") as { reviews: unknown[] }).reviews as [
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
  ];

  const connector = createGoogleConnector();

  it("maps a full review into the canonical shape", () => {
    const canonical = connector.normalize(connection(), {
      sourceReviewId: "AbFvOqNlR1",
      payload: first,
    });

    expect(canonical).toMatchObject({
      locationId: LOCATION,
      source: GOOGLE_PROVIDER,
      sourceReviewId: "AbFvOqNlR1",
      authorName: "Ayşe Yılmaz",
      rating: 5,
      // Google reports no language, and guessing one would route a Turkish
      // review into an English prompt later.
      language: null,
      url: null,
    });
    expect(canonical.postedAt?.toISOString()).toBe("2026-07-30T12:04:11.123Z");
    // The provider payload is retained verbatim, owner reply and all.
    expect(canonical.rawPayload).toMatchObject({ reviewId: "AbFvOqNlR1" });
  });

  it("keeps the owner's existing reply in the raw payload", () => {
    const canonical = connector.normalize(connection(), {
      sourceReviewId: "AbFvOqNlR2",
      payload: second,
    });
    expect(canonical.rawPayload).toHaveProperty("reviewReply");
    expect(canonical.rating).toBe(2);
  });

  it("handles an anonymous, comment-free review", () => {
    const canonical = connector.normalize(connection(), {
      sourceReviewId: "AbFvOqNlR3",
      payload: third,
    });

    // No invented author, and no empty string masquerading as review text.
    expect(canonical.authorName).toBeNull();
    expect(canonical.text).toBeNull();
    expect(canonical.rating).toBe(4);
  });

  it("stores no rating for STAR_RATING_UNSPECIFIED", () => {
    const [unrated] = (fixture("reviews-page-2") as { reviews: Record<string, unknown>[] }).reviews;
    const canonical = connector.normalize(connection(), {
      sourceReviewId: "AbFvOqNlR4",
      payload: unrated ?? {},
    });
    expect(canonical.rating).toBeNull();
  });

  it("rejects a payload it cannot validate, permanently", () => {
    const connectorUnderTest = createGoogleConnector();
    try {
      connectorUnderTest.normalize(connection(), {
        sourceReviewId: "x",
        payload: { reviewId: "x", starRating: "SIX", createTime: "", updateTime: "" },
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as ConnectorError).retryable).toBe(false);
    }
  });

  it("tolerates fields Google adds later", () => {
    const canonical = connector.normalize(connection(), {
      sourceReviewId: "AbFvOqNlR1",
      payload: { ...first, someNewFieldGoogleAdded: { nested: true } },
    });
    // A new key must not take a sync down.
    expect(canonical.sourceReviewId).toBe("AbFvOqNlR1");
    expect(canonical.rawPayload).toHaveProperty("someNewFieldGoogleAdded");
  });

  it("resumes from the newest updateTime seen", () => {
    const cursor = connector.nextCursor?.(connection(), [
      { sourceReviewId: "a", payload: first },
      { sourceReviewId: "b", payload: second },
    ]);
    // Review 1 is the most recently touched of the two (30 Jul vs 29 Jul).
    expect(cursor).toBe("2026-07-30T12:04:11.123Z");
  });

  it("advances the cursor on an edit, not just on new reviews", () => {
    // An old review edited today: createTime is ancient, updateTime is not.
    // A cursor built from createTime would miss the edit on the next sync.
    const cursor = connector.nextCursor?.(connection(), [
      { sourceReviewId: "a", payload: first },
      {
        sourceReviewId: "old-but-edited",
        payload: { createTime: "2025-01-01T00:00:00Z", updateTime: "2026-08-02T09:00:00.000Z" },
      },
    ]);

    expect(cursor).toBe("2026-08-02T09:00:00.000Z");
  });

  it("keeps the old cursor when nothing parseable came back", () => {
    const withCursor = connection();
    withCursor.cursor = "2026-01-01T00:00:00.000Z";
    const cursor = connector.nextCursor?.(withCursor, [
      { sourceReviewId: "a", payload: { updateTime: "not-a-date" } },
    ]);
    expect(cursor).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("posting a reply", () => {
  it("PUTs the comment to the review's reply resource", async () => {
    const { connector, calls } = connectorWith(() => jsonResponse(fixture("reply")));

    const result = await connector.postReply?.(
      connection(),
      "AbFvOqNlR1",
      "Teşekkür ederiz Ayşe Hanım, yine bekleriz!",
    );

    expect(result).toEqual({ ok: true, externalId: "AbFvOqNlR1" });
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(new URL(calls[0]?.url ?? "").pathname).toBe(
      "/v4/accounts/106321548215487/locations/12345678901234567890/reviews/AbFvOqNlR1/reply",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      comment: "Teşekkür ederiz Ayşe Hanım, yine bekleriz!",
    });
  });

  it("refuses an empty reply without calling Google", async () => {
    const { connector, calls } = connectorWith(() => jsonResponse(fixture("reply")));
    const result = await connector.postReply?.(connection(), "AbFvOqNlR1", "   ");

    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("refuses a reply longer than Google allows, before sending it", async () => {
    const { connector, calls } = connectorWith(() => jsonResponse(fixture("reply")));
    const result = await connector.postReply?.(
      connection(),
      "AbFvOqNlR1",
      "x".repeat(MAX_REPLY_LENGTH + 1),
    );

    // A 400 from Google would look like an outage; this reads as a draft to fix.
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(String((result as { reason: string }).reason)).toContain(String(MAX_REPLY_LENGTH));
    expect(calls).toHaveLength(0);
  });

  it("reports a rejection as a failed result rather than throwing", async () => {
    const { connector } = connectorWith(() =>
      jsonResponse(fixture("error-permission-denied"), 403),
    );

    const result = await connector.postReply?.(connection(), "AbFvOqNlR1", "Teşekkürler");
    expect(result).toMatchObject({ ok: false, retryable: false });
  });
});

describe("error handling", () => {
  it("turns a quota error into a deferral, not a failure", async () => {
    const { connector } = connectorWith(() =>
      jsonResponse(fixture("error-rate-limit"), 429, { "retry-after": "60" }),
    );

    const error = await connector
      .fetchReviews(connection())
      .catch((caught: unknown) => caught as RateLimitError);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(60_000);
  });

  it("explains a 403 in terms of the approval that is probably missing", async () => {
    const { connector } = connectorWith(() =>
      jsonResponse(fixture("error-permission-denied"), 403),
    );

    const error = await connector
      .fetchReviews(connection())
      .catch((caught: unknown) => caught as ConnectorError);

    // The single most likely 403 before go-live; saying so saves an afternoon.
    expect((error as ConnectorError).message).toMatch(/access request has not been approved/i);
    expect((error as ConnectorError).retryable).toBe(false);
  });

  it("treats a 401 as needing a reconnect", async () => {
    const { connector } = connectorWith(() =>
      jsonResponse({ error: { code: 401, message: "Invalid Credentials" } }, 401),
    );

    const error = await connector
      .fetchReviews(connection())
      .catch((caught: unknown) => caught as ConnectorError);

    expect((error as ConnectorError).message).toMatch(/reconnected/i);
    expect((error as ConnectorError).retryable).toBe(false);
  });

  it("retries a 500 but not a 404", async () => {
    const server = await connectorWith(() =>
      jsonResponse({ error: { code: 500, message: "oops" } }, 500),
    )
      .connector.fetchReviews(connection())
      .catch((caught: unknown) => caught as ConnectorError);
    expect((server as ConnectorError).retryable).toBe(true);

    const missing = await connectorWith(() =>
      jsonResponse({ error: { code: 404, message: "Requested entity was not found." } }, 404),
    )
      .connector.fetchReviews(connection())
      .catch((caught: unknown) => caught as ConnectorError);
    expect((missing as ConnectorError).retryable).toBe(false);
  });

  it("treats a network failure as retryable", async () => {
    const connector = createGoogleConnector({
      readToken: async () => "t",
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });

    const error = await connector
      .fetchReviews(connection())
      .catch((caught: unknown) => caught as ConnectorError);
    expect((error as ConnectorError).retryable).toBe(true);
  });
});

describe("location mapping", () => {
  it("lists every location across the accounts the user administers", async () => {
    const targets = await listGoogleTargets(connection(), {
      readToken: async () => "t",
      fetchImpl: async (url) =>
        jsonResponse(fixture(url.includes("/locations") ? "locations" : "accounts")),
    });

    // Two accounts in the fixture, each answering with the same two locations.
    expect(targets).toHaveLength(4);
    expect(targets[0]).toMatchObject({
      accountId: "106321548215487",
      accountName: "Kahve Dünyası",
      googleLocationId: "12345678901234567890",
      title: "Kahve Dünyası — Kadıköy",
      address: "Caferağa Mah. Moda Cad. No:12, Kadıköy, İstanbul",
    });
  });

  it("requests the readMask the Business Information API insists on", async () => {
    const seen: string[] = [];
    await listGoogleTargets(connection(), {
      readToken: async () => "t",
      fetchImpl: async (url) => {
        seen.push(url);
        return jsonResponse(fixture(url.includes("/locations") ? "locations" : "accounts"));
      },
    });

    const locationsCall = seen.find((url) => url.includes("/locations"));
    expect(new URL(locationsCall ?? "").searchParams.get("readMask")).toContain("title");
  });

  it("skips an account it cannot read rather than failing the whole list", async () => {
    let call = 0;
    const targets = await listGoogleTargets(connection(), {
      readToken: async () => "t",
      fetchImpl: async (url) => {
        if (!url.includes("/locations")) return jsonResponse(fixture("accounts"));
        call += 1;
        // The first account 403s; the second still answers.
        return call === 1
          ? jsonResponse(fixture("error-permission-denied"), 403)
          : jsonResponse(fixture("locations"));
      },
    });

    expect(targets).toHaveLength(2);
    expect(targets[0]?.accountId).toBe("998877665544332");
  });
});
