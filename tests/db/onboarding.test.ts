import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { MIN_ANALYSED_REVIEWS } from "@/digest/pipeline";
import { withTenant } from "@/lib/tenancy";
import {
  firstBriefingWindow,
  MAX_LOOKBACK_WEEKS,
  MIN_REVIEWS_FOR_FIRST_BRIEFING,
  onboardingStatus,
  pendingAnalysis,
} from "@/onboarding/first-briefing";
import { isSampleOrganization, markSample } from "@/onboarding/sample";
import { eq, inArray } from "drizzle-orm";

/**
 * The first briefing, and the sample workspace (W5-14).
 *
 * The interesting behaviour is **which week gets briefed on**, and it is the
 * whole reason this module exists. `digest_sweep` composes the last *completed*
 * week, which for somebody who signed up on Tuesday is a week that predates
 * their account — so the product's hero screen was empty for seven days at
 * exactly the moment a new customer was deciding whether to keep it.
 *
 * The two failures that actually happened while building this are both pinned
 * here:
 *
 *   - A threshold below `MIN_ANALYSED_REVIEWS` walks back through the calendar,
 *     settles on a week, and hands it to a pipeline that then declines to draw
 *     a plan from it. The sample workspace's first run opened on "Not enough to
 *     draw a plan from", with sixty reviews in the database.
 *   - Counting progress over the whole backfill rather than over the briefed
 *     span shows 15/200 and then jumps to done.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

const WEEK = 7 * 24 * 60 * 60 * 1_000;

/** Monday 00:00 UTC of the week containing `at`. */
function mondayOf(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day;
}

/** A fixed "now" so the arithmetic is not a function of when the suite runs. */
const NOW = new Date("2026-08-05T12:00:00.000Z");
/** The last *completed* week before NOW: Mon 27 Jul – Mon 3 Aug. */
const LAST_WEEK = new Date(mondayOf(NOW).getTime() - WEEK);

