import { createLocationCorpus, type LocationCorpus } from "./corpus.ts";

/**
 * A fake Google Business Profile, answering over HTTP.
 *
 * The point is the wire. Until now the Google connector was tested by replacing
 * `fetch` with a function that handed back a fixture, which proves the parser
 * works and nothing else: the URL was asserted rather than requested, the auth
 * header was inspected by the test rather than checked by a server, and page two
 * arrived because the test decided what page two was.
 *
 * Here the server decides. It rejects a missing bearer token, mints and consumes
 * its own page tokens, refuses an account it does not know, and can be told to
 * return a 429 — so backoff, refresh and pagination are exercised by the code
 * that will face the real thing, not by a mock of that code.
 *
 * It is **not** a Google emulator. It implements the four endpoints this product
 * calls, in the shapes `tests/fixtures/google/*.json` record, and nothing else.
 */

export type GoogleMockOptions = {
  accountId?: string;
  accountName?: string;
  locations?: { id: string; title: string }[];
  backfill?: number;
  dripMs?: number;
  seed?: string;
  /** Any bearer token not in this set is refused with a 401. */
  validTokens?: string[];
  now?: () => Date;
};

export type MockRequest = {
  method: string;
  /** Path and query, as the server received it. */
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
};

export type MockResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const DEFAULT_ACCOUNT = "106321548215487";
const DEFAULT_LOCATION = "12345678901234567890";

/** Google caps a review page at 50; the connector asks for exactly that. */
const PAGE_SIZE = 50;

function json(status: number, body: unknown, headers: Record<string, string> = {}): MockResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

/** Google's error envelope, matching `tests/fixtures/google/error-*.json`. */
function error(status: number, code: string, message: string, headers?: Record<string, string>) {
  return json(status, { error: { code: status, message, status: code } }, headers);
}

