import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBenchmark, setCompetitorSource } from "@/competitors/benchmark";
import { createFixtureSource, createNoSource } from "@/competitors/source";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";

/**
 * The benchmark's reads (P3-T6).
 *
 * Two things a database can prove that a pure test cannot:
 *
 *   1. **Tenancy.** A competitor is a row like any other and must never appear
 *      in another organization's benchmark.
 *   2. **Comparability.** Our side of the table is *lifetime*, because a
 *      listing shows a lifetime rating — a windowed average against somebody's
 *      all-time one is the mistake that makes a business think it has overtaken
 *      a rival. That is a property of a query, so it is tested against one.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

type Fixture = { orgId: string; locationId: string };

async function makeOrg(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Comp ${label} ${suffix}`, slug: `comp-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Merkez` })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  await getAdminDb()
    .insert(schema.competitors)
    .values({
      organizationId: org.id,
      name: `${label} rakip`,
      provider: "google",
      externalRef: `ref-${label}-${suffix}`,
    });

  return { orgId: org.id, locationId: location.id };
}

let alpha: Fixture;
let beta: Fixture;

const benchmark = (org: Fixture) =>
  withTenant({ organizationId: org.orgId }, (tx) => loadBenchmark(tx, org.orgId, [org.locationId]));

beforeAll(async () => {
  [alpha, beta] = await Promise.all([makeOrg("alpha"), makeOrg("beta")]);
  setCompetitorSource(createFixtureSource());
});

afterAll(async () => {
  setCompetitorSource(null);
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("the tenancy boundary", () => {
  it("lists this organization's competitors and nobody else's", async () => {
    // Asserted from both sides. Checking only alpha would pass for a query that
    // returned every competitor in the database if beta happened to have none.
    const [ours, theirs] = await Promise.all([benchmark(alpha), benchmark(beta)]);

    expect(ours.rows.map((row) => row.name)).toEqual(["alpha rakip"]);
    expect(theirs.rows.map((row) => row.name)).toEqual(["beta rakip"]);
    expect(JSON.stringify(ours.rows)).not.toContain("beta");
  });
});

describe("what the table says about itself", () => {
  it("marks a fixture-backed benchmark unverified", async () => {
    // The property the notice is driven by. If this ever reads false while the
    // source is a fixture, the UI shows invented numbers with no caveat.
    const result = await benchmark(alpha);

    expect(result.unverified).toBe(true);
    expect(result.sourceName).toBe("fixtures");
    expect(result.rows.every((row) => row.source === "fixtures")).toBe(true);
  });

  it("still lists a competitor whose reading failed, with nulls", async () => {
    // A row that vanished would look like a competitor somebody removed.
    setCompetitorSource(createNoSource());
    const result = await benchmark(alpha);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      theirRating: null,
      theirReviews: null,
      ratingGap: null,
    });

    setCompetitorSource(createFixtureSource());
  });
});

describe("our side of the comparison", () => {
  it("is lifetime, not the selected range", async () => {
    // Two reviews years apart. A windowed query would report one of them; the
    // benchmark must report both, because a listing's rating covers all of it.
    await getAdminDb()
      .insert(schema.reviews)
      .values([
        {
          organizationId: alpha.orgId,
          locationId: alpha.locationId,
          source: "google",
          sourceReviewId: `old-${suffix}`,
          rating: 2,
          postedAt: new Date("2020-01-01T00:00:00Z"),
          rawPayload: {},
        },
        {
          organizationId: alpha.orgId,
          locationId: alpha.locationId,
          source: "google",
          sourceReviewId: `new-${suffix}`,
          rating: 4,
          postedAt: new Date(),
          rawPayload: {},
        },
      ]);

    const result = await benchmark(alpha);

    expect(result.ourReviews).toBe(2);
    expect(result.ourRating).toBe(3);
  });

  it("never counts a direct message toward a public reputation", async () => {
    await getAdminDb()
      .insert(schema.reviews)
      .values({
        organizationId: alpha.orgId,
        locationId: alpha.locationId,
        source: "instagram",
        itemType: "dm",
        sourceReviewId: `dm-${suffix}`,
        // No rating: the database refuses one on a DM
        // (`reviews_rating_only_on_reviews`), which is the constraint saying
        // the same thing this test does.
        postedAt: new Date(),
        rawPayload: {},
      });

    // Still the two rated reviews above — a private message is not part of a
    // reputation anyone can look up.
    expect((await benchmark(alpha)).ourReviews).toBe(2);
  });
});
