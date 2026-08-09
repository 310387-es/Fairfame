import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recentActivity } from "@/dashboard/activity";
import { needsAttention } from "@/dashboard/attention";
import { hasAnyReviews, loadFacts } from "@/dashboard/facts";
import { rangeWindow } from "@/dashboard/range";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";

/**
 * The dashboard's one read (Home live dashboard §4).
 *
 * Every number on Home is computed from what this returns, so a fault here is
 * not a wrong widget — it is a wrong page, rendered confidently. What is worth
 * asserting is what SQL makes easy to get wrong: the window boundary, the
 * timestamp a review is filed under, and a join that can duplicate a row.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

const NOW = new Date("2026-08-03T12:00:00Z");
const WINDOW = rangeWindow("30d", NOW);

type Fixture = { orgId: string; locationId: string; otherLocationId: string };

async function makeFixture(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Facts ${label} ${suffix}`, slug: `facts-${label}-${suffix}` })
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
  options: {
    postedAt?: Date | null;
    createdAt?: Date;
    rating?: number | null;
    source?: string;
    locationId?: string;
    sentiment?: "positive" | "neutral" | "negative";
    topics?: string[];
    replies?: { status: "draft" | "posted" | "failed"; postedAt?: Date | null }[];
  } = {},
): Promise<string> {
  counter += 1;

  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: fixture.orgId,
      locationId: options.locationId ?? fixture.locationId,
      source: options.source ?? "google",
      sourceReviewId: `f-${suffix}-${counter}`,
      rating: options.rating === undefined ? 4 : options.rating,
      text: "Bir yorum.",
      postedAt: options.postedAt === undefined ? daysBefore(1) : options.postedAt,
      // Ingestion time is pinned to the window too, not left to `now()`.
      // Several facts fall back to `created_at` when a platform gave no posted
      // time, and a default of "the real clock" put those rows *after* the
      // window this suite fixes at 2026-08-03 — so the assertions passed only
      // until that date went by.
      createdAt: options.createdAt ?? daysBefore(1),
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

  for (const reply of options.replies ?? []) {
    await getAdminDb()
      .insert(schema.replies)
      .values({
        organizationId: fixture.orgId,
        reviewId: review.id,
        text: "Teşekkürler.",
        status: reply.status,
        postedAt: reply.postedAt ?? null,
      });
  }

  return review.id;
}

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000);
}

function read(fixture: Fixture, locationId?: string) {
  return withTenant({ organizationId: fixture.orgId }, (tx) =>
    loadFacts(tx, fixture.orgId, [locationId ?? fixture.locationId], WINDOW),
  );
}

beforeAll(() => {
  counter = 0;
});

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("scoping", () => {
  it("reads only the location asked for", async () => {
    const fixture = await makeFixture("scope");
    await addReview(fixture);
    await addReview(fixture, { locationId: fixture.otherLocationId });

    const facts = await read(fixture);

    // A chain's branches are separate dashboards; one location's numbers must
    // never include another's, even inside the same organization.
    expect(facts.current).toHaveLength(1);
  });

  it("cannot see another organization's reviews", async () => {
    const mine = await makeFixture("mine");
    const theirs = await makeFixture("theirs");
    await addReview(theirs);

    // Their location id, read under my tenant context. RLS should make this
    // empty rather than merely filtered — this is the isolation guarantee, and
    // a dashboard is exactly where a leak would go unnoticed.
    const facts = await withTenant({ organizationId: mine.orgId }, (tx) =>
      loadFacts(tx, mine.orgId, [theirs.locationId], WINDOW),
    );

    expect(facts.current).toEqual([]);
    expect(facts.previous).toEqual([]);
  });
});

describe("the window", () => {
  it("splits the current period from the one before it", async () => {
    const fixture = await makeFixture("split");
    await addReview(fixture, { postedAt: daysBefore(2) });
    await addReview(fixture, { postedAt: daysBefore(40) });

    const facts = await read(fixture);

    expect(facts.current).toHaveLength(1);
    expect(facts.previous).toHaveLength(1);
  });

  it("excludes what falls outside both", async () => {
    const fixture = await makeFixture("outside");
    await addReview(fixture, { postedAt: daysBefore(200) });

    const facts = await read(fixture);

    expect(facts.current).toEqual([]);
    expect(facts.previous).toEqual([]);
  });

  it("includes today", async () => {
    const fixture = await makeFixture("today");
    await addReview(fixture, { postedAt: new Date(NOW.getTime() - 60 * 60 * 1_000) });

    // Live means live: a review from an hour ago belongs on the page, even
    // though it makes today's bucket partial.
    expect((await read(fixture)).current).toHaveLength(1);
  });
});

describe("which timestamp a review is filed under", () => {
  it("uses the platform's own time when there is one", async () => {
    const fixture = await makeFixture("posted");
    await addReview(fixture, { postedAt: daysBefore(40) });

    // Ingested today, written 40 days ago: it belongs to the previous period.
    // Filing a backfill under its import date would invent a spike on the day
    // someone connected the source.
    const facts = await read(fixture);

    expect(facts.current).toEqual([]);
    expect(facts.previous).toHaveLength(1);
  });

  it("falls back to ingestion time when the platform gave none", async () => {
    const fixture = await makeFixture("created");
    await addReview(fixture, { postedAt: null });

    // Instagram comments arrive without a reliable timestamp; dropping them
    // from every chart would be worse than dating them by arrival.
    expect((await read(fixture)).current).toHaveLength(1);
  });
});

describe("replies", () => {
  it("records when a reply was actually published", async () => {
    const fixture = await makeFixture("replied");
    await addReview(fixture, { replies: [{ status: "posted", postedAt: daysBefore(1) }] });

    expect((await read(fixture)).current[0]?.repliedAt).not.toBeNull();
  });

  it("does not count a draft as answered", async () => {
    const fixture = await makeFixture("draft");
    await addReview(fixture, { replies: [{ status: "draft" }] });

    // An unsent draft is work in progress. Counting it would let the response
    // rate climb while customers still wait.
    expect((await read(fixture)).current[0]?.repliedAt).toBeNull();
  });

  it("does not count a failed attempt as answered", async () => {
    const fixture = await makeFixture("failed");
    await addReview(fixture, { replies: [{ status: "failed", postedAt: daysBefore(1) }] });

    // A failed post leaves the review answerable again — the same rule the
    // Inbox and the reply service use, so all three agree on "unanswered".
    expect((await read(fixture)).current[0]?.repliedAt).toBeNull();
  });

  it("yields one fact for a review with a failed attempt and a successful one", async () => {
    const fixture = await makeFixture("many");
    await addReview(fixture, {
      replies: [
        { status: "failed", postedAt: daysBefore(3) },
        { status: "posted", postedAt: daysBefore(1) },
      ],
    });

    const facts = await read(fixture);

    // The reply join is the one place this query could duplicate a review, and
    // a duplicate would inflate every volume figure on the page. Two guards
    // hold: `replies_one_live_per_review` allows only one live reply, and the
    // aggregate collapses whatever the join returns. This asserts the outcome
    // rather than either mechanism, so relaxing one is caught here.
    expect(facts.current).toHaveLength(1);
    expect(facts.current[0]?.repliedAt?.toISOString()).toBe(daysBefore(1).toISOString());
  });
});

describe("analysis", () => {
  it("carries sentiment and themes when they exist", async () => {
    const fixture = await makeFixture("insight");
    await addReview(fixture, { sentiment: "negative", topics: ["servis", "temizlik"] });

    const [row] = (await read(fixture)).current;

    expect(row?.sentiment).toBe("negative");
    expect(row?.topics).toEqual(["servis", "temizlik"]);
  });

  it("keeps a review that has not been analysed yet", async () => {
    const fixture = await makeFixture("unanalysed");
    await addReview(fixture, { rating: 5 });

    // Analysis is asynchronous. An inner join here would hide brand-new
    // reviews from the volume count until the worker caught up.
    const [row] = (await read(fixture)).current;

    expect(row?.rating).toBe(5);
    expect(row?.sentiment).toBeNull();
    expect(row?.topics).toEqual([]);
  });
});

describe("the attention queue", () => {
  it("surfaces an unanswered complaint and skips an answered one", async () => {
    const fixture = await makeFixture("queue");
    await addReview(fixture, { rating: 1, sentiment: "negative" });
    await addReview(fixture, {
      rating: 1,
      sentiment: "negative",
      replies: [{ status: "posted", postedAt: daysBefore(1) }],
    });

    const rows = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      needsAttention(tx, fixture.orgId, [fixture.locationId], WINDOW, { now: NOW }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("Bir yorum.");
  });

  it("keeps a drafted review, and marks it rather than hiding it", async () => {
    /**
     * This asserted the opposite until A22-A4, and the reasoning was real: a
     * drafted review was hidden so two people would not be sent to the same
     * one. The price was worse than the problem — a draft nobody approves took
     * the review out of every work list in the product while the customer went
     * on waiting, which is the failure mode nobody would ever notice.
     *
     * So the row stays, because the customer has not heard back, and it carries
     * a flag the card reads: it offers "a draft is waiting — edit and send"
     * instead of a button to write a second one over a colleague's.
     */
    const fixture = await makeFixture("claimed");
    await addReview(fixture, { rating: 1, sentiment: "negative", replies: [{ status: "draft" }] });

    const rows = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      needsAttention(tx, fixture.orgId, [fixture.locationId], WINDOW, { now: NOW }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.drafted).toBe(true);
  });

  it("leaves a posted reply out of it, and does not mark it drafted", async () => {
    const fixture = await makeFixture("answered-out");
    await addReview(fixture, {
      rating: 1,
      sentiment: "negative",
      replies: [{ status: "posted", postedAt: NOW }],
    });

    const rows = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      needsAttention(tx, fixture.orgId, [fixture.locationId], WINDOW, { now: NOW }),
    );

    expect(rows).toEqual([]);
  });

  it("leaves happy reviews out of it", async () => {
    const fixture = await makeFixture("happy");
    await addReview(fixture, { rating: 5, sentiment: "positive" });

    const rows = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      needsAttention(tx, fixture.orgId, [fixture.locationId], WINDOW, { now: NOW }),
    );

    expect(rows).toEqual([]);
  });

  it("cannot reach another organization's reviews", async () => {
    const mine = await makeFixture("queue-mine");
    const theirs = await makeFixture("queue-theirs");
    await addReview(theirs, { rating: 1, sentiment: "negative" });

    // The queue carries review *text* — the most sensitive thing on the page.
    const rows = await withTenant({ organizationId: mine.orgId }, (tx) =>
      needsAttention(tx, mine.orgId, [theirs.locationId], WINDOW, { now: NOW }),
    );

    expect(rows).toEqual([]);
  });
});

