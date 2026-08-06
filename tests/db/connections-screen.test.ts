import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConnectionFacts, SPARKLINE_DAYS } from "@/connections/facts";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";
import { loadLocationFacts } from "@/locations/facts";

/**
 * The Connections and Branches screens (W4.2).
 *
 * Two organizations with the same provider, the same branch names and the same
 * customers, because an isolation test written with "Org A" and "Org B" passes
 * for a leaking query as long as the ids happen to line up.
 *
 * What is actually load-bearing here is the **rollup**, and it is load-bearing
 * in the direction that hides things: a chain with Google working on one branch
 * and broken on another must not report a working Google connection, and a
 * branch's unanswered backlog must not shrink as it ages. Both are failures
 * that look like good news.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

type Org = { id: string; kadikoy: string; besiktas: string; userId: string };

let alpha: Org;
let beta: Org;

const DAY = 24 * 60 * 60 * 1_000;
const NOW = new Date("2026-08-06T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

async function makeOrg(label: string): Promise<Org> {
  const db = getAdminDb();

  const [org] = await db
    .insert(schema.organizations)
    .values({ name: `Conn ${label} ${suffix}`, slug: `conn-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const locations = await db
    .insert(schema.locations)
    .values([
      { organizationId: org.id, name: "Kadıköy Şubesi" },
      { organizationId: org.id, name: "Beşiktaş Şubesi" },
    ])
    .returning({ id: schema.locations.id });

  const [user] = await db
    .insert(schema.users)
    .values({ email: `conn-${label}-${suffix}@example.com`, name: label })
    .returning({ id: schema.users.id });
  userIds.push(user!.id);
  await db.insert(schema.memberships).values({
    organizationId: org.id,
    userId: user!.id,
    role: "admin",
  });

  return {
    id: org.id,
    kadikoy: locations[0]!.id,
    besiktas: locations[1]!.id,
    userId: user!.id,
  };
}

async function addReview(
  org: Org,
  locationId: string,
  values: { rating: number | null; postedAt: Date; answered?: boolean; source?: string },
) {
  const db = getAdminDb();
  const [review] = await db
    .insert(schema.reviews)
    .values({
      organizationId: org.id,
      locationId,
      source: values.source ?? "google",
      sourceReviewId: `r-${crypto.randomUUID()}`,
      authorName: "Mehmet Demir",
      rating: values.rating,
      text: "Servis çok yavaştı.",
      postedAt: values.postedAt,
      rawPayload: {},
      ...(values.answered ? { ownerRepliedAt: values.postedAt } : {}),
    })
    .returning({ id: schema.reviews.id });

  return review!.id;
}

beforeAll(async () => {
  alpha = await makeOrg("alpha");
  beta = await makeOrg("beta");

  const db = getAdminDb();

  /**
   * Google on both of alpha's branches: healthy in Kadıköy, dead in Beşiktaş.
   * This is the shape the rollup exists for.
   */
  await db.insert(schema.connections).values([
    {
      organizationId: alpha.id,
      locationId: alpha.kadikoy,
      provider: "google",
      status: "active",
      lastSyncedAt: daysAgo(0),
    },
    {
      organizationId: alpha.id,
      locationId: alpha.besiktas,
      provider: "google",
      status: "error",
      lastErrorKind: "auth",
      lastError: "Token has been revoked.",
      failureCount: 4,
      lastSyncedAt: daysAgo(3),
    },
    /**
     * Rate limited. Present, connected, and deliberately *not* attention: it
     * resolves itself, and a screen that raises an alarm over a 429 is one
     * whose alarm stops meaning anything.
     */
    {
      organizationId: alpha.id,
      locationId: alpha.kadikoy,
      provider: "instagram",
      status: "error",
      lastErrorKind: "rate_limit",
      lastError: "Application request limit reached.",
      failureCount: 9,
      lastSyncedAt: daysAgo(0),
    },
    // Disconnected: must not appear at all, and must not drag the rollup down.
    {
      organizationId: alpha.id,
      locationId: alpha.kadikoy,
      provider: "firstparty",
      status: "disconnected",
      lastSyncedAt: daysAgo(9),
    },
  ]);

  // Beta's own Google connection, healthy, so a leak shows up as a wrong count.
  await db.insert(schema.connections).values({
    organizationId: beta.id,
    locationId: beta.kadikoy,
    provider: "google",
    status: "active",
    lastSyncedAt: daysAgo(0),
  });

  // Alpha: three rated reviews this window, two the window before, one of them
  // answered by the owner on the platform.
  await addReview(alpha, alpha.kadikoy, { rating: 5, postedAt: daysAgo(2) });
  await addReview(alpha, alpha.kadikoy, { rating: 5, postedAt: daysAgo(4) });
  await addReview(alpha, alpha.kadikoy, { rating: 2, postedAt: daysAgo(6), answered: true });
  await addReview(alpha, alpha.kadikoy, { rating: 2, postedAt: daysAgo(40) });
  await addReview(alpha, alpha.kadikoy, { rating: 2, postedAt: daysAgo(45) });

  // The ageing backlog: old, unanswered, and outside every window.
  await addReview(alpha, alpha.besiktas, { rating: 1, postedAt: daysAgo(120) });

  // Beta's reviews carry the same shape, so a cross-tenant read inflates counts.
  await addReview(beta, beta.kadikoy, { rating: 5, postedAt: daysAgo(2) });
  await addReview(beta, beta.kadikoy, { rating: 5, postedAt: daysAgo(3) });
});

