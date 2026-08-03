import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyGoogleMapping } from "@/connectors/google/mapping";
import { GOOGLE_PROVIDER } from "@/connectors/google/client";
import { googleConfigSchema } from "@/connectors/google/connector";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { closeRateLimiter } from "@/lib/rate-limit";
import { withTenant } from "@/lib/tenancy";

/**
 * Location mapping against the database (P1b-T2).
 *
 * Mapping is what turns an authorized-but-useless connection into a syncable
 * one, and it is the step where picking wrong means syncing another business's
 * reviews into this location's inbox — so the assertions are about exactly what
 * lands on the row.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

type Fixture = { orgId: string; locationId: string; connectionId: string };

async function makeConnection(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `GMap ${label} ${suffix}`, slug: `gmap-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Şubesi` })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  const [connection] = await getAdminDb()
    .insert(schema.connections)
    .values({
      organizationId: org.id,
      locationId: location.id,
      provider: GOOGLE_PROVIDER,
      // What the OAuth callback leaves behind: credentials, no mapping.
      status: "pending",
      capabilities: { read: "full", reply: "api", realtime: false },
      config: {},
    })
    .returning({ id: schema.connections.id });
  if (!connection) throw new Error("connection insert returned nothing");

  return { orgId: org.id, locationId: location.id, connectionId: connection.id };
}

async function readConnection(connectionId: string) {
  const [row] = await getAdminDb()
    .select()
    .from(schema.connections)
    .where(eq(schema.connections.id, connectionId));
  if (!row) throw new Error("connection missing");
  return row;
}

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeRateLimiter();
  await closeDatabasePools();
});

let base: Fixture;

beforeAll(async () => {
  base = await makeConnection("base");
});

describe("applying a mapping", () => {
  it("writes both Google ids and makes the connection syncable", async () => {
    await withTenant({ organizationId: base.orgId }, (tx) =>
      applyGoogleMapping(tx, {
        organizationId: base.orgId,
        connectionId: base.connectionId,
        actorUserId: null,
        accountId: "106321548215487",
        googleLocationId: "12345678901234567890",
        title: "Kahve Dünyası — Kadıköy",
      }),
    );

    const row = await readConnection(base.connectionId);
    expect(row.status).toBe("active");

    // Both ids matter: v4 addresses reviews by account *and* location.
    const config = googleConfigSchema.parse(row.config);
    expect(config).toMatchObject({
      locationId: base.locationId,
      googleAccountId: "106321548215487",
      googleLocationId: "12345678901234567890",
      googleLocationTitle: "Kahve Dünyası — Kadıköy",
    });
  });

  it("records the mapping in the audit trail", async () => {
    const fixture = await makeConnection("audit");

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      applyGoogleMapping(tx, {
        organizationId: fixture.orgId,
        connectionId: fixture.connectionId,
        actorUserId: null,
        accountId: "acc-1",
        googleLocationId: "loc-1",
      }),
    );

    const [audit] = await getAdminDb()
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, fixture.orgId));

    expect(audit?.action).toBe("connection.mapped");
    expect(audit?.meta).toMatchObject({ googleLocationId: "loc-1" });
  });

  it("clears the cursor when a connection is pointed at a different place", async () => {
    const fixture = await makeConnection("remap");

    await getAdminDb()
      .update(schema.connections)
      .set({
        cursor: "2026-07-01T00:00:00.000Z",
        failureCount: 4,
        lastError: "boom",
        nextSyncAt: new Date(Date.now() + 3_600_000),
      })
      .where(eq(schema.connections.id, fixture.connectionId));

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      applyGoogleMapping(tx, {
        organizationId: fixture.orgId,
        connectionId: fixture.connectionId,
        actorUserId: null,
        accountId: "acc-2",
        googleLocationId: "loc-2",
      }),
    );

    const row = await readConnection(fixture.connectionId);
    // A different business has its own history; keeping the old cursor would
    // skip everything older than the last sync of the previous place.
    expect(row.cursor).toBeNull();
    expect(row.failureCount).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.nextSyncAt).toBeNull();
  });

  it("refuses a connection belonging to another organization", async () => {
    const mine = await makeConnection("mine");
    const theirs = await makeConnection("theirs");

    await expect(
      withTenant({ organizationId: mine.orgId }, (tx) =>
        applyGoogleMapping(tx, {
          organizationId: mine.orgId,
          // Another tenant's connection id, under my tenant context.
          connectionId: theirs.connectionId,
          actorUserId: null,
          accountId: "acc",
          googleLocationId: "loc",
        }),
      ),
    ).rejects.toThrow(/does not exist/i);

    // And the other tenant's row is untouched.
    expect((await readConnection(theirs.connectionId)).status).toBe("pending");
  });
});
