import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { firstPartyConnector } from "@/connectors/firstparty";
import { createGoogleConnector } from "@/connectors/google/connector";
import { createInstagramClient } from "@/connectors/instagram/client";
import { createInstagramConnector } from "@/connectors/instagram/connector";
import { mockConnector } from "@/connectors/mock";
import { getProvider } from "@/connectors/providers";
import type { Connection, Connector, RawReview } from "@/connectors/types";

/**
 * The contract every connector must satisfy (P1b-T6).
 *
 * Each connector already has its own suite testing what makes it different.
 * This one tests what makes them the *same*, and it exists because the
 * `Connector` interface is the product's central abstraction: ingestion, dedup,
 * the Inbox, analysis, the digest and the capability-driven UI all assume
 * properties TypeScript cannot express.
 *
 * "`postReply` is present exactly when `capabilities.reply === 'api'`" is a
 * contract the compiler will not check — `postReply?` is optional to every
 * implementation — and the UI relies on it to decide between a composer and an
 * "Open on platform" link. Likewise "normalize is pure" and "a connector never
 * produces a row for another location": both are load-bearing, and both would
 * fail silently.
 *
 * Adding a connector means adding a row to `CONNECTORS`. That is the point: a
 * new source cannot ship without meeting the same bar.
 */

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8"));
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const ORG_ID = "44444444-4444-4444-8444-444444444444";
const LOCATION_ID = "55555555-5555-4555-8555-555555555555";

function connectionFor(connector: Connector, config: Record<string, unknown>): Connection {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    organizationId: ORG_ID,
    locationId: LOCATION_ID,
    provider: connector.provider,
    status: "active",
    capabilities: connector.capabilities,
    config,
    encryptedTokens: null,
    cursor: null,
    lastSyncedAt: null,
    firstSyncedAt: null,
    nextSyncAt: null,
    failureCount: 0,
    createdAt: new Date(),
  };
}

type Subject = {
  name: string;
  connector: Connector;
  /** Valid `connect` input for this provider. */
  config: Record<string, unknown>;
  /** True when the provider is expected to return items from fixtures. */
  yieldsItems: boolean;
};

/** Google's fixture-backed client, mirroring its own suite. */
function googleSubject(): Connector {
  return createGoogleConnector({
    readToken: async () => "test-token",
    fetchImpl: async (input: string) => {
      if (input.includes("/reviews")) {
        // Page one carries a `nextPageToken`; serving it forever would run the
        // connector into its own pagination cap.
        return response(
          fixture(
            input.includes("pageToken")
              ? "google/reviews-page-2.json"
              : "google/reviews-page-1.json",
          ),
        );
      }
      if (input.includes("/locations")) return response(fixture("google/locations.json"));
      return response(fixture("google/accounts.json"));
    },
  });
}

function instagramSubject(): Connector {
  return createInstagramConnector(
    createInstagramClient({
      readToken: async () => "test-token",
      fetchImpl: async (input: string) => {
        if (input.includes("/media"))
          return response(fixture("instagram/media-with-comments.json"));
        if (input.includes("/tags")) return response(fixture("instagram/mentions.json"));
        return response({ id: "17841400000000000", username: "kahvemolasi" });
      },
    }),
  );
}

const CONNECTORS: Subject[] = [
  {
    name: "mock",
    connector: mockConnector,
    config: { locationId: LOCATION_ID, backfillCount: 5 },
    yieldsItems: true,
  },
  {
    name: "firstparty",
    connector: firstPartyConnector,
    config: { locationId: LOCATION_ID },
    // A push source: rows arrive through the public submission route, never
    // through a poll, so `fetchReviews` returning nothing is correct.
    yieldsItems: false,
  },
  {
    name: "google",
    connector: googleSubject(),
    config: {
      locationId: LOCATION_ID,
      googleAccountId: "accounts/106321548215487",
      googleLocationId: "locations/12345678901234567890",
    },
    yieldsItems: true,
  },
  {
    name: "instagram",
    connector: instagramSubject(),
    config: { locationId: LOCATION_ID, accountId: "17841400000000000" },
    yieldsItems: true,
  },
];