describe("the activity feed", () => {
  it("merges arrivals, replies and requests newest-first", async () => {
    const fixture = await makeFixture("feed");
    const reviewId = await addReview(fixture, {
      rating: 5,
      replies: [{ status: "posted", postedAt: daysBefore(1) }],
    });
    expect(reviewId).toBeTruthy();

    const items = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      recentActivity(tx, fixture.orgId, [fixture.locationId], WINDOW),
    );

    // One arrival and one reply, in time order — not one list per kind.
    expect(items.map((item) => item.kind).sort()).toEqual(["reply", "review"]);
    expect(items[0]!.at.getTime()).toBeGreaterThanOrEqual(items[1]!.at.getTime());
  });

  it("dates an arrival by when it reached us", async () => {
    const fixture = await makeFixture("feed-backfill");
    // Written months ago, ingested just now: this morning's sync is the news.
    await addReview(fixture, { postedAt: new Date("2026-01-05T09:00:00Z") });

    const items = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      recentActivity(tx, fixture.orgId, [fixture.locationId], WINDOW),
    );

    expect(items).toHaveLength(1);
  });

  it("ignores a reply that was never posted", async () => {
    const fixture = await makeFixture("feed-draft");
    await addReview(fixture, { replies: [{ status: "draft" }] });

    const items = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      recentActivity(tx, fixture.orgId, [fixture.locationId], WINDOW),
    );

    expect(items.filter((item) => item.kind === "reply")).toEqual([]);
  });

  it("shows nothing from another organization", async () => {
    const mine = await makeFixture("feed-mine");
    const theirs = await makeFixture("feed-theirs");
    await addReview(theirs, { rating: 5 });

    const items = await withTenant({ organizationId: mine.orgId }, (tx) =>
      recentActivity(tx, mine.orgId, [theirs.locationId], WINDOW),
    );

    expect(items).toEqual([]);
  });
});

