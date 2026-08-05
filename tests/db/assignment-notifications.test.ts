import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { assignReview } from "@/inbox/triage";
import { bulkAssign } from "@/inbox/bulk";
import { withTenant } from "@/lib/tenancy";
import { createCaptureTransport } from "@/messaging/email";
import { ASSIGNMENT_ROLLUP_THRESHOLD } from "@/notifications/assignment";
import { sendPendingEmails } from "@/notifications/email";
import { listFeed } from "@/notifications/feed";
import { savePreference } from "@/notifications/preferences";
import { subscribeToPlanWith } from "./plan-fixture";

/**
 * Telling somebody that work was handed to them (P2-T4 follow-up).
 *
 * Assignment shipped silent: the column was written, the audit row recorded it,
 * and the person receiving the work was told nothing. These assert the four
 * decisions in `src/notifications/assignment.ts` — who is told, who is not, what
 * happens in bulk, and which preference still wins — because each of them is a
 * judgement rather than a mechanism, and the kind of thing a later change would
 * quietly reverse.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

type Fixture = {
  orgId: string;
  manager: string;
  worker: string;
  locationId: string;
  reviewIds: string[];
};

async function makeFixture(reviewCount = 3): Promise<Fixture> {
  const label = `a${counter++}`;

  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Assign ${label} ${suffix}`, slug: `assign-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);
  await subscribeToPlanWith(org.id, ["bulk_actions"]);

  const users = await getAdminDb()
    .insert(schema.users)
    .values([
      { email: `mgr-${label}-${suffix}@example.com`, name: "Manager" },
      { email: `wkr-${label}-${suffix}@example.com`, name: "Worker" },
    ])
    .returning({ id: schema.users.id });

  const manager = users[0]!.id;
  const worker = users[1]!.id;

  await getAdminDb()
    .insert(schema.memberships)
    .values([
      { organizationId: org.id, userId: manager, role: "admin" },
      { organizationId: org.id, userId: worker, role: "member" },
    ]);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Merkez` })
    .returning({ id: schema.locations.id });

  const reviews = await getAdminDb()
    .insert(schema.reviews)
    .values(
      Array.from({ length: reviewCount }, (_, index) => ({
        organizationId: org.id,
        locationId: location!.id,
        source: "google",
        sourceReviewId: `${label}-${index}`,
        rating: 5,
        authorName: `Author ${index}`,
        text: `Review number ${index}`,
        rawPayload: {},
      })),
    )
    .returning({ id: schema.reviews.id });

  return {
    orgId: org.id,
    manager,
    worker,
    locationId: location!.id,
    reviewIds: reviews.map((review) => review.id),
  };
}

/** The actor shape triage expects, with an unrestricted location scope. */
const actorFor = (fixture: Fixture, userId: string, role: "admin" | "member" = "admin") => ({
  organizationId: fixture.orgId,
  userId,
  role,
  scope: { all: true as const, locationIds: [] },
});

const feedFor = (fixture: Fixture, userId: string) =>
  withTenant({ organizationId: fixture.orgId }, (tx) => listFeed(tx, fixture.orgId, userId));

let fixture: Fixture;