async function makeOrg(label: string): Promise<{ id: string; locationId: string }> {
  const db = getAdminDb();

  const [org] = await db
    .insert(schema.organizations)
    .values({ name: `Onboarding ${label} ${suffix}`, slug: `onb-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await db
    .insert(schema.locations)
    .values({ organizationId: org.id, name: "Moda Kahve" })
    .returning({ id: schema.locations.id });

  return { id: org.id, locationId: location!.id };
}

/** Adds `count` reviews with text, posted inside the week starting `weekStart`. */
async function addReviews(
  organizationId: string,
  locationId: string,
  weekStart: Date,
  count: number,
  options: { text?: boolean } = {},
): Promise<string[]> {
  if (count === 0) return [];

  const rows = await getAdminDb()
    .insert(schema.reviews)
    .values(
      Array.from({ length: count }, (_, index) => ({
        organizationId,
        locationId,
        source: "mock",
        sourceReviewId: `${suffix}-${weekStart.toISOString()}-${index}`,
        rating: 4,
        // Spread across the week so a bucket test cannot pass by accident.
        postedAt: new Date(weekStart.getTime() + index * 60 * 60 * 1_000),
        text: options.text === false ? null : `Yorum ${index}`,
        rawPayload: {},
      })),
    )
    .returning({ id: schema.reviews.id });

  return rows.map((row) => row.id);
}

/** Marks reviews as analysed, without running a model. */
async function analyse(organizationId: string, reviewIds: string[]): Promise<void> {
  if (reviewIds.length === 0) return;

  await getAdminDb()
    .insert(schema.reviewInsights)
    .values(
      reviewIds.map((reviewId) => ({
        organizationId,
        reviewId,
        sentiment: "positive" as const,
        sentimentScore: 0.8,
        topics: ["servis"],
        summary: "İyi",
        model: "test",
        promptId: "analyze_review@3",
      })),
    );
}

let empty: { id: string; locationId: string };
let recent: { id: string; locationId: string };
let stale: { id: string; locationId: string };

beforeAll(async () => {
  empty = await makeOrg("empty");
  recent = await makeOrg("recent");
  stale = await makeOrg("stale");

  // `recent`: a busy week just gone, and a thin current one.
  await addReviews(recent.id, recent.locationId, LAST_WEEK, MIN_REVIEWS_FOR_FIRST_BRIEFING + 3);

  // `stale`: nothing recent, a good week four weeks back — the backfill case.
  await addReviews(
    stale.id,
    stale.locationId,
    new Date(LAST_WEEK.getTime() - 3 * WEEK),
    MIN_REVIEWS_FOR_FIRST_BRIEFING + 1,
  );
}, 60_000);

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("the threshold", () => {
  it("is the pipeline's own minimum, not a smaller number of its own", () => {
    // The defect this pins: any lower and the window walk succeeds, the digest
    // is composed, and it says "not enough to draw a plan from" — which is the
    // exact screen this feature exists to prevent somebody ever seeing.
    expect(MIN_REVIEWS_FOR_FIRST_BRIEFING).toBe(MIN_ANALYSED_REVIEWS);
  });
});

describe("firstBriefingWindow", () => {
  it("picks the week just gone when it has enough in it", async () => {
    const window = await withTenant({ organizationId: recent.id }, (tx) =>
      firstBriefingWindow(tx, recent.id, recent.locationId, NOW),
    );

    expect(window?.start.toISOString()).toBe(LAST_WEEK.toISOString());
  });

  it("walks back to a week with content rather than briefing on an empty one", async () => {
    const window = await withTenant({ organizationId: stale.id }, (tx) =>
      firstBriefingWindow(tx, stale.id, stale.locationId, NOW),
    );

    // A backfill is history: its most recent complete week may be a month ago,
    // and an empty digest presented as a welcome is worse than none.
    expect(window?.start.toISOString()).toBe(
      new Date(LAST_WEEK.getTime() - 3 * WEEK).toISOString(),
    );
  });

  it("never returns a partial week", async () => {
    const window = await withTenant({ organizationId: recent.id }, (tx) =>
      firstBriefingWindow(tx, recent.id, recent.locationId, NOW),
    );

    // A digest means a *completed* week — the archive labels it that way and
    // the week-on-week comparison depends on it. Opening on a half week to have
    // something to show would make the first briefing the one that does not
    // mean what every later one means.
    expect(window!.end.getTime() - window!.start.getTime()).toBe(WEEK);
    expect(window!.end.getTime()).toBeLessThanOrEqual(mondayOf(NOW).getTime());
  });

  it("gives up rather than briefing on ancient history", async () => {
    const old = await makeOrg("old");
    await addReviews(
      old.id,
      old.locationId,
      new Date(LAST_WEEK.getTime() - (MAX_LOOKBACK_WEEKS + 2) * WEEK),
      MIN_REVIEWS_FOR_FIRST_BRIEFING + 5,
    );

    const window = await withTenant({ organizationId: old.id }, (tx) =>
      firstBriefingWindow(tx, old.id, old.locationId, NOW),
    );

    expect(window).toBeNull();
  });

  it("returns nothing at all for a location with no reviews", async () => {
    const window = await withTenant({ organizationId: empty.id }, (tx) =>
      firstBriefingWindow(tx, empty.id, empty.locationId, NOW),
    );

    expect(window).toBeNull();
  });

  it("ignores ratings with no words", async () => {
    // A week of bare five-star ratings gives the pipeline nothing to name, so
    // it must not count towards the threshold that says a week is briefable.
    const silent = await makeOrg("silent");
    await addReviews(silent.id, silent.locationId, LAST_WEEK, MIN_REVIEWS_FOR_FIRST_BRIEFING + 4, {
      text: false,
    });

    const window = await withTenant({ organizationId: silent.id }, (tx) =>
      firstBriefingWindow(tx, silent.id, silent.locationId, NOW),
    );

    expect(window).toBeNull();
  });
});

describe("progress", () => {
  it("counts the briefed span, not the whole backfill", async () => {
    const chain = await makeOrg("span");
    // Ten weeks of history, and a briefable week just gone.
    for (let week = 1; week <= 6; week += 1) {
      await addReviews(chain.id, chain.locationId, new Date(LAST_WEEK.getTime() - week * WEEK), 20);
    }
    const inWeek = await addReviews(
      chain.id,
      chain.locationId,
      LAST_WEEK,
      MIN_REVIEWS_FOR_FIRST_BRIEFING,
    );

    const status = await withTenant({ organizationId: chain.id }, (tx) =>
      onboardingStatus(tx, chain.id, chain.locationId, NOW),
    );

    // 125 reviews in the branch; the briefing reads two weeks of them. A
    // denominator of 125 shows 15/125 and then jumps to finished, which reads
    // as a bug at exactly the wrong moment.
    expect(status.reviews).toBe(125);
    expect(status.analysable).toBe(MIN_REVIEWS_FOR_FIRST_BRIEFING + 20);
    expect(status.analysed).toBe(0);

    await analyse(chain.id, inWeek);

    const after = await withTenant({ organizationId: chain.id }, (tx) =>
      onboardingStatus(tx, chain.id, chain.locationId, NOW),
    );
    expect(after.analysed).toBe(MIN_REVIEWS_FOR_FIRST_BRIEFING);
  });

  it("counts pending work inside the span only", async () => {
    const span = {
      from: new Date(LAST_WEEK.getTime() - WEEK),
      to: new Date(LAST_WEEK.getTime() + WEEK),
    };

    const scoped = await withTenant({ organizationId: recent.id }, (tx) =>
      pendingAnalysis(tx, recent.id, recent.locationId, span),
    );
    const everything = await withTenant({ organizationId: recent.id }, (tx) =>
      pendingAnalysis(tx, recent.id, recent.locationId),
    );

    expect(scoped).toBe(MIN_REVIEWS_FOR_FIRST_BRIEFING + 3);
    expect(everything).toBeGreaterThanOrEqual(scoped);
  });
});

describe("the sample workspace", () => {
  it("is flagged, and nothing else is", async () => {
    await markSample(recent.id);

    expect(await isSampleOrganization(recent.id)).toBe(true);
    // The flag is what makes a one-click delete safe, so "everything else is
    // false by default" is the assertion that matters, not the true case.
    expect(await isSampleOrganization(stale.id)).toBe(false);
    expect(await isSampleOrganization(empty.id)).toBe(false);
  });

  it("holds no reviews outside its own organization", async () => {
    // RLS is what keeps the sample apart, so the check is that the flag is
    // *not* doing any of that work: reading the sample tenant returns only the
    // sample tenant's rows, exactly as it would for any other organization.
    const rows = await withTenant({ organizationId: recent.id }, (tx) =>
      tx.select({ id: schema.reviews.id }).from(schema.reviews),
    );
    const foreign = await getAdminDb()
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(eq(schema.reviews.organizationId, stale.id));

    const sampleIds = new Set(rows.map((row) => row.id));
    for (const row of foreign) expect(sampleIds.has(row.id)).toBe(false);
  });
});
