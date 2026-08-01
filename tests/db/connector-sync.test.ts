import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listReviewsForLocation } from "@/connectors/normalize";
import { connectSource, syncConnection, toConnection } from "@/connectors/sync";
import { ConnectorError } from "@/connectors/types";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";

/**
 * The T7 vertical slice at the database boundary: connecting the mock source
 * ingests reviews into the canonical table, tenant-scoped and deduped.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

async function makeOrgWithLocation(label: string): Promise<{ orgId: string; locationId: string }> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Sync ${label} ${suffix}`, slug: `sync-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Şubesi` })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  return { orgId: org.id, locationId: location.id };
}

async function connectMock(
  orgId: string,
  locationId: string,
  config: Record<string, unknown> = {},
): Promise<string> {
  const row = await withTenant({ organizationId: orgId }, (tx) =>
    connectSource(tx, {
      organizationId: orgId,
      provider: "mock",
      config: { locationId, backfillCount: 30, ...config },
    }),
  );
  return row.id;
}

let a: { orgId: string; locationId: string };
let b: { orgId: string; locationId: string };

beforeAll(async () => {
  a = await makeOrgWithLocation("a");
  b = await makeOrgWithLocation("b");
});

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("connecting the mock source", () => {
  it("persists a connection with the connector's capabilities", async () => {
    const connectionId = await connectMock(a.orgId, a.locationId);

    const [row] = await getAdminDb()
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.id, connectionId));

    expect(row?.provider).toBe("mock");
    expect(row?.status).toBe("active");
    expect(row?.capabilities).toEqual({ read: "full", reply: "api", realtime: false });
    expect(row?.locationId).toBe(a.locationId);
    // The mock has no credentials; nothing should be invented.
    expect(row?.encryptedTokens).toBeNull();
  });

  it("re-connecting the same source updates rather than duplicating", async () => {
    const first = await connectMock(a.orgId, a.locationId);
    const second = await connectMock(a.orgId, a.locationId);

    expect(second).toBe(first);

    const rows = await getAdminDb()
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(eq(schema.connections.locationId, a.locationId));
    expect(rows).toHaveLength(1);
  });

  it("refuses an unknown provider", async () => {
    await expect(
      withTenant({ organizationId: a.orgId }, (tx) =>
        connectSource(tx, {
          organizationId: a.orgId,
          provider: "google",
          config: { locationId: a.locationId },
        }),
      ),
    ).rejects.toThrow(ConnectorError);
  });
});

describe("syncing", () => {
  it("ingests reviews into the canonical table", async () => {
    const connectionId = await connectMock(a.orgId, a.locationId);
    const outcome = await syncConnection(a.orgId, connectionId);

    expect(outcome.fetched).toBe(30);
    expect(outcome.inserted).toBe(30);
    expect(outcome.updated).toBe(0);

    const reviews = await withTenant({ organizationId: a.orgId }, (tx) =>
      listReviewsForLocation(tx, a.orgId, a.locationId, 100),
    );

    expect(reviews).toHaveLength(30);

    const first = reviews[0];
    expect(first?.source).toBe("mock");
    expect(first?.organizationId).toBe(a.orgId);
    expect(first?.authorName).toBeTruthy();
    expect(first?.rating).toBeGreaterThanOrEqual(1);
    expect(first?.rawPayload).toBeTruthy();
  });

  it("returns reviews newest first, which is what the Inbox shows", async () => {
    const reviews = await withTenant({ organizationId: a.orgId }, (tx) =>
      listReviewsForLocation(tx, a.orgId, a.locationId, 100),
    );

    const times = reviews.map((review) => review.postedAt?.getTime() ?? 0);
    const sorted = [...times].sort((x, y) => y - x);
    expect(times).toEqual(sorted);
  });

  it("stores both Turkish and English reviews", async () => {
    const reviews = await withTenant({ organizationId: a.orgId }, (tx) =>
      listReviewsForLocation(tx, a.orgId, a.locationId, 100),
    );

    const languages = new Set(reviews.map((review) => review.language));
    expect(languages).toContain("tr");
    expect(languages).toContain("en");
  });

  it("dedupes on re-sync instead of duplicating rows", async () => {
    const connectionId = await connectMock(a.orgId, a.locationId);

    // A full re-pull: same corpus, same ids.
    const outcome = await syncConnection(a.orgId, connectionId, { full: true });

    expect(outcome.inserted).toBe(0);
    expect(outcome.updated).toBe(30);

    const reviews = await withTenant({ organizationId: a.orgId }, (tx) =>
      listReviewsForLocation(tx, a.orgId, a.locationId, 100),
    );
    expect(reviews).toHaveLength(30);
  });

  it("advances the cursor so the next sync is incremental", async () => {
    const connectionId = await connectMock(a.orgId, a.locationId);
    await syncConnection(a.orgId, connectionId, { full: true });

    const [row] = await getAdminDb()
      .select({ cursor: schema.connections.cursor })
      .from(schema.connections)
      .where(eq(schema.connections.id, connectionId));

    expect(row?.cursor).toBeTruthy();
    expect(Number.isNaN(Date.parse(row!.cursor!))).toBe(false);

    // With the cursor set, an incremental run finds nothing new.
    const incremental = await syncConnection(a.orgId, connectionId);
    expect(incremental.fetched).toBe(0);
    expect(incremental.inserted).toBe(0);
  });
});

describe("tenant isolation of ingested reviews", () => {
  it("keeps one organization's reviews invisible to another", async () => {
    const connectionB = await connectMock(b.orgId, b.locationId);
    await syncConnection(b.orgId, connectionB);

    const seenByB = await withTenant({ organizationId: b.orgId }, (tx) =>
      tx.select().from(schema.reviews),
    );

    expect(seenByB.length).toBeGreaterThan(0);
    expect(seenByB.every((review) => review.organizationId === b.orgId)).toBe(true);
    expect(seenByB.some((review) => review.locationId === a.locationId)).toBe(false);
  });

  it("lets two organizations hold the same source_review_id independently", async () => {
    // The build plan specified unique(source, source_review_id) globally, which
    // would make this collide: the second tenant's ingest would fail and leak
    // the existence of the first tenant's row. The key is scoped per
    // organization instead, so both tenants keep their own copy.
    const sharedId = `mock_shared_${suffix}`;

    for (const org of [a, b]) {
      await withTenant({ organizationId: org.orgId }, (tx) =>
        tx.insert(schema.reviews).values({
          organizationId: org.orgId,
          locationId: org.locationId,
          source: "google",
          sourceReviewId: sharedId,
          rating: 5,
          text: "The same public review, seen by two tenants.",
          rawPayload: {},
        }),
      );
    }

    const rows = await getAdminDb()
      .select({ organizationId: schema.reviews.organizationId })
      .from(schema.reviews)
      .where(eq(schema.reviews.sourceReviewId, sharedId));

    expect(rows).toHaveLength(2);
  });
});

describe("failure handling", () => {
  it("marks the connection as errored and rethrows", async () => {
    const target = await makeOrgWithLocation("err");
    const connectionId = await connectMock(target.orgId, target.locationId, {
      simulate: { failFetch: true, retryable: true },
    });

    await expect(syncConnection(target.orgId, connectionId)).rejects.toThrow(ConnectorError);

    const [row] = await getAdminDb()
      .select({ status: schema.connections.status })
      .from(schema.connections)
      .where(eq(schema.connections.id, connectionId));

    expect(row?.status).toBe("error");
  });

  it("recovers to active once the source works again", async () => {
    const target = await makeOrgWithLocation("recover");
    const connectionId = await connectMock(target.orgId, target.locationId, {
      simulate: { failFetch: true, retryable: true },
    });

    await expect(syncConnection(target.orgId, connectionId)).rejects.toThrow();

    // Clear the simulated failure, as re-connecting with fixed config would.
    await connectMock(target.orgId, target.locationId, {
      simulate: { failFetch: false, retryable: true },
    });
    const outcome = await syncConnection(target.orgId, connectionId, { full: true });

    expect(outcome.inserted).toBeGreaterThan(0);

    const [row] = await getAdminDb()
      .select({ status: schema.connections.status })
      .from(schema.connections)
      .where(eq(schema.connections.id, connectionId));
    expect(row?.status).toBe("active");
  });

  it("refuses to sync a connection belonging to another organization", async () => {
    const connectionId = await connectMock(a.orgId, a.locationId);

    // Org B naming org A's connection id sees nothing — RLS hides the row.
    await expect(syncConnection(b.orgId, connectionId)).rejects.toThrow(/not found/i);
  });
});

describe("toConnection()", () => {
  it("falls back to the connector's capabilities when the stored snapshot is junk", async () => {
    const connectionId = await connectMock(a.orgId, a.locationId);
    await getAdminDb()
      .update(schema.connections)
      .set({ capabilities: { nonsense: true } })
      .where(eq(schema.connections.id, connectionId));

    const [row] = await getAdminDb()
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.id, connectionId));

    expect(toConnection(row!).capabilities).toEqual({
      read: "full",
      reply: "api",
      realtime: false,
    });

    // Restore, so later tests see a sane row.
    await connectMock(a.orgId, a.locationId);
  });
});