beforeEach(async () => {
  fixture = await makeFixture();
});

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("assigning one review", () => {
  it("tells the assignee, and nobody else", async () => {
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      assignReview(tx, actorFor(fixture, fixture.manager), {
        reviewId: fixture.reviewIds[0]!,
        assigneeUserId: fixture.worker,
      }),
    );

    const [workerFeed, managerFeed] = await Promise.all([
      feedFor(fixture, fixture.worker),
      feedFor(fixture, fixture.manager),
    ]);

    expect(workerFeed).toHaveLength(1);
    expect(workerFeed[0]?.type).toBe("review_assigned");
    expect(workerFeed[0]?.reviewId).toBe(fixture.reviewIds[0]);

    // The manager already knows — they did it. Every other notification in the
    // product fans out to a location; this one deliberately does not.
    expect(managerFeed).toHaveLength(0);
  });

  it("carries enough to recognise the review without opening it", async () => {
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      assignReview(tx, actorFor(fixture, fixture.manager), {
        reviewId: fixture.reviewIds[0]!,
        assigneeUserId: fixture.worker,
      }),
    );

    const [item] = await feedFor(fixture, fixture.worker);
    expect(item?.payload).toMatchObject({
      authorName: "Author 0",
      source: "google",
      rating: 5,
      excerpt: "Review number 0",
    });
  });

  it("is never urgent", async () => {
    // Urgency means "a customer is unhappy" or "a promise lapsed". Spending it
    // on workflow would devalue the red badge everywhere it actually matters.
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      assignReview(tx, actorFor(fixture, fixture.manager), {
        reviewId: fixture.reviewIds[0]!,
        assigneeUserId: fixture.worker,
      }),
    );

    const [item] = await feedFor(fixture, fixture.worker);
    expect(item?.urgency).toBe("normal");
  });

  it("says nothing when you assign to yourself", async () => {
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      assignReview(tx, actorFor(fixture, fixture.manager), {
        reviewId: fixture.reviewIds[0]!,
        assigneeUserId: fixture.manager,
      }),
    );

    expect(await feedFor(fixture, fixture.manager)).toHaveLength(0);
  });

  it("says nothing on unassignment", async () => {
    await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const actor = actorFor(fixture, fixture.manager);
      await assignReview(tx, actor, {
        reviewId: fixture.reviewIds[0]!,
        assigneeUserId: fixture.worker,
      });
      await assignReview(tx, actor, { reviewId: fixture.reviewIds[0]!, assigneeUserId: null });
    });

    // The one alert from the assignment stands; taking it away is not news
    // worth a second interruption.
    expect(await feedFor(fixture, fixture.worker)).toHaveLength(1);
  });

  it("tells the new owner again when a review changes hands twice", async () => {
    await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const actor = actorFor(fixture, fixture.manager);
      await assignReview(tx, actor, {
        reviewId: fixture.reviewIds[0]!,
        assigneeUserId: fixture.worker,
      });
      await assignReview(tx, actor, { reviewId: fixture.reviewIds[0]!, assigneeUserId: null });
      await assignReview(tx, actor, {
        reviewId: fixture.reviewIds[0]!,
        assigneeUserId: fixture.worker,
      });
    });

    // A dedupe key of `type:review` alone would swallow the second handoff, and
    // the person would never learn the work came back to them.
    expect(await feedFor(fixture, fixture.worker)).toHaveLength(2);
  });
});

describe("which preference applies", () => {
  it("still reaches someone who only wants negative reviews", async () => {
    // An assignment is about work handed to a person, not about how a customer
    // felt — the same reasoning the SLA sweep already uses.
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      savePreference(tx, {
        organizationId: fixture.orgId,
        userId: fixture.worker,
        locationId: null,
        scope: "negative_only",
        delivery: "instant",
        inApp: true,
        email: true,
      }),
    );

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      assignReview(tx, actorFor(fixture, fixture.manager), {
        reviewId: fixture.reviewIds[0]!,
        assigneeUserId: fixture.worker,
      }),
    );

    expect(await feedFor(fixture, fixture.worker)).toHaveLength(1);
  });

  it("respects someone who turned notifications off", async () => {
    // That is a decision about being interrupted at all, and it outranks us.
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      savePreference(tx, {
        organizationId: fixture.orgId,
        userId: fixture.worker,
        locationId: null,
        scope: "off",
        delivery: "instant",
        inApp: true,
        email: true,
      }),
    );

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      assignReview(tx, actorFor(fixture, fixture.manager), {
        reviewId: fixture.reviewIds[0]!,
        assigneeUserId: fixture.worker,
      }),
    );

    expect(await feedFor(fixture, fixture.worker)).toHaveLength(0);
  });

  it("queues an email like any other alert, with no special case", async () => {
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      assignReview(tx, actorFor(fixture, fixture.manager), {
        reviewId: fixture.reviewIds[0]!,
        assigneeUserId: fixture.worker,
      }),
    );

    const rows = await getAdminDb()
      .select({ emailStatus: schema.notifications.emailStatus })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, fixture.worker));

    expect(rows.map((row) => row.emailStatus)).toEqual(["pending"]);
  });

  it("defers the email for someone who chose the digest", async () => {
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      savePreference(tx, {
        organizationId: fixture.orgId,
        userId: fixture.worker,
        locationId: null,
        scope: "all",
        delivery: "digest",
        inApp: true,
        email: true,
      }),
    );

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      assignReview(tx, actorFor(fixture, fixture.manager), {
        reviewId: fixture.reviewIds[0]!,
        assigneeUserId: fixture.worker,
      }),
    );

    const rows = await getAdminDb()
      .select({ emailStatus: schema.notifications.emailStatus })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, fixture.worker));

    expect(rows.map((row) => row.emailStatus)).toEqual(["deferred"]);
  });
});