describe("telling the two empties apart", () => {
  it("knows a location has never received anything", async () => {
    const fixture = await makeFixture("never");

    expect(
      await withTenant({ organizationId: fixture.orgId }, (tx) =>
        hasAnyReviews(tx, fixture.orgId, [fixture.locationId]),
      ),
    ).toBe(false);
  });

  it("knows a quiet period is not an empty location", async () => {
    const fixture = await makeFixture("quiet");
    // Outside every range, but proof the location is wired up. This is the
    // difference between "connect a source" and "try a longer window", and
    // telling a business with 800 reviews to connect a source is the kind of
    // small insult that makes a product feel inattentive.
    await addReview(fixture, { postedAt: daysBefore(300) });

    expect(
      await withTenant({ organizationId: fixture.orgId }, (tx) =>
        hasAnyReviews(tx, fixture.orgId, [fixture.locationId]),
      ),
    ).toBe(true);
  });

  it("does not count another organization's reviews as yours", async () => {
    const mine = await makeFixture("empty-mine");
    const theirs = await makeFixture("empty-theirs");
    await addReview(theirs);

    expect(
      await withTenant({ organizationId: mine.orgId }, (tx) =>
        hasAnyReviews(tx, mine.orgId, [theirs.locationId]),
      ),
    ).toBe(false);
  });
});