afterAll(async () => {
  const db = getAdminDb();
  if (orgIds.length > 0) {
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  if (userIds.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await closeDatabasePools();
});

const facts = () =>
  loadConnectionFacts({
    organizationId: alpha.id,
    userId: alpha.userId,
    includeDevOnly: false,
    now: NOW,
  });

describe("a source is one card, however many branches it feeds", () => {
  it("groups two connections into one Google card", async () => {
    const { connected } = await facts();
    const google = connected.filter((card) => card.provider === "google");

    expect(google).toHaveLength(1);
    expect(google[0]!.locations).toHaveLength(2);
  });

  it("takes the worst branch's health, not the best", async () => {
    /**
     * The assertion the whole rollup exists for. Google works on Kadıköy and is
     * revoked on Beşiktaş; reporting "Working" because one of them is fine
     * would hide the only fact on the card worth acting on, and it would look
     * like good news while doing it.
     */
    const { connected } = await facts();
    const google = connected.find((card) => card.provider === "google");

    expect(google?.health).toBe("reconnect");
    expect(google?.locations.find((row) => row.name.startsWith("Kadıköy"))?.health).toBe("healthy");
    expect(google?.locations.find((row) => row.name.startsWith("Beşiktaş"))?.health).toBe(
      "reconnect",
    );
  });

  it("surfaces the failing branch's own error rather than nothing", async () => {
    const { connected } = await facts();
    expect(connected.find((card) => card.provider === "google")?.lastError).toContain("revoked");
  });

  it("leaves a disconnected source off the screen entirely", async () => {
    // Not "healthy" and not a card: a source somebody removed is gone, and
    // rendering it as working is how a business thinks it is still collecting.
    const { connected } = await facts();
    expect(connected.map((card) => card.provider)).not.toContain("firstparty");
  });

  it("sorts what needs a person above what does not", async () => {
    const { connected } = await facts();
    expect(connected[0]?.provider).toBe("google");
  });
});

describe("the volume sparkline", () => {
  it("has one value per day in the window, including the empty ones", async () => {
    /**
     * The zero days are the point. Rows only exist for days with reviews, so a
     * sparkline built from the query alone would compress a quiet fortnight
     * into a straight line and read as steady traffic.
     */
    const { connected } = await facts();
    const google = connected.find((card) => card.provider === "google");

    expect(google?.volume).toHaveLength(SPARKLINE_DAYS);
    expect(google?.volume.filter((value) => value === 0).length).toBeGreaterThan(20);
  });

  it("counts only this organization's reviews", async () => {
    // Beta has two reviews in the same days on the same provider.
    const { connected } = await facts();
    expect(connected.find((card) => card.provider === "google")?.volumeTotal).toBe(3);
  });
});

describe("coverage", () => {
  it("counts connected against what could be connected, not against the roadmap", async () => {
    // Otherwise the bar sits near zero forever and reads as a product that is
    // mostly missing rather than one with a roadmap.
    const { coverage, connected, available, roadmap } = await facts();

    expect(coverage.connected).toBe(connected.length);
    expect(coverage.total).toBe(connected.length + available.length);
    expect(roadmap.length).toBeGreaterThan(0);
    expect(coverage.total).toBeLessThan(connected.length + available.length + roadmap.length);
  });

  it("counts a rate-limited source as connected and not as attention", async () => {
    // Nobody acts on a rate limit; it resolves itself. A screen that cries for
    // attention over one is a screen whose attention signal stops meaning
    // anything. Instagram is throttled and Google is revoked: two connected,
    // one needing somebody.
    const { coverage, connected } = await facts();

    expect(connected.find((card) => card.provider === "instagram")?.health).toBe("limited");
    expect(coverage.connected).toBe(2);
    expect(coverage.attention).toBe(1);
  });
});

describe("branch facts", () => {
  const load = () =>
    withTenant({ organizationId: alpha.id, userId: alpha.userId }, (tx) =>
      loadLocationFacts(tx, alpha.id, NOW),
    );

  it("windows the volume and the rating to thirty days", async () => {
    const rows = await load();
    expect(rows.get(alpha.kadikoy)?.reviews).toBe(3);
    expect(rows.get(alpha.kadikoy)?.rating).toBeCloseTo(4, 5);
  });

  it("compares against the thirty days before, not against all time", async () => {
    // Previous window is two 2-star reviews, so the branch is up two stars.
    const rows = await load();
    expect(rows.get(alpha.kadikoy)?.ratingDelta).toBeCloseTo(2, 5);
  });

  it("does not window the unanswered backlog", async () => {
    /**
     * A one-star review from four months ago that nobody answered is still
     * unanswered. Windowing it would make the number *shrink as the backlog
     * aged* — the exact opposite of what a backlog count is for, and it would
     * look like the team catching up.
     */
    const rows = await load();
    expect(rows.get(alpha.besiktas)?.unanswered).toBe(1);
  });

  it("does not count an owner reply on the platform as unanswered", async () => {
    /**
     * The W1.2 definition, inherited rather than re-derived. Kadıköy has five
     * reviews all-time and one of them the owner answered in Google — so four,
     * not five, and not three: the count is deliberately unwindowed, so the two
     * reviews from six weeks ago are in it.
     */
    const rows = await load();
    expect(rows.get(alpha.kadikoy)?.unanswered).toBe(4);
  });

  it("keeps a branch with a backlog and no recent reviews in the table", async () => {
    // Beşiktaş has nothing in either window. Dropping it would hide precisely
    // the row somebody needs to see.
    const rows = await load();
    expect(rows.has(alpha.besiktas)).toBe(true);
    expect(rows.get(alpha.besiktas)?.reviews).toBe(0);
  });

  it("reports no rating rather than zero for a branch with nothing rated", async () => {
    // A branch with no rated reviews did not average nought stars, and a zero
    // in a comparison table is read as a result.
    const rows = await load();
    expect(rows.get(alpha.besiktas)?.rating).toBeNull();
    expect(rows.get(alpha.besiktas)?.ratingDelta).toBeNull();
  });

  it("sees none of the other organization's reviews", async () => {
    const rows = await load();
    expect(rows.has(beta.kadikoy)).toBe(false);
  });
});

describe("integration requests", () => {
  it("records one row per organization per source, however many times asked", async () => {
    // A signal, not a petition. Pressing it forty times must not make the count
    // useless for the only thing it is for.
    await withTenant({ organizationId: alpha.id, userId: alpha.userId }, async (tx) => {
      for (let index = 0; index < 3; index += 1) {
        await tx
          .insert(schema.integrationRequests)
          .values({
            organizationId: alpha.id,
            providerKey: "yemeksepeti",
            requestedByUserId: alpha.userId,
          })
          .onConflictDoNothing();
      }

      const rows = await tx
        .select({ id: schema.integrationRequests.id })
        .from(schema.integrationRequests)
        .where(eq(schema.integrationRequests.providerKey, "yemeksepeti"));

      expect(rows).toHaveLength(1);
    });

    const { roadmap } = await facts();
    expect(roadmap.find((card) => card.key === "yemeksepeti")?.requested).toBe(true);
    expect(roadmap.find((card) => card.key === "getir")?.requested).toBe(false);
  });

  it("does not show one organization's request to another", async () => {
    const other = await loadConnectionFacts({
      organizationId: beta.id,
      userId: beta.userId,
      includeDevOnly: false,
      now: NOW,
    });

    expect(other.roadmap.find((card) => card.key === "yemeksepeti")?.requested).toBe(false);
  });
});