describe("what actually leaves the building", () => {
  it("sends a rollup that names the count and links to a queue", async () => {
    // The end of the bug this whole path was rewritten for: rollups used to be
    // rendered through the review-alert template, which produced a blank email
    // linking to `/inbox?review=undefined`. Asserted against the real sender,
    // not the template in isolation, because the defect was in the routing.
    const big = await makeFixture(ASSIGNMENT_ROLLUP_THRESHOLD + 2);

    await withTenant({ organizationId: big.orgId }, (tx) =>
      bulkAssign(tx, actorFor(big, big.manager), {
        reviewIds: big.reviewIds,
        assigneeUserId: big.worker,
      }),
    );

    const transport = createCaptureTransport();
    await sendPendingEmails({ organizationId: big.orgId, transport });

    expect(transport.sent).toHaveLength(1);
    const [message] = transport.sent;

    expect(message?.subject).toContain(String(big.reviewIds.length));
    expect(message?.text).toContain("/inbox?assignee=me");
    expect(message?.html).not.toContain("review=undefined");
    expect(message?.html).not.toContain("undefined");
  });

  it("sends a single assignment as an assignment, not as an arrival", async () => {
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      assignReview(tx, actorFor(fixture, fixture.manager), {
        reviewId: fixture.reviewIds[0]!,
        assigneeUserId: fixture.worker,
      }),
    );

    const transport = createCaptureTransport();
    await sendPendingEmails({ organizationId: fixture.orgId, transport });

    expect(transport.sent).toHaveLength(1);
    // The review may have arrived days ago; what happened now is the handoff.
    expect(transport.sent[0]?.text).not.toContain("just came in");
    expect(transport.sent[0]?.text).toContain("Review number 0");
  });
});

describe("assigning in bulk", () => {
  it("sends one alert per review while the batch is small", async () => {
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      bulkAssign(tx, actorFor(fixture, fixture.manager), {
        reviewIds: fixture.reviewIds,
        assigneeUserId: fixture.worker,
      }),
    );

    const feed = await feedFor(fixture, fixture.worker);
    expect(feed).toHaveLength(fixture.reviewIds.length);
    expect(feed.every((item) => item.type === "review_assigned")).toBe(true);
  });

  it("rolls up once the batch is a wall rather than a list", async () => {
    const big = await makeFixture(ASSIGNMENT_ROLLUP_THRESHOLD + 3);

    await withTenant({ organizationId: big.orgId }, (tx) =>
      bulkAssign(tx, actorFor(big, big.manager), {
        reviewIds: big.reviewIds,
        assigneeUserId: big.worker,
      }),
    );

    const feed = await feedFor(big, big.worker);

    // One line, not eight. And it says how many, so the number is not lost.
    expect(feed).toHaveLength(1);
    expect(feed[0]?.type).toBe("assignment_rollup");
    expect(feed[0]?.payload).toMatchObject({ count: big.reviewIds.length });
    // A rollup names no single review — the destination is the queue.
    expect(feed[0]?.reviewId).toBeNull();
  });
});
