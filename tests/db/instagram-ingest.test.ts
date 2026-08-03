import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInstagramClient, INSTAGRAM_PROVIDER } from "@/connectors/instagram/client";
import { createInstagramConnector } from "@/connectors/instagram/connector";
import { registerConnector, unregisterConnector } from "@/connectors/registry";
import { connectSource, syncConnectionWithin, toConnection } from "@/connectors/sync";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { listInbox } from "@/inbox/queries";
import { resetEnvForTesting } from "@/lib/env";
import { withTenant } from "@/lib/tenancy";

/**
 * Instagram items through the real ingest pipeline (P1b-T4).
 *
 * The unit tests cover normalization; this covers what happens once those rows
 * meet the canonical table — dedup, the rating constraint, and whether the
 * Inbox can show a comment beside a review without either looking wrong.
 *
 * Fixture-backed: the connector is constructed with a client whose `fetch`
 * returns recorded Graph payloads, then registered as the real implementation.
 * No network, no Meta credentials.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/instagram/${name}.json`, import.meta.url), "utf8"),
  );
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fixtureConnector() {
  return createInstagramConnector(
    createInstagramClient({
      readToken: async () => "test-token",
      fetchImpl: async (input: string) => {
        if (input.includes("/media")) return response(fixture("media-with-comments"));
        if (input.includes("/tags")) return response(fixture("mentions"));
        return response({ id: "17841400000000000", username: "kahvemolasi" });
      },
    }),
  );
}

async function makeFixture(label: string) {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `IG ${label} ${suffix}`, slug: `ig-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Şubesi` })
    .returning({ id: schema.locations.id });

  const connection = await withTenant({ organizationId: org.id }, (tx) =>
    connectSource(tx, {
      organizationId: org.id,
      provider: INSTAGRAM_PROVIDER,
      config: { locationId: location!.id, accountId: "17841400000000000" },
    }),
  );

  return { orgId: org.id, locationId: location!.id, connectionId: connection.id };
}

async function sync(fixtureData: { orgId: string; connectionId: string }) {
  return withTenant({ organizationId: fixtureData.orgId }, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.id, fixtureData.connectionId));

    return syncConnectionWithin(tx, toConnection(row!), { ignoreSchedule: true });
  });
}

async function rows(orgId: string) {
  return getAdminDb().select().from(schema.reviews).where(eq(schema.reviews.organizationId, orgId));
}

/** A vault key shaped like the real thing, so `resolveMode` accepts it. */
const VAULT_KEY = `k1:${Buffer.alloc(32, 7).toString("base64")}`;

beforeAll(() => {
  // The configuration a live deployment would have. Without all three,
  // `resolveMode` demotes Instagram to `mock` — which is the correct default
  // and would silently make this suite test the mock connector instead.
  process.env.CONNECTOR_INSTAGRAM_MODE = "real";
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  process.env.TOKEN_VAULT_KEYS = VAULT_KEY;
  resetEnvForTesting();

  // Registered as the *real* Instagram connector so the pipeline resolves it
  // exactly as it would in production — the only difference is where `fetch`
  // points.
  registerConnector(fixtureConnector());
});

afterAll(async () => {
  unregisterConnector(INSTAGRAM_PROVIDER);
  delete process.env.CONNECTOR_INSTAGRAM_MODE;
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.TOKEN_VAULT_KEYS;
  resetEnvForTesting();

  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("ingestion", () => {
  it("stores comments and mentions in the canonical table", async () => {
    const target = await makeFixture("ingest");
    const outcome = await sync(target);

    // Two comments (the business's own reply is skipped) and one mention.
    expect(outcome.inserted).toBe(3);

    const stored = await rows(target.orgId);
    expect(stored.filter((row) => row.itemType === "comment")).toHaveLength(2);
    expect(stored.filter((row) => row.itemType === "mention")).toHaveLength(1);
    expect(stored.every((row) => row.source === INSTAGRAM_PROVIDER)).toBe(true);
  });

  it("stores no rating on a social item", async () => {
    const target = await makeFixture("no-rating");
    await sync(target);

    expect((await rows(target.orgId)).every((row) => row.rating === null)).toBe(true);
  });

  it("is refused by the database if a rating is ever attached", async () => {
    const target = await makeFixture("constraint");
    await sync(target);
    const [row] = await rows(target.orgId);

    // The application never does this, which is exactly why the constraint
    // matters: it is the guard against a future connector that does.
    const error = await getAdminDb()
      .update(schema.reviews)
      .set({ rating: 5 })
      .where(eq(schema.reviews.id, row!.id))
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).not.toBeNull();
    // Drizzle wraps the driver error, so the constraint name is on the cause.
    const chain = `${String(error)} ${String((error as { cause?: unknown }).cause)}`;
    expect(chain).toContain("reviews_rating_only_on_reviews");
  });

  it("dedups on a second sync", async () => {
    const target = await makeFixture("dedup");
    await sync(target);
    const second = await sync(target);

    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(3);
    expect(await rows(target.orgId)).toHaveLength(3);
  });

  it("advances the cursor to the newest item", async () => {
    const target = await makeFixture("cursor");
    const outcome = await sync(target);

    expect(outcome.cursor).toBe("2026-07-21T11:30:00+0000");
  });

  it("keeps the item type stable across a re-sync", async () => {
    const target = await makeFixture("type-stable");
    await sync(target);
    await sync(target);

    const stored = await rows(target.orgId);
    // The upsert deliberately omits `item_type`: a row's kind is fixed at
    // ingestion, and a source that changed it mid-life would be a bug.
    expect(stored.filter((row) => row.itemType === "comment")).toHaveLength(2);
  });
});

describe("the Inbox", () => {
  it("shows a comment beside a review", async () => {
    const target = await makeFixture("inbox");
    await sync(target);

    await getAdminDb()
      .insert(schema.reviews)
      .values({
        organizationId: target.orgId,
        locationId: target.locationId,
        source: "mock",
        sourceReviewId: `mock-${suffix}`,
        rating: 5,
        text: "Harika bir deneyimdi.",
        rawPayload: {},
      });

    const page = await withTenant({ organizationId: target.orgId }, (tx) =>
      listInbox(tx, target.orgId, target.locationId, {}),
    );

    // One canonical table means one Inbox. A comment with no stars renders
    // beside a five-star review without either looking broken.
    expect(page.rows).toHaveLength(4);
    expect(page.rows.filter((row) => row.rating === null)).toHaveLength(3);
  });

  it("filters social items by source", async () => {
    const target = await makeFixture("filter");
    await sync(target);

    const page = await withTenant({ organizationId: target.orgId }, (tx) =>
      listInbox(tx, target.orgId, target.locationId, { source: INSTAGRAM_PROVIDER }),
    );

    expect(page.rows).toHaveLength(3);
  });
});

describe("tenant isolation", () => {
  it("never writes another organization's rows", async () => {
    const mine = await makeFixture("iso-mine");
    const theirs = await makeFixture("iso-theirs");

    await sync(mine);

    expect((await rows(mine.orgId)).length).toBe(3);
    expect(await rows(theirs.orgId)).toHaveLength(0);
  });
});