export function createGoogleMock(options: GoogleMockOptions = {}) {
  const accountId = options.accountId ?? DEFAULT_ACCOUNT;
  const accountName = options.accountName ?? "Revira Test İşletmesi";
  const locations = options.locations ?? [{ id: DEFAULT_LOCATION, title: "Kadıköy Şubesi" }];
  const now = options.now ?? (() => new Date());
  const validTokens = new Set(options.validTokens ?? []);

  const corpora = new Map<string, LocationCorpus>(
    locations.map((location) => [
      location.id,
      createLocationCorpus({
        accountId,
        locationId: location.id,
        backfill: options.backfill,
        dripMs: options.dripMs,
        seed: options.seed,
        startedAt: now(),
      }),
    ]),
  );

  /**
   * Page tokens are opaque to the client and meaningful to the server, exactly
   * as Google's are — an offset the *server* minted. A connector that tried to
   * construct one would break, which is the behaviour worth preserving.
   */
  const pageTokens = new Map<string, number>();
  let tokenCounter = 0;

  /** Set to have the next request answered with a 429. Consumed on use. */
  let throttleNext: { retryAfterSeconds: number } | null = null;

  function authorized(request: MockRequest): boolean {
    const header = request.headers.authorization ?? request.headers.Authorization;
    if (!header?.startsWith("Bearer ")) return false;
    // An empty allow-list means "any bearer token" — the common case, where the
    // test cares about pagination rather than about auth.
    if (validTokens.size === 0) return true;
    return validTokens.has(header.slice("Bearer ".length));
  }

  function handle(request: MockRequest): MockResponse {
    const url = new URL(request.url, "http://mock.local");
    const path = url.pathname;

    if (throttleNext) {
      const { retryAfterSeconds } = throttleNext;
      throttleNext = null;
      return error(429, "RESOURCE_EXHAUSTED", "Quota exceeded for quota metric 'Requests'.", {
        "retry-after": String(retryAfterSeconds),
      });
    }

    if (!authorized(request)) {
      // The shape that must trigger a token refresh rather than a hard failure.
      return error(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
    }

    // GET /v1/accounts
    if (request.method === "GET" && path.endsWith("/accounts")) {
      return json(200, {
        accounts: [
          {
            name: `accounts/${accountId}`,
            accountName,
            type: "LOCATION_GROUP",
            verificationState: "VERIFIED",
          },
        ],
      });
    }

    // GET /v1/accounts/{id}/locations
    const locationsMatch = /\/accounts\/([^/]+)\/locations$/.exec(path);
    if (request.method === "GET" && locationsMatch) {
      if (locationsMatch[1] !== accountId) {
        return error(403, "PERMISSION_DENIED", "The caller does not have permission.");
      }

      return json(200, {
        locations: locations.map((location) => ({
          name: `locations/${location.id}`,
          title: location.title,
          storefrontAddress: {
            addressLines: ["Caferağa Mah."],
            locality: "Kadıköy",
            administrativeArea: "İstanbul",
            regionCode: "TR",
          },
          metadata: { placeId: `ChIJmock${location.id.slice(0, 8)}` },
        })),
      });
    }

    // GET /v4/accounts/{a}/locations/{l}/reviews
    const reviewsMatch = /\/accounts\/([^/]+)\/locations\/([^/]+)\/reviews$/.exec(path);
    if (request.method === "GET" && reviewsMatch) {
      const corpus = corpora.get(reviewsMatch[2]!);
      if (reviewsMatch[1] !== accountId || !corpus) {
        return error(403, "PERMISSION_DENIED", "The caller does not have permission.");
      }

      const all = corpus.reviewsAt(now());
      const token = url.searchParams.get("pageToken");
      const offset = token ? (pageTokens.get(token) ?? -1) : 0;

      if (offset < 0) {
        return error(400, "INVALID_ARGUMENT", "Invalid page token.");
      }

      const slice = all.slice(offset, offset + PAGE_SIZE);
      const nextOffset = offset + slice.length;

      let nextPageToken: string | undefined;
      if (nextOffset < all.length) {
        nextPageToken = `mock-page-${(tokenCounter += 1)}`;
        pageTokens.set(nextPageToken, nextOffset);
      }

      return json(200, {
        reviews: slice,
        // Google reports the *total*, not the page — a connector that used it
        // as a page count would be wrong, so it is worth sending honestly.
        totalReviewCount: all.length,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
    }

    // PUT /v4/accounts/{a}/locations/{l}/reviews/{r}/reply
    const replyMatch = /\/accounts\/([^/]+)\/locations\/([^/]+)\/reviews\/([^/]+)\/reply$/.exec(
      path,
    );
    if (request.method === "PUT" && replyMatch) {
      const corpus = corpora.get(replyMatch[2]!);
      if (replyMatch[1] !== accountId || !corpus) {
        return error(403, "PERMISSION_DENIED", "The caller does not have permission.");
      }

      let comment: unknown;
      try {
        comment = (JSON.parse(request.body || "{}") as { comment?: unknown }).comment;
      } catch {
        return error(400, "INVALID_ARGUMENT", "Request body is not valid JSON.");
      }

      if (typeof comment !== "string" || comment.trim() === "") {
        return error(400, "INVALID_ARGUMENT", "Reply comment must not be empty.");
      }

      const updated = corpus.reply(replyMatch[3]!, comment, now());
      if (!updated) return error(404, "NOT_FOUND", "Review not found.");

      return json(200, updated.reviewReply);
    }

    return error(404, "NOT_FOUND", `Unknown endpoint: ${request.method} ${path}`);
  }

  return {
    handle,
    /** Makes the next request fail with a 429, so backoff can be exercised. */
    throttleOnce(retryAfterSeconds = 30) {
      throttleNext = { retryAfterSeconds };
    },
    accountId,
    locationIds: locations.map((location) => location.id),
    corpusFor: (locationId: string) => corpora.get(locationId),
  };
}

export type GoogleMock = ReturnType<typeof createGoogleMock>;
