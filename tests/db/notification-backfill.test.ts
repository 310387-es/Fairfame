import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { notifyPendingReviews } from "@/notifications/service";

/**
 * A backfill is not news (W1.3).
 *
 * **The bug.** Connecting Google to a fresh account produced 217 unread
 * notifications — one for every review the business had ever received,
 * delivered as though all of it had just happened. The only bound was
 * `reviews.created_at > now() - interval '7 days'`, and `created_at` is when
 * *we* wrote the row, so on a first sync a decade of history is seven minutes
 * old and every bit of it qualifies.
 *
 * The cases below are the ones where the two rules disagree with each other,
 * because either rule alone looks sufficient until you find the case it misses:
 *
 *   - old review, ingested in the backfill        → both rules say no
 *   - **new review, ingested in the backfill**    → only the first-sync rule says no
 *   - **old review, ingested after the backfill** → only the connection-age rule says no
 *   - new review, ingested after the backfill     → both say yes, and it is the
 *                                                    only one anybody hears about
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

const CONNECTED_AT = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
/** The backfill finished three days after the connection was made — see below. */
const FIRST_SYNCED_AT = new Date(CONNECTED_AT.getTime() + 3 * 24 * 60 * 60 * 1000);

let orgId: string;
let locationId: string;
let userId: string;

/**
 * Inserts a review with both timestamps under test control.
 *
 * `postedAt` is when the customer wrote it; `createdAt` is when we ingested it.
 * Separating them is the whole point — a backfill makes them wildly disagree,
 * and every version of this bug comes from code that only looked at one.
 */
async function addReview(options: { postedAt: Date; ingestedAt: Date }): Promise<string> {
  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: orgId,
      locationId,
      source: "google",
      sourceReviewId: `nb-${suffix}-${counter++}`,
      authorName: "Ayşe",
      rating: 5,
      text: "Çok iyiydi.",
      postedAt: options.postedAt,
      createdAt: options.ingestedAt,
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });

  return review!.id;
}

async function notifiedReviewIds(): Promise<string[]> {
  const rows = await getAdminDb()
    .select({ reviewId: schema.notifications.reviewId })
    .from(schema.notifications)
    .where(eq(schema.notifications.organizationId, orgId));

  return rows.map((row) => row.reviewId).filter((id): id is string => id !== null);
}

beforeAll(async () => {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Backfill ${suffix}`, slug: `backfill-${suffix}` })
    .returning({ id: schema.organizations.id });
  orgIds.push(org!.id);
  orgId = org!.id;

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: orgId, name: "Kadıköy" })
    .returning({ id: schema.locations.id });
  locationId = location!.id;

  const [user] = await getAdminDb()
    .insert(schema.users)
    .values({ email: `nb-${suffix}@example.test`, name: "Owner", emailVerified: true })
    .returning({ id: schema.users.id });
  userId = user!.id;

  await getAdminDb()
    .insert(schema.memberships)
    .values({ organizationId: orgId, userId, role: "owner" });

  // A connection made a week ago whose first sync only ran three days later —
  // the shape this product creates on purpose, because a Google connection is
  // born `pending` and syncs nothing until somebody maps it to a location.
  await getAdminDb().insert(schema.connections).values({
    organizationId: orgId,
    locationId,
    provider: "google",
    status: "active",
    createdAt: CONNECTED_AT,
    firstSyncedAt: FIRST_SYNCED_AT,
    lastSyncedAt: new Date(),
  });
}, 30_000);

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await getAdminDb().delete(schema.users).where(eq(schema.users.id, userId));
  await closeDatabasePools();
});

// ---------------------------------------------------------------------------

describe("what a first sync brings in", () => {
  it("tells nobody about any of it, however it is dated", async () => {
    // Written years ago — the 217.
    const ancient = await addReview({
      postedAt: new Date(CONNECTED_AT.getTime() - 400 * 24 * 60 * 60 * 1000),
      ingestedAt: new Date(FIRST_SYNCED_AT.getTime() - 60_000),
    });

    // Written *after* the connection was made but still swept up in the
    // backfill, because the first sync had not run yet. The connection-age rule
    // alone would let this one through, and on a real Google account waiting a
    // few days to be mapped that is a heap of its own.
    const duringTheWait = await addReview({
      postedAt: new Date(CONNECTED_AT.getTime() + 24 * 60 * 60 * 1000),
      ingestedAt: new Date(FIRST_SYNCED_AT.getTime() - 60_000),
    });

    const outcome = await notifyPendingReviews({ organizationId: orgId });

    expect(outcome.created).toBe(0);
    expect(await notifiedReviewIds()).not.toContain(ancient);
    expect(await notifiedReviewIds()).not.toContain(duringTheWait);
  });
});

describe("what arrives afterwards", () => {
  it("stays quiet about a review written before the business connected", async () => {
    // A later sync reaching further back — a cursor reset, a provider
    // re-reporting an old page. We are learning about it now; it did not happen
    // now, and it happened before any of this was ours to watch.
    const old = await addReview({
      postedAt: new Date(CONNECTED_AT.getTime() - 30 * 24 * 60 * 60 * 1000),
      ingestedAt: new Date(),
    });

    await notifyPendingReviews({ organizationId: orgId });

    expect(await notifiedReviewIds()).not.toContain(old);
  });

  it("notifies about a review that genuinely just happened", async () => {
    const fresh = await addReview({ postedAt: new Date(), ingestedAt: new Date() });

    const outcome = await notifyPendingReviews({ organizationId: orgId });

    expect(outcome.created).toBe(1);
    expect(await notifiedReviewIds()).toContain(fresh);
  });
});

describe("a review from no connection at all", () => {
  it("is news, because somebody just filled in the form", async () => {
    // First-party collection has no `connections` row. Defaulting these to
    // "history" would silence the one source whose arrivals are unambiguously
    // live — someone standing at the counter with a QR code.
    const [walkIn] = await getAdminDb()
      .insert(schema.reviews)
      .values({
        organizationId: orgId,
        locationId,
        source: "firstparty",
        sourceReviewId: `nb-walkin-${suffix}`,
        authorName: "Mehmet",
        rating: 5,
        text: "Az önce doldurdum.",
        postedAt: new Date(),
        rawPayload: {},
      })
      .returning({ id: schema.reviews.id });

    const outcome = await notifyPendingReviews({ organizationId: orgId });

    expect(outcome.created).toBe(1);
    expect(await notifiedReviewIds()).toContain(walkIn!.id);
  });
});
