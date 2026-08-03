import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { inboxFacets, listInbox } from "@/inbox/queries";
import { withTenant } from "@/lib/tenancy";

/**
 * Inbox filtering (P1a-T9).
 *
 * The Definition of Done: "the Inbox is filterable by sentiment/theme and every
 * card reflects its analysis." The card rendering is a component; what is
 * testable here is that each filter selects the rows it claims to, that the
 * facet counts match what a click would actually show, and that a review whose
 * only reply attempt failed still counts as unanswered.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

type Fixture = { orgId: string; locationId: string; otherLocationId: string };

async function makeFixture(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Inbox ${label} ${suffix}`, slug: `inbox-${label}-${suffix}` })
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

  return {
    orgId: org.id,
    locationId: locations[0]!.id,
    otherLocationId: locations[1]!.id,
  };
}

async function addReview(
  fixture: Fixture,
  options: {
    source?: string;
    rating?: number | null;
    text?: string;
    sentiment?: "positive" | "neutral" | "negative";
    topics?: string[];
    locationId?: string;
    reply?: "draft" | "approved" | "posted" | "failed";
  } = {},
): Promise<string> {
  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: fixture.orgId,
      locationId: options.locationId ?? fixture.locationId,
      source: options.source ?? "mock",
      sourceReviewId: `i-${suffix}-${counter++}`,
      authorName: "Mehmet",
      rating: options.rating === undefined ? 4 : options.rating,
      text: options.text ?? "Bir yorum.",
      postedAt: new Date(Date.now() - counter * 60_000),
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });
  if (!review) throw new Error("review insert returned nothing");

  if (options.sentiment || options.topics) {
    await getAdminDb()
      .insert(schema.reviewInsights)
      .values({
        organizationId: fixture.orgId,
        reviewId: review.id,
        sentiment: options.sentiment ?? "neutral",
        sentimentScore: options.sentiment === "negative" ? -0.8 : 0.6,
        topics: options.topics ?? ["servis"],
        language: "tr",
        promptId: "test@1",
        model: "test",
      });
  }

  if (options.reply) {
    await getAdminDb().insert(schema.replies).values({
      organizationId: fixture.orgId,
      reviewId: review.id,
      text: "Teşekkürler.",
      status: options.reply,
    });
  }

  return review.id;
}

/** The rows only — `hasMore` has its own tests below. */
async function read(fixture: Fixture, filters = {}) {
  const page = await withTenant({ organizationId: fixture.orgId }, (tx) =>
    listInbox(tx, fixture.orgId, fixture.locationId, filters),
  );
  return page.rows;
}

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("the unfiltered inbox", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("plain");
    await addReview(fixture, { sentiment: "negative", topics: ["servis", "bekleme süresi"] });
    await addReview(fixture, { sentiment: "positive", topics: ["kahvaltı"] });
    await addReview(fixture, { locationId: fixture.otherLocationId });
  });

  it("returns only the active location's reviews", async () => {
    expect(await read(fixture)).toHaveLength(2);
  });

  it("carries the analysis onto each row", async () => {
    const rows = await read(fixture);
    const negative = rows.find((row) => row.sentiment === "negative");

    // "every card reflects its analysis" — the card cannot show what the query
    // did not fetch.
    expect(negative?.topics).toEqual(["servis", "bekleme süresi"]);
    expect(negative?.sentimentScore).toBeLessThan(0);
  });

  it("leaves an unanalyzed review readable", async () => {
    const bare = await makeFixture("bare");
    await addReview(bare, { sentiment: undefined, topics: undefined });

    const { rows } = await withTenant({ organizationId: bare.orgId }, (tx) =>
      listInbox(tx, bare.orgId, bare.locationId),
    );

    // Analysis is asynchronous; a review must appear the moment it is ingested,
    // not once a model has got to it.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sentiment).toBeNull();
    expect(rows[0]?.topics).toEqual([]);
  });
});

describe("filters", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("filters");
    await addReview(fixture, { source: "mock", sentiment: "negative", topics: ["servis"] });
    await addReview(fixture, { source: "mock", sentiment: "positive", topics: ["kahvaltı"] });
    await addReview(fixture, {
      source: "firstparty",
      sentiment: "negative",
      topics: ["otopark"],
    });
  });

  it("filters by sentiment", async () => {
    const rows = await read(fixture, { sentiment: "negative" });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.sentiment === "negative")).toBe(true);
  });

  it("filters by theme", async () => {
    // The link a digest action produces.
    const rows = await read(fixture, { theme: "otopark" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.topics).toContain("otopark");
  });

  it("filters by source", async () => {
    const rows = await read(fixture, { source: "firstparty" });
    expect(rows).toHaveLength(1);
  });

  it("combines filters", async () => {
    expect(await read(fixture, { source: "mock", sentiment: "negative" })).toHaveLength(1);
    expect(
      await read(fixture, { source: "mock", sentiment: "negative", theme: "otopark" }),
    ).toEqual([]);
  });

  it("matches a theme exactly, not by prefix", async () => {
    const rows = await read(fixture, { theme: "servi" });
    // `= any(topics)` rather than a LIKE — "servi" is not "servis".
    expect(rows).toEqual([]);
  });
});

