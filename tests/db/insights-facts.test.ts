import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rangeWindow } from "@/dashboard/range";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { loadInsightFacts } from "@/analytics/facts";
import { withTenant } from "@/lib/tenancy";

/**
 * What the Insights page is allowed to read (P3-T4).
 *
 * The arithmetic is tested in `tests/lib/insights-trends.test.ts`, where facts
 * can be written by hand. What needs a database is the boundary: this page
 * reads across *every* location rather than the active one, which makes it the
 * first screen where a member's location scope is the only thing standing
 * between them and the rest of the chain's numbers.
 *
 * Three properties, each of which would be a real leak:
 *   1. Only this organization's reviews (RLS, belt and braces).
 *   2. Only the locations the caller was given — and **no locations means no
 *      data**, not "no filter", which is the failure mode that reads as
 *      working perfectly for an unscoped admin.
 *   3. No direct messages. Private correspondence is inbox work and is not
 *      evidence about a branch's reputation.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

type Fixture = { orgId: string; mainId: string; otherId: string };

async function makeOrg(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Ins ${label} ${suffix}`, slug: `ins-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const locations = await getAdminDb()
    .insert(schema.locations)
    .values([
      { organizationId: org.id, name: `${label} Merkez` },
      { organizationId: org.id, name: `${label} Havalimanı` },
    ])
    .returning({ id: schema.locations.id });

  const [main, other] = locations as [{ id: string }, { id: string }];

  await getAdminDb()
    .insert(schema.reviews)
    .values([
      {
        organizationId: org.id,
        locationId: main.id,
        source: "google",
        sourceReviewId: `${label}-main`,
        rating: 5,
        text: `A review at ${label} main`,
        postedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000),
        rawPayload: {},
      },
      {
        organizationId: org.id,
        locationId: other.id,
        source: "google",
        sourceReviewId: `${label}-other`,
        rating: 1,
        text: `A review at ${label} other`,
        postedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000),
        rawPayload: {},
      },
      {
        organizationId: org.id,
        locationId: main.id,
        source: "instagram",
        itemType: "dm",
        sourceReviewId: `${label}-dm`,
        text: `A private message at ${label}`,
        postedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000),
        rawPayload: {},
      },
    ]);

  return { orgId: org.id, mainId: main.id, otherId: other.id };
}

let alpha: Fixture;
let beta: Fixture;

const window = rangeWindow("30d", new Date());
const load = (org: Fixture, locationIds: string[]) =>
  withTenant({ organizationId: org.orgId }, (tx) =>
    loadInsightFacts(tx, org.orgId, locationIds, window, "analyze_review@2"),
  );

beforeAll(async () => {
  [alpha, beta] = await Promise.all([makeOrg("alpha"), makeOrg("beta")]);
});

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("what it reads", () => {
  it("covers every location it was given, which is the point of the page", async () => {
    const { current } = await load(alpha, [alpha.mainId, alpha.otherId]);

    expect(current.map((fact) => fact.locationId).sort()).toEqual(
      [alpha.mainId, alpha.otherId].sort(),
    );
  });

  it("reads nothing of another organization's, by id or by content", async () => {
    const { current } = await load(alpha, [alpha.mainId, alpha.otherId]);
    const serialized = JSON.stringify(current);

    expect(serialized).not.toContain(beta.mainId);
    expect(serialized).not.toContain("beta");
  });
});

describe("the location scope", () => {
  it("returns only the branch a scoped member may see", async () => {
    // A manager limited to one branch opening a page that reads across all of
    // them is the specific leak this parameter exists to prevent.
    const { current } = await load(alpha, [alpha.mainId]);

    expect(current).toHaveLength(1);
    expect(current[0]!.locationId).toBe(alpha.mainId);
  });

  it("treats an empty scope as no data, never as no filter", async () => {
    // The dangerous default. An unscoped list that fell through to "all
    // locations" would look correct for every admin and wrong for exactly the
    // member it was meant to restrict.
    const { current, previous } = await load(alpha, []);

    expect(current).toEqual([]);
    expect(previous).toEqual([]);
  });
});

describe("what it leaves out", () => {
  it("never counts a direct message", async () => {
    const { current } = await load(alpha, [alpha.mainId, alpha.otherId]);

    expect(JSON.stringify(current)).not.toContain("private message");
  });

  it("marks a review analysed under an older prompt as not read for names", async () => {
    // The flag the staff panel needs to tell "nobody was named" apart from "we
    // have not looked". These fixtures have no insight rows at all, which is
    // the same case from the page's point of view.
    const { current } = await load(alpha, [alpha.mainId]);

    expect(current[0]!.staffAnalysed).toBe(false);
    expect(current[0]!.staff).toEqual([]);
  });
});