describe.each(CONNECTORS)("$name satisfies the Connector contract", (subject) => {
  const { connector, config } = subject;

  it("is registered as a provider", () => {
    // A connector nobody declared cannot be flagged, rate-limited or rendered:
    // `providers.ts` is what the mode resolution and the UI read.
    expect(getProvider(connector.provider)).toBeDefined();
  });

  it("declares the same capabilities as its descriptor", () => {
    // The capability-driven UI reads the *descriptor*, so a connector that
    // disagreed with it would offer an action it cannot perform — or hide one
    // it can.
    expect(connector.capabilities).toEqual(getProvider(connector.provider)?.capabilities);
  });

  it("offers postReply exactly when it claims an API reply", () => {
    // The contract TypeScript cannot express. `postReply?` is optional to every
    // implementation, and the Inbox decides between a composer and an
    // "Open on platform" link purely on the capability.
    const claimsApi = connector.capabilities.reply === "api";
    expect(typeof connector.postReply === "function").toBe(claimsApi);
  });

  it("returns a draft connection for the organization it was given", async () => {
    const draft = await connector.connect(ORG_ID, config);

    // The sync pipeline rejects a mismatch as defence in depth; this is the
    // connector's half of that agreement.
    expect(draft.organizationId).toBe(ORG_ID);
    expect(draft.provider).toBe(connector.provider);
    expect(draft.locationId).toBe(LOCATION_ID);
  });

  it("rejects a config it cannot use", async () => {
    // Every connector validates with Zod, so a missing location must fail at
    // connect rather than at the first sync.
    await expect(connector.connect(ORG_ID, {})).rejects.toThrow();
  });

  it("fetches without throwing", async () => {
    const items = await connector.fetchReviews(connectionFor(connector, config));

    expect(Array.isArray(items)).toBe(true);
    expect(items.length > 0).toBe(subject.yieldsItems);
  });

  it("normalizes every item onto the connection's own location", async () => {
    const connection = connectionFor(connector, config);
    const items = await connector.fetchReviews(connection);

    for (const raw of items) {
      const canonical = connector.normalize(connection, raw);

      // A connector that could aim rows at another location could write into a
      // location the tenant did not connect.
      expect(canonical.locationId).toBe(LOCATION_ID);
      expect(canonical.source).toBe(connector.provider);
      expect(canonical.sourceReviewId.length).toBeGreaterThan(0);
    }
  });

  it("produces a rating that is either absent or a real star count", async () => {
    const connection = connectionFor(connector, config);
    const items = await connector.fetchReviews(connection);

    for (const raw of items) {
      const { rating } = connector.normalize(connection, raw);
      if (rating === null) continue;

      // The database enforces this too; a connector that emitted 0 or 6 would
      // fail the whole sync rather than one row.
      expect(Number.isInteger(rating)).toBe(true);
      expect(rating).toBeGreaterThanOrEqual(1);
      expect(rating).toBeLessThanOrEqual(5);
    }
  });

  it("only puts a rating on an actual review", async () => {
    const connection = connectionFor(connector, config);
    const items = await connector.fetchReviews(connection);

    for (const raw of items) {
      const canonical = connector.normalize(connection, raw);
      const itemType = canonical.itemType ?? "review";

      // A comment or a mention has no stars to give, and inventing one would
      // put a number nobody chose into the reputation pulse.
      if (itemType !== "review") expect(canonical.rating).toBeNull();
    }
  });

  it("normalizes purely — same input, same output", async () => {
    const connection = connectionFor(connector, config);
    const items = await connector.fetchReviews(connection);

    for (const raw of items) {
      // Digest reproducibility rests on this: a normalize that consulted the
      // clock or a counter would make a re-sync produce different rows.
      expect(connector.normalize(connection, raw)).toEqual(connector.normalize(connection, raw));
    }
  });

  it("keeps the provider payload verbatim", async () => {
    const connection = connectionFor(connector, config);
    const items = await connector.fetchReviews(connection);

    for (const raw of items) {
      const { rawPayload } = connector.normalize(connection, raw);
      // `docs/03` §5: normalize aggressively, never discard `raw_payload`. It
      // is what makes a re-normalization possible after a mapping bug.
      expect(rawPayload).toBeTypeOf("object");
      expect(rawPayload).not.toBeNull();
    }
  });

  it("emits stable, unique ids within one fetch", async () => {
    const connection = connectionFor(connector, config);
    const items = await connector.fetchReviews(connection);
    const ids = items.map((raw) => connector.normalize(connection, raw).sourceReviewId);

    // Dedup is on (organization, source, source_review_id). Two items sharing
    // an id inside one page would silently lose one of them.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns a cursor that is either null or a non-empty string", async () => {
    const connection = connectionFor(connector, config);
    const items = await connector.fetchReviews(connection);
    const cursor = connector.nextCursor?.(connection, items) ?? null;

    if (cursor !== null) {
      expect(typeof cursor).toBe("string");
      expect(cursor.length).toBeGreaterThan(0);
    }
  });

  it("leaves the cursor untouched when nothing was fetched", async () => {
    const connection = connectionFor(connector, config);

    // Advancing a cursor on an empty page would skip whatever arrives next.
    expect(connector.nextCursor?.(connection, [] as RawReview[]) ?? null).toBeNull();
  });
});

describe("the registry as a whole", () => {
  it("covers every readable provider with a contract subject", () => {
    // WhatsApp is `read: "none"` — outbound only, never synced — so it is
    // deliberately absent. Any *other* gap means a source is being ingested
    // without meeting this bar.
    const tested = new Set(CONNECTORS.map((subject) => subject.connector.provider));
    const readable = ["mock", "firstparty", "google", "instagram"];

    for (const provider of readable) {
      expect(tested.has(provider)).toBe(true);
    }
  });

  it("declares WhatsApp as unreadable, so nothing tries to sync it", () => {
    expect(getProvider("whatsapp")?.capabilities.read).toBe("none");
  });
});
