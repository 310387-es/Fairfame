import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, getAppDb, schema } from "@/db/client";
import { readTenantContext, TenantContextError, withTenant } from "@/lib/tenancy";

/**
 * Tenant isolation is the product's single non-negotiable invariant, so these
 * tests assert it at the database boundary rather than trusting application
 * query hygiene.
 *
 * Fixtures are created through `adminDb` (the owner connection, which is not
 * subject to RLS) precisely so that the assertions through `appDb` are testing
 * the policies rather than testing whether the insert happened.
 */

type Fixture = { orgId: string; locationId: string; reviewId: string };

/**
 * Drizzle wraps driver errors, so the Postgres message and SQLSTATE live on
 * `cause`. Unwrap to the root so assertions test the database's verdict rather
 * than Drizzle's wrapper text.
 */
async function captureDbError(run: () => Promise<unknown>): Promise<{
  code: string | undefined;
  message: string;
}> {
  try {
    await run();
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error && current.cause instanceof Error) {
      current = current.cause;
    }
    const root = current as Error & { code?: string };
    return { code: root.code, message: root.message };
  }

  throw new Error("expected the query to be rejected, but it succeeded");
}

/** SQLSTATE 42501 — insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = "42501";

async function createOrg(name: string, slug: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name, slug })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("fixture organization insert returned nothing");

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${name} — Merkez` })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("fixture location insert returned nothing");

  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: org.id,
      locationId: location.id,
      source: "mock",
      sourceReviewId: `seed-${slug}`,
      authorName: "Fixture Author",
      rating: 5,
      text: `A review belonging to ${name}`,
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });
  if (!review) throw new Error("fixture review insert returned nothing");

  return { orgId: org.id, locationId: location.id, reviewId: review.id };
}

let orgA: Fixture;
let orgB: Fixture;
const suffix = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  orgA = await createOrg("Org A", `rls-a-${suffix}`);
  orgB = await createOrg("Org B", `rls-b-${suffix}`);
});

afterAll(async () => {
  // Cascades remove locations and reviews.
  await getAdminDb()
    .delete(schema.organizations)
    .where(inArray(schema.organizations.id, [orgA.orgId, orgB.orgId]));
  await closeDatabasePools();
});

describe("the runtime role", () => {
  it("is not a superuser and cannot bypass RLS", async () => {
    const result = await getAppDb().execute<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      current_user: string;
    }>(sql`select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user`);

    const row = result.rows[0];
    expect(row).toBeDefined();
    // If either of these were true, every policy below would be decoration.
    expect(row?.rolsuper).toBe(false);
    expect(row?.rolbypassrls).toBe(false);
  });
});

describe("without tenant context", () => {
  it("reads no reviews at all, despite rows existing", async () => {
    const rows = await getAppDb().select().from(schema.reviews);
    expect(rows).toHaveLength(0);
  });

  it("reads no locations and no organizations", async () => {
    expect(await getAppDb().select().from(schema.locations)).toHaveLength(0);
    expect(await getAppDb().select().from(schema.organizations)).toHaveLength(0);
  });

  it("cannot reach a specific row even when its id is known", async () => {
    const rows = await getAppDb()
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, orgA.reviewId));

    expect(rows).toHaveLength(0);
  });

  it("still sees the global plans catalog, which is not tenant data", async () => {
    const plans = await getAppDb().select().from(schema.plans);
    expect(plans.length).toBeGreaterThan(0);
  });
});

describe("with tenant context", () => {
  it("exposes the context to Postgres", async () => {
    const context = await withTenant({ organizationId: orgA.orgId }, (tx) => readTenantContext(tx));
    expect(context.organizationId).toBe(orgA.orgId);
  });

  it("reads its own review", async () => {
    const rows = await withTenant({ organizationId: orgA.orgId }, (tx) =>
      tx.select().from(schema.reviews),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(orgA.reviewId);
  });

  it("cannot read another organization's reviews — the core invariant", async () => {
    const rows = await withTenant({ organizationId: orgB.orgId }, (tx) =>
      tx.select().from(schema.reviews).where(eq(schema.reviews.id, orgA.reviewId)),
    );

    expect(rows).toHaveLength(0);
  });

  it("cannot read another organization's locations", async () => {
    const rows = await withTenant({ organizationId: orgB.orgId }, (tx) =>
      tx.select().from(schema.locations),
    );

    expect(rows.every((row) => row.organizationId === orgB.orgId)).toBe(true);
    expect(rows.some((row) => row.id === orgA.locationId)).toBe(false);
  });

  it("cannot update another organization's review", async () => {
    const updated = await withTenant({ organizationId: orgB.orgId }, (tx) =>
      tx
        .update(schema.reviews)
        .set({ text: "tampered" })
        .where(eq(schema.reviews.id, orgA.reviewId))
        .returning({ id: schema.reviews.id }),
    );
    expect(updated).toHaveLength(0);

    // Confirm through the unrestricted connection that nothing changed.
    const [row] = await getAdminDb()
      .select({ text: schema.reviews.text })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, orgA.reviewId));
    expect(row?.text).not.toBe("tampered");
  });

  it("cannot delete another organization's review", async () => {
    await withTenant({ organizationId: orgB.orgId }, (tx) =>
      tx.delete(schema.reviews).where(eq(schema.reviews.id, orgA.reviewId)),
    );

    const [row] = await getAdminDb()
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, orgA.reviewId));
    expect(row?.id).toBe(orgA.reviewId);
  });

  it("cannot forge a row into another organization", async () => {
    // WITH CHECK must reject an insert whose organization_id is not the context.
    const error = await captureDbError(() =>
      withTenant({ organizationId: orgB.orgId }, (tx) =>
        tx.insert(schema.locations).values({
          organizationId: orgA.orgId,
          name: "Smuggled location",
        }),
      ),
    );

    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(error.message).toMatch(/row-level security/i);

    // And nothing landed.
    const [smuggled] = await getAdminDb()
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(eq(schema.locations.name, "Smuggled location"));
    expect(smuggled).toBeUndefined();
  });

  it("permits an insert into its own organization", async () => {
    const inserted = await withTenant({ organizationId: orgB.orgId }, (tx) =>
      tx
        .insert(schema.locations)
        .values({ organizationId: orgB.orgId, name: "Legitimate location" })
        .returning({ id: schema.locations.id }),
    );

    expect(inserted).toHaveLength(1);
  });

  it("cannot write to the global plans catalog", async () => {
    const error = await captureDbError(() =>
      withTenant({ organizationId: orgA.orgId }, (tx) =>
        tx.update(schema.plans).set({ priceMonth: 1 }),
      ),
    );

    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(error.message).toMatch(/permission denied/i);
  });
});

describe("context lifetime", () => {
  it("does not leak to later queries on the pooled connection", async () => {
    await withTenant({ organizationId: orgA.orgId }, async (tx) => {
      const rows = await tx.select().from(schema.reviews);
      expect(rows).toHaveLength(1);
    });

    // Same pool, no context: the GUC was transaction-local and is gone.
    const afterwards = await getAppDb().select().from(schema.reviews);
    expect(afterwards).toHaveLength(0);
  });

  it("does not leak out of a rolled-back transaction", async () => {
    await expect(
      withTenant({ organizationId: orgA.orgId }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const afterwards = await getAppDb().select().from(schema.reviews);
    expect(afterwards).toHaveLength(0);
  });

  it("rejects a malformed organization id before it reaches a policy", async () => {
    await expect(
      withTenant({ organizationId: "not-a-uuid" }, async (tx) => tx.select().from(schema.reviews)),
    ).rejects.toThrow(TenantContextError);
  });
});

describe("auth internals", () => {
  // Migration 0003 revokes these from the runtime role entirely: the app talks
  // to BetterAuth, which uses the owner connection, so a bug in application
  // code must not be able to read a password hash or mint a session.
  it.each(["accounts", "sessions", "verifications"])(
    "are unreadable by the runtime role (%s)",
    async (table) => {
      const error = await captureDbError(() =>
        getAppDb().execute(sql.raw(`select 1 from public.${table} limit 1`)),
      );

      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
      expect(error.message).toMatch(/permission denied/i);
    },
  );

  it("keeps invitations tenant-scoped like any other organization data", async () => {
    const rows = await getAppDb().select().from(schema.invitations);
    expect(rows).toHaveLength(0);
  });
});

describe("the owner connection", () => {
  it("still sees every organization's data, which is why it must not serve requests", async () => {
    const rows = await getAdminDb()
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(inArray(schema.reviews.id, [orgA.reviewId, orgB.reviewId]));

    expect(rows).toHaveLength(2);
  });
});