describe("reply state", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("replies");
    await addReview(fixture, { topics: ["servis"] });
    await addReview(fixture, { topics: ["servis"], reply: "posted" });
    await addReview(fixture, { topics: ["servis"], reply: "draft" });
    await addReview(fixture, { topics: ["servis"], reply: "failed" });
  });

  it("counts a review with a failed reply as unanswered", async () => {
    const rows = await read(fixture, { reply: "unanswered" });

    // A rejected post frees the review to be answered again, so it is still
    // outstanding work — the reply service takes the same view.
    expect(rows).toHaveLength(2);
  });

  it("counts a draft as answered", async () => {
    const rows = await read(fixture, { reply: "answered" });

    // Somebody is already on it; showing it as needing attention would send two
    // people to the same review.
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.reply !== null)).toBe(true);
  });

  it("attaches the live reply to its row", async () => {
    const rows = await read(fixture, { reply: "answered" });
    const posted = rows.find((row) => row.reply?.status === "posted");

    expect(posted?.reply?.text).toBe("Teşekkürler.");
  });
});

describe("facets", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("facets");
    await addReview(fixture, { source: "mock", sentiment: "negative", topics: ["servis"] });
    await addReview(fixture, { source: "mock", sentiment: "negative", topics: ["servis"] });
    await addReview(fixture, { source: "mock", sentiment: "positive", topics: ["kahvaltı"] });
    await addReview(fixture, {
      source: "firstparty",
      sentiment: "neutral",
      topics: ["otopark"],
      reply: "posted",
    });
  });

  it("counts what each filter would actually show", async () => {
    const facets = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      inboxFacets(tx, fixture.orgId, fixture.locationId),
    );

    expect(facets.total).toBe(4);
    expect(facets.unanswered).toBe(3);
    expect(facets.sources).toEqual(
      expect.arrayContaining([
        { value: "mock", count: 3 },
        { value: "firstparty", count: 1 },
      ]),
    );

    // A count that disagreed with the filtered list would be worse than no
    // count at all.
    const negative = facets.sentiments.find((entry) => entry.value === "negative");
    expect(negative?.count).toBe(2);
    expect(await read(fixture, { sentiment: "negative" })).toHaveLength(negative?.count ?? -1);
  });

  it("puts negative sentiment first", async () => {
    const facets = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      inboxFacets(tx, fixture.orgId, fixture.locationId),
    );

    // The filter an owner reaches for is not the happy one.
    expect(facets.sentiments[0]?.value).toBe("negative");
  });

  it("ranks themes by volume", async () => {
    const facets = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      inboxFacets(tx, fixture.orgId, fixture.locationId),
    );

    expect(facets.themes[0]).toEqual({ value: "servis", count: 2 });
  });

  it("scopes counts to the location", async () => {
    await addReview(fixture, {
      locationId: fixture.otherLocationId,
      sentiment: "negative",
      topics: ["servis"],
    });

    const facets = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      inboxFacets(tx, fixture.orgId, fixture.locationId),
    );

    expect(facets.total).toBe(4);
  });
});

describe("paging", () => {
  it("says when more reviews match than were returned", async () => {
    const fixture = await makeFixture("paging");
    for (let index = 0; index < 4; index += 1) await addReview(fixture, { topics: ["servis"] });

    const page = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listInbox(tx, fixture.orgId, fixture.locationId, { limit: 3 }),
    );

    // The screen printed "111 of 111" while truncating at 100 before this
    // existed — a number an owner would not trust twice.
    expect(page.rows).toHaveLength(3);
    expect(page.hasMore).toBe(true);
  });

  it("does not claim more when the page is exactly full", async () => {
    const fixture = await makeFixture("exact");
    for (let index = 0; index < 3; index += 1) await addReview(fixture, { topics: ["servis"] });

    const page = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listInbox(tx, fixture.orgId, fixture.locationId, { limit: 3 }),
    );

    expect(page.rows).toHaveLength(3);
    expect(page.hasMore).toBe(false);
  });
});

describe("tenant isolation", () => {
  it("never returns another organization's reviews", async () => {
    const mine = await makeFixture("iso-mine");
    const theirs = await makeFixture("iso-theirs");

    await addReview(theirs, { sentiment: "negative", topics: ["servis"] });

    const { rows } = await withTenant({ organizationId: mine.orgId }, (tx) =>
      listInbox(tx, mine.orgId, theirs.locationId, {}),
    );

    expect(rows).toEqual([]);
  });

  it("never counts another organization's reviews in the facets", async () => {
    const mine = await makeFixture("iso-facet-mine");
    const theirs = await makeFixture("iso-facet-theirs");

    await addReview(theirs, { sentiment: "negative", topics: ["servis"] });
    await addReview(mine, { sentiment: "positive", topics: ["kahvaltı"] });

    const facets = await withTenant({ organizationId: mine.orgId }, (tx) =>
      inboxFacets(tx, mine.orgId, mine.locationId),
    );

    expect(facets.total).toBe(1);
    expect(facets.themes).toEqual([{ value: "kahvaltı", count: 1 }]);
  });
});
