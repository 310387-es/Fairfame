import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";
import { search } from "@/search/queries";

/**
 * Command palette search.
 *
 * The three things worth asserting: that it finds what a person would expect
 * from a fragment, that it *cannot* reach another tenant's or another
 * location's reviews, and that LIKE metacharacters are treated as text rather
 * than as wildcards — a customer whose review says "50%" must not turn the
 * query into "match everything".
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

type Fixture = { orgId: string; locationId: string; otherLocationId: string };

async function makeFixture(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Search ${label} ${suffix}`, slug: `search-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const locations = await getAdminDb()
    .insert(schema.locations)
    .values([
      { organizationId: org.id, name: `${label} A` },
      { organizationId: org.id, name: `${label} B` },
    ])
    .returning({ id: schema.locations.id });

  return { orgId: org.id, locationId: locations[0]!.id, otherLocationId: locations[1]!.id };
}

async function addReview(
  fixture: Fixture,
  options: { text?: string; authorName?: string; topics?: string[]; locationId?: string } = {},
): Promise<string> {
  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: fixture.orgId,
      locationId: options.locationId ?? fixture.locationId,
      source: "mock",
      sourceReviewId: `s-${suffix}-${counter++}`,
      authorName: options.authorName ?? "Mehmet Demir",
      rating: 4,
      text: options.text ?? "Bir yorum.",
      postedAt: new Date(Date.now() - counter * 60_000),
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });
  if (!review) throw new Error("review insert returned nothing");

  if (options.topics) {
    await getAdminDb().insert(schema.reviewInsights).values({
      organizationId: fixture.orgId,
      reviewId: review.id,
      sentiment: "neutral",
      sentimentScore: 0.1,
      topics: options.topics,
      language: "tr",
      promptId: "test@1",
      model: "test",
    });
  }

  return review.id;
}

function run(fixture: Fixture, query: string, locationId?: string) {
  return withTenant({ organizationId: fixture.orgId }, (tx) =>
    search(tx, fixture.orgId, locationId ?? fixture.locationId, query),
  );
}

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("search", () => {
  it("matches a fragment of the review body, case-insensitively", async () => {
    const fixture = await makeFixture("body");
    const id = await addReview(fixture, { text: "İçerisi çok havasızdı ve sıkışıktı." });

    const results = await run(fixture, "HAVASIZ");

    expect(results.reviews.map((review) => review.id)).toContain(id);
  });

  it("matches the author's name", async () => {
    const fixture = await makeFixture("author");
    const id = await addReview(fixture, { authorName: "Zeynep Kaya", text: "Harika." });

    const results = await run(fixture, "zeynep");

    expect(results.reviews.map((review) => review.id)).toContain(id);
  });

  it("returns themes matching a fragment, with their counts", async () => {
    const fixture = await makeFixture("themes");
    await addReview(fixture, { topics: ["bekleme süresi"] });
    await addReview(fixture, { topics: ["bekleme süresi", "servis"] });

    const results = await run(fixture, "bekle");

    expect(results.themes).toEqual([{ slug: "bekleme süresi", count: 2 }]);
  });

  it("ignores reviews belonging to another location", async () => {
    const fixture = await makeFixture("location");
    await addReview(fixture, {
      text: "Otoparkı yoktu.",
      locationId: fixture.otherLocationId,
    });

    const results = await run(fixture, "otopark");

    expect(results.reviews).toHaveLength(0);
  });

  it("cannot reach another organization's reviews", async () => {
    const mine = await makeFixture("mine");
    const theirs = await makeFixture("theirs");
    await addReview(theirs, { text: "Gizli bir yorum." });

    // Same term, my tenant context, their location id: RLS and the explicit
    // predicate must both refuse.
    const results = await run(mine, "gizli", theirs.locationId);

    expect(results.reviews).toHaveLength(0);
  });

  it("treats LIKE wildcards as literal text", async () => {
    const fixture = await makeFixture("wildcards");
    const literal = await addReview(fixture, { text: "İndirim %50 oldu." });
    await addReview(fixture, { text: "Bambaşka bir yorum." });

    // Unescaped, "%50" would be "anything, then 50" — and a bare "%" would
    // match every row in the table.
    const results = await run(fixture, "%50");

    expect(results.reviews.map((review) => review.id)).toEqual([literal]);
  });

  it("folds Turkish diacritics and casing in both directions", async () => {
    const fixture = await makeFixture("turkish");
    const dotted = await addReview(fixture, { text: "İstanbul şubesi çok güzeldi." });
    const dotless = await addReview(fixture, { text: "Servis havasızdı." });

    // Plain `lower()` gets both of these wrong: 'İ' lowercases to 'i' plus a
    // combining dot, and 'I' lowercases to 'i' rather than 'ı'.
    const ascii = await run(fixture, "istanbul");
    const upper = await run(fixture, "HAVASIZ");
    const diacriticless = await run(fixture, "guzel");

    expect(ascii.reviews.map((review) => review.id)).toContain(dotted);
    expect(upper.reviews.map((review) => review.id)).toContain(dotless);
    expect(diacriticless.reviews.map((review) => review.id)).toContain(dotted);
  });

  it("returns nothing for a query below the minimum length", async () => {
    const fixture = await makeFixture("short");
    await addReview(fixture, { text: "a harfi geçiyor." });

    const results = await run(fixture, "a");

    expect(results).toEqual({ reviews: [], themes: [], hasMore: false });
  });

  it("flags that more matched than were returned", async () => {
    const fixture = await makeFixture("more");
    for (let index = 0; index < 8; index += 1) {
      await addReview(fixture, { text: `Tekrarlanan yorum ${index}.` });
    }

    const results = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      search(tx, fixture.orgId, fixture.locationId, "tekrarlanan", 6),
    );

    expect(results.reviews).toHaveLength(6);
    expect(results.hasMore).toBe(true);
  });
});
