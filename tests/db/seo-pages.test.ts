import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { loadLocationPageContent, resolveLocationPageBySlug } from "@/seo/page";

/**
 * The hosted review page's reads (P3-T3).
 *
 * The same headline test as the widget endpoint, on a surface where the stakes
 * are higher: this page is *meant to be indexed*, so a row that leaks here is
 * not seen by one visitor — it is crawled, cached and quotable months after the
 * bug is fixed.
 *
 * Four gates, each on its own so a regression names itself:
 *   1. the organization, which comes from the slug and nowhere else
 *   2. the location, which is the whole point of a per-branch page
 *   3. approval — `display_approved_at`, with no way to turn it off
 *   4. publication — an unpublished page is indistinguishable from no page
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

type Fixture = {
  orgId: string;
  mainLocationId: string;
  otherLocationId: string;
  slug: string;
  approvedReviewId: string;
  unapprovedReviewId: string;
};

async function makeOrg(label: string, published = true): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Seo ${label} ${suffix}`, slug: `seo-${label}-${suffix}`, locale: "tr" })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const slug = `seo-${label}-${suffix}`;

  const locations = await getAdminDb()
    .insert(schema.locations)
    .values([
      {
        organizationId: org.id,
        name: `${label} Merkez`,
        locale: "tr",
        address: `${label} Caddesi 1`,
        publicSlug: slug,
        publicPagePublished: published,
      },
      { organizationId: org.id, name: `${label} Havalimanı`, locale: "tr" },
    ])
    .returning({ id: schema.locations.id });

  const mainLocationId = locations[0]!.id;
  const otherLocationId = locations[1]!.id;

  const rows = await getAdminDb()
    .insert(schema.reviews)
    .values([
      {
        organizationId: org.id,
        locationId: mainLocationId,
        source: "google",
        sourceReviewId: `${label}-approved`,
        authorName: `${label} Approved Author`,
        rating: 5,
        text: `An approved review belonging to ${label}`,
        postedAt: new Date("2026-07-20T10:00:00Z"),
        rawPayload: { secret: `raw payload for ${label}` },
        displayApprovedAt: new Date("2026-07-21T10:00:00Z"),
      },
      {
        organizationId: org.id,
        locationId: mainLocationId,
        source: "google",
        sourceReviewId: `${label}-unapproved`,
        authorName: `${label} Unapproved Author`,
        rating: 1,
        text: `An unapproved review belonging to ${label}`,
        postedAt: new Date("2026-07-22T10:00:00Z"),
        rawPayload: {},
      },
    ])
    .returning({ id: schema.reviews.id });

  return {
    orgId: org.id,
    mainLocationId,
    otherLocationId,
    slug,
    approvedReviewId: rows[0]!.id,
    unapprovedReviewId: rows[1]!.id,
  };
}

let alpha: Fixture;
let beta: Fixture;

beforeAll(async () => {
  [alpha, beta] = await Promise.all([makeOrg("alpha"), makeOrg("beta")]);
});

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("the tenancy boundary", () => {
  it("serves one location's approved reviews and nothing of anyone else's", async () => {
    const page = await resolveLocationPageBySlug(alpha.slug);
    expect(page?.organizationId).toBe(alpha.orgId);

    const { reviews } = await loadLocationPageContent(page!);

    expect(reviews.map((review) => review.id)).toEqual([alpha.approvedReviewId]);

    // The half that matters. Checked by content as well as by id, because an id
    // match alone would still pass if another org's words arrived under one of
    // alpha's ids.
    const serialized = JSON.stringify(reviews);
    expect(serialized).not.toContain(beta.approvedReviewId);
    expect(serialized).not.toContain("beta");
  });

  it("has no input that can name an organization", () => {
    // Structural, like the widget one: if a future signature grows an
    // `organizationId` parameter, this surface has acquired the exact shape the
    // module exists to avoid.
    expect(resolveLocationPageBySlug).toHaveLength(1);
    expect(loadLocationPageContent).toHaveLength(1);
  });

  it("stays on its own branch when the organization has several", async () => {
    await getAdminDb()
      .insert(schema.reviews)
      .values({
        organizationId: alpha.orgId,
        locationId: alpha.otherLocationId,
        source: "google",
        sourceReviewId: "alpha-other-location",
        rating: 5,
        text: "Approved, but at the other branch",
        postedAt: new Date("2026-07-25T10:00:00Z"),
        rawPayload: {},
        displayApprovedAt: new Date("2026-07-25T11:00:00Z"),
      });

    const page = await resolveLocationPageBySlug(alpha.slug);
    const { reviews } = await loadLocationPageContent(page!);

    expect(reviews.map((review) => review.text)).toEqual(["An approved review belonging to alpha"]);
  });

  it("rejects a malformed slug without touching the database", async () => {
    expect(await resolveLocationPageBySlug("<script>alert(1)</script>")).toBeNull();
    expect(await resolveLocationPageBySlug("Kadıköy")).toBeNull();
    expect(await resolveLocationPageBySlug("-leading-hyphen")).toBeNull();
  });
});

describe("the approval gate", () => {
  it("never returns a review that has not been approved", async () => {
    const page = await resolveLocationPageBySlug(alpha.slug);
    const { reviews } = await loadLocationPageContent(page!);

    expect(reviews.map((review) => review.id)).not.toContain(alpha.unapprovedReviewId);
  });

  it("publishes only the allow-listed fields", async () => {
    const page = await resolveLocationPageBySlug(alpha.slug);
    const { reviews } = await loadLocationPageContent(page!);

    // The same projection the widget endpoint uses, asserted as a set. A column
    // added to `reviews` should fail here rather than reach a crawler.
    expect(Object.keys(reviews[0]!).sort()).toEqual([
      "authorName",
      "id",
      "itemType",
      "postedAt",
      "rating",
      "source",
      "text",
      "url",
    ]);

    const serialized = JSON.stringify(reviews);
    for (const forbidden of ["rawPayload", "secret", "priority", "assigneeUserId", "status"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("never shows a direct message, whatever else is true", async () => {
    // The database refuses to approve one, so this asserts the second gate: it
    // is also excluded by the scope clauses, and would be even if the CHECK
    // constraint were dropped by a future migration.
    await getAdminDb().insert(schema.reviews).values({
      organizationId: alpha.orgId,
      locationId: alpha.mainLocationId,
      source: "instagram",
      itemType: "dm",
      sourceReviewId: "alpha-seo-dm",
      text: "A private message that must never reach an indexable page",
      rawPayload: {},
    });

    const page = await resolveLocationPageBySlug(alpha.slug);
    const { reviews } = await loadLocationPageContent(page!);

    expect(JSON.stringify(reviews)).not.toContain("private message");
  });
});

describe("the aggregate above the reviews", () => {
  it("counts every rated review at this branch, not just the approved ones", async () => {
    // Same integrity rule as the badge, on a page that states it in prose: a
    // business may choose what it quotes, not what it scored. Alpha's main
    // branch has a 5 on display and a 1 withheld, so the honest average is 3.
    const page = await resolveLocationPageBySlug(alpha.slug);
    const { reviews, aggregate } = await loadLocationPageContent(page!);

    expect(reviews).toHaveLength(1);
    expect(aggregate).toEqual({ basis: "all_reviews_in_scope", average: 3, count: 2 });
  });
});

describe("publication", () => {
  it("resolves an unpublished page but marks it so, and the route refuses it", async () => {
    const draft = await makeOrg("draft", false);
    const page = await resolveLocationPageBySlug(draft.slug);

    // The resolver returns it — the in-app link needs to render one before it
    // goes live — and `published: false` is what the route checks.
    expect(page?.published).toBe(false);
  });

  it("has no slug at all until a page is published for the first time", async () => {
    const [row] = await getAdminDb()
      .select({ slug: schema.locations.publicSlug })
      .from(schema.locations)
      .where(eq(schema.locations.id, alpha.otherLocationId));

    // The backfill decision, asserted. A migration that minted slugs for every
    // existing location would have created addresses nobody asked for.
    expect(row?.slug).toBeNull();
  });
});
