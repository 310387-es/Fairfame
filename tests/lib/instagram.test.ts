import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createInstagramClient, INSTAGRAM_PROVIDER } from "@/connectors/instagram/client";
import { createInstagramConnector, itemId } from "@/connectors/instagram/connector";
import { flattenWebhook, webhookSchema } from "@/connectors/instagram/schemas";
import { RateLimitError } from "@/connectors/throttle";
import { ConnectorError, type Connection } from "@/connectors/types";

/**
 * The Instagram connector against recorded Graph payloads (P1b-T4).
 *
 * Fixture-tested only: the permissions come through Meta app review, which
 * needs business verification, which needs the company.
 *
 * The assertions worth having are about *normalization*, because this is the
 * first source whose items are not reviews. A comment that acquired a rating,
 * or one of our own replies ingested as customer feedback, would be wrong in a
 * way no amount of live testing would later reveal — it would just quietly skew
 * the pulse.
 */

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/instagram/${name}.json`, import.meta.url), "utf8"),
  );
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const LOCATION_ID = "11111111-1111-4111-8111-111111111111";

const connection: Connection = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
  locationId: LOCATION_ID,
  provider: INSTAGRAM_PROVIDER,
  status: "active",
  capabilities: { read: "full", reply: "api", realtime: true },
  config: { locationId: LOCATION_ID, accountId: "17841400000000000" },
  encryptedTokens: null,
  cursor: null,
  lastSyncedAt: null,
  firstSyncedAt: null,
  nextSyncAt: null,
  failureCount: 0,
  createdAt: new Date(),
};

/** Routes by URL so one impl can serve both edges. */
function routedClient(overrides: Record<string, () => Response> = {}) {
  const fetchImpl = vi.fn(async (input: string) => {
    for (const [fragment, make] of Object.entries(overrides)) {
      if (input.includes(fragment)) return make();
    }
    if (input.includes("/media")) return response(fixture("media-with-comments"));
    if (input.includes("/tags")) return response(fixture("mentions"));
    if (input.includes("/conversations")) return response(fixture("conversations"));
    return response({ id: "17841400000000000", username: "kahvemolasi" });
  });

  return {
    fetchImpl,
    client: createInstagramClient({ fetchImpl, readToken: async () => "test-token" }),
  };
}

describe("reading", () => {
  it("sends the access token as a bearer header", async () => {
    const { fetchImpl, client } = routedClient();
    await client.getAccount(connection, "17841400000000000");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("access_token=");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
  });

  it("asks for comments nested inside media, in one request", async () => {
    const { fetchImpl, client } = routedClient();
    await client.listComments(connection, "17841400000000000");

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    // Instagram has no account-level comments edge; the field expansion does
    // the join rather than one request per post.
    expect(url).toContain("/media");
    expect(decodeURIComponent(url)).toContain("comments{");
  });

  it("converts `since` to Unix seconds, which is what Graph wants", async () => {
    const { fetchImpl, client } = routedClient();
    await client.listComments(connection, "1784140", new Date("2026-07-20T00:00:00Z"));

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain(`since=${Math.floor(Date.parse("2026-07-20T00:00:00Z") / 1000)}`);
  });

  it("flattens comments out of their media", async () => {
    const { client } = routedClient();
    const comments = await client.listComments(connection, "1784140");

    expect(comments).toHaveLength(3);
    expect(comments[0]?.media?.permalink).toContain("instagram.com");
  });

  it("explains a missing permission as an app-review problem", async () => {
    const { client } = routedClient({
      "/media": () => response(fixture("error-permission"), 403),
    });

    // "Application does not have permission" is unhelpful; what an operator
    // needs to know is that app review has not granted it.
    await expect(client.listComments(connection, "1784140")).rejects.toThrow(/app review/);
  });

  it("explains an expired token as a reconnect", async () => {
    const { client } = routedClient({
      "/media": () => response(fixture("error-token"), 401),
    });

    await expect(client.listComments(connection, "1784140")).rejects.toThrow(/reconnect/);
  });

  it("raises a rate limit as the shared throttle error", async () => {
    const { client } = routedClient({
      "/media": () => response({ error: { code: 4, message: "too many calls" } }, 400),
    });

    await expect(client.listComments(connection, "1784140")).rejects.toThrow(RateLimitError);
  });

  it("treats a permission failure as permanent, not retryable", async () => {
    const { client } = routedClient({
      "/media": () => response(fixture("error-permission"), 403),
    });

    const error = await client.listComments(connection, "1784140").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).retryable).toBe(false);
  });
});

describe("normalization", () => {
  async function normalized() {
    const { client } = routedClient();
    const connector = createInstagramConnector(client);
    const raw = await connector.fetchReviews(connection);
    return raw.map((item) => connector.normalize(connection, item));
  }

  it("tags comments, mentions and messages by type", async () => {
    const items = await normalized();

    expect(items.filter((item) => item.itemType === "comment")).toHaveLength(2);
    expect(items.filter((item) => item.itemType === "mention")).toHaveLength(1);
    // Three inbound messages across two threads; the fourth in the fixture is
    // the business's own reply and must not appear.
    expect(items.filter((item) => item.itemType === "dm")).toHaveLength(3);
  });

  it("keeps a direct message private — no permalink to point a colleague at", async () => {
    const items = await normalized();
    const dm = items.find((item) => item.itemType === "dm");

    // A comment and a mention are public and the author published them. A DM
    // was sent to the business alone, and there is no page to open.
    expect(dm?.url).toBeNull();
    expect(dm?.authorName).toBe("ayse.k");
    expect(dm?.postedAt).toBeInstanceOf(Date);
  });

  it("ingests an attachment-only message as having no text, not as absent", async () => {
    const items = await normalized();

    // Meta omits `message` when the customer sent only a photo or a reel. The
    // item still happened, and dropping it would leave a gap in the thread.
    const textless = items.filter((item) => item.itemType === "dm" && item.text === null);
    expect(textless).toHaveLength(1);
  });

  it("never invents a rating", async () => {
    const items = await normalized();

    // A comment has no stars. Mapping enthusiasm to a rating would put a number
    // nobody gave into the reputation pulse — and the database refuses it too.
    expect(items.every((item) => item.rating === null)).toBe(true);
  });

  it("skips the business's own replies", async () => {
    const items = await normalized();

    // The fixture contains "Teşekkür ederiz, tekrar bekleriz!" as a reply from
    // the business. Ingesting it would have the product analysing its own words
    // as customer feedback.
    expect(items.some((item) => item.text?.includes("tekrar bekleriz"))).toBe(false);
  });

  it("keeps comment, mention and message ids in separate namespaces", async () => {
    const items = await normalized();

    // All three are opaque Meta strings and could collide; the dedup key in
    // `reviews` must stay unambiguous.
    expect(items.every((item) => /^(comment|mention|dm):/.test(item.sourceReviewId))).toBe(true);
    expect(itemId("comment", "1")).not.toBe(itemId("mention", "1"));
    expect(itemId("dm", "1")).not.toBe(itemId("comment", "1"));
  });

  it("carries the author, the text, the time and a link", async () => {
    const items = await normalized();
    const comment = items.find((item) => item.itemType === "comment");

    expect(comment?.authorName).toBe("ayse_k");
    expect(comment?.text).toContain("Kahvaltı");
    expect(comment?.postedAt?.toISOString()).toBe("2026-07-21T10:02:11.000Z");
    expect(comment?.url).toContain("instagram.com");
  });

  it("reads a mention's caption as its text", async () => {
    const items = await normalized();
    const mention = items.find((item) => item.itemType === "mention");

    expect(mention?.text).toContain("@kahvemolasi");
    expect(mention?.authorName).toBe("gezginkahveci");
  });

  it("keeps the raw payload verbatim", async () => {
    const items = await normalized();
    expect(items[0]?.rawPayload).toMatchObject({ id: expect.any(String) });
  });

  it("aims every item at the connection's own location", async () => {
    const items = await normalized();
    // The sync pipeline rejects a connector that produces rows for another
    // location; this is the connector's half of that contract.
    expect(items.every((item) => item.locationId === connection.locationId)).toBe(true);
  });
});

describe("replying", () => {
  it("posts a reply to a comment", async () => {
    const fetchImpl = vi.fn(async () => response({ id: "17870913511019999" }));
    const connector = createInstagramConnector(
      createInstagramClient({ fetchImpl, readToken: async () => "t" }),
    );

    const result = await connector.postReply!(
      connection,
      itemId("comment", "17870913511019625"),
      "Teşekkürler!",
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/17870913511019625/replies");
    expect(init.method).toBe("POST");
    expect(result).toMatchObject({ ok: true, externalId: "17870913511019999" });
  });

  it("refuses to reply to a mention", async () => {
    const connector = createInstagramConnector(
      createInstagramClient({ fetchImpl: async () => response({}), readToken: async () => "t" }),
    );

    // Instagram offers no such endpoint — the business does not own the post.
    const result = await connector.postReply!(connection, itemId("mention", "179123"), "hi");

    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok === false && result.reason).toMatch(/only allows replying to comments/);
  });

  it("refuses a direct message for the right reason, not the mention one", async () => {
    const connector = createInstagramConnector(
      createInstagramClient({ fetchImpl: async () => response({}), readToken: async () => "t" }),
    );

    const result = await connector.postReply!(connection, itemId("dm", "mid.000000000000A"), "hi");

    expect(result).toMatchObject({ ok: false, retryable: false });
    // Not "only comments on your own posts" — that would describe a platform
    // limitation. Answering a DM is a send we have not built: it needs the
    // send gate, Meta's 24-hour window and a separate scope.
    expect(result.ok === false && result.reason).toMatch(/not built yet/);
  });

  it("reports a rejected reply rather than throwing", async () => {
    const connector = createInstagramConnector(
      createInstagramClient({
        fetchImpl: async () => response(fixture("error-permission"), 403),
        readToken: async () => "t",
      }),
    );

    const result = await connector.postReply!(connection, itemId("comment", "1"), "hi");
    expect(result.ok).toBe(false);
  });
});

describe("cursors", () => {
  it("advances to the newest item seen", async () => {
    const { client } = routedClient();
    const connector = createInstagramConnector(client);
    const raw = await connector.fetchReviews(connection);

    // Dedup makes an overlapping window harmless, so erring towards re-reading
    // is the safer direction.
    expect(connector.nextCursor?.(connection, raw)).toBe("2026-07-21T11:30:00+0000");
  });

  it("leaves the cursor alone when nothing came back", async () => {
    const { client } = routedClient({
      "/media": () => response({ data: [] }),
      "/tags": () => response({ data: [] }),
    });

    const connector = createInstagramConnector(client);
    expect(connector.nextCursor?.(connection, [])).toBeNull();
  });
});

describe("webhooks", () => {
  it("flattens a change event into a signal", () => {
    const signals = flattenWebhook(webhookSchema.parse(fixture("webhook-comment")));

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ accountId: "17841400000000000", field: "comments" });
  });

  it("tolerates an entry with no changes", () => {
    const payload = { object: "instagram", entry: [{ id: "1", time: 1 }] };
    expect(flattenWebhook(webhookSchema.parse(payload))).toEqual([]);
  });

  it("accepts fields Meta adds later", () => {
    const payload = fixture("webhook-comment") as Record<string, unknown>;
    payload.new_field = "added in v22";

    expect(() => webhookSchema.parse(payload)).not.toThrow();
  });
});
