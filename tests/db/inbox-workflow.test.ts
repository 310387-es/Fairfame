import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertReviews } from "@/connectors/normalize";
import type { CanonicalReview } from "@/connectors/types";
import { closeDatabasePools, getAdminDb, getAppDb, schema } from "@/db/client";
import { computePriority, DEFAULT_SLA_HOURS, refreshPriority } from "@/inbox/workflow";
import { withTenant } from "@/lib/tenancy";

/**
 * Inbox workflow columns (P2-T1).
 *
 * The Definition of Done for the task: migrations apply, existing reviews are
 * `open`, and newly ingested reviews arrive with a priority and an SLA deadline.
 * The first is asserted by the schema, the other two are asserted here — through
 * the real ingest path (`upsertReviews`), not by writing the columns directly,
 * because "the connector sets these" is the claim being made.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

type Fixture = {
  orgId: string;
  /** No SLA target of its own — inherits. */
  locationId: string;
  /** Four-hour target, set on the location row. */
  fastLocationId: string;
};

async function makeFixture(label: string, orgSlaHours?: number): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({
      name: `Workflow ${label} ${suffix}`,
      slug: `workflow-${label}-${suffix}`,
      settings: orgSlaHours === undefined ? {} : { inbox: { slaHours: orgSlaHours } },
    })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const locations = await getAdminDb()
    .insert(schema.locations)
    .values([
      { organizationId: org.id, name: `${label} inherits` },
      { organizationId: org.id, name: `${label} fast`, slaHours: 4 },
    ])
    .returning({ id: schema.locations.id });

  return {
    orgId: org.id,
    locationId: locations[0]!.id,
    fastLocationId: locations[1]!.id,
  };
}

function canonical(locationId: string, overrides: Partial<CanonicalReview> = {}): CanonicalReview {
  return {
    locationId,
    source: "mock",
    sourceReviewId: `w-${suffix}-${counter++}`,
    authorName: "Selin",
    rating: 2,
    text: "Servis çok yavaştı.",
    language: "tr",
    postedAt: new Date("2026-08-03T09:00:00.000Z"),
    url: null,
    rawPayload: {},
    ...overrides,
  };
}

async function ingest(fixture: Fixture, reviews: CanonicalReview[]): Promise<void> {
  await withTenant({ organizationId: fixture.orgId }, (tx) =>
    upsertReviews(tx, fixture.orgId, reviews),
  );
}

async function readReview(orgId: string, sourceReviewId: string) {
  const [row] = await getAdminDb()
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.sourceReviewId, sourceReviewId));
  if (!row) throw new Error(`no review ${sourceReviewId}`);
  expect(row.organizationId).toBe(orgId);
  return row;
}

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("ingest stamps the workflow columns", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("ingest");
  });

  it("opens every new review", async () => {
    const review = canonical(fixture.locationId);
    await ingest(fixture, [review]);

    expect((await readReview(fixture.orgId, review.sourceReviewId)).status).toBe("open");
  });

  it("scores priority from the rating, before any analysis exists", async () => {
    const angry = canonical(fixture.locationId, { rating: 1 });
    const happy = canonical(fixture.locationId, { rating: 5 });
    await ingest(fixture, [angry, happy]);

    const angryRow = await readReview(fixture.orgId, angry.sourceReviewId);
    const happyRow = await readReview(fixture.orgId, happy.sourceReviewId);

    expect(angryRow.priority).toBe(
      computePriority({ rating: 1, sentiment: null, answered: false }),
    );
    expect(angryRow.priority!).toBeGreaterThan(happyRow.priority!);
  });

  it("sets the deadline from the default target when nothing is configured", async () => {
    const review = canonical(fixture.locationId);
    await ingest(fixture, [review]);

    const row = await readReview(fixture.orgId, review.sourceReviewId);
    const expected = review.postedAt!.getTime() + DEFAULT_SLA_HOURS * 3_600_000;

    expect(row.slaDueAt?.getTime()).toBe(expected);
  });

  it("prefers the location's own target over the organization's", async () => {
    const slow = await makeFixture("org-target", 48);

    const inherited = canonical(slow.locationId);
    const fast = canonical(slow.fastLocationId);
    await ingest(slow, [inherited, fast]);

    const inheritedRow = await readReview(slow.orgId, inherited.sourceReviewId);
    const fastRow = await readReview(slow.orgId, fast.sourceReviewId);

    expect(inheritedRow.slaDueAt?.getTime()).toBe(inherited.postedAt!.getTime() + 48 * 3_600_000);
    expect(fastRow.slaDueAt?.getTime()).toBe(fast.postedAt!.getTime() + 4 * 3_600_000);
  });

  it("leaves no deadline on an item with no posted time", async () => {
    const review = canonical(fixture.locationId, { postedAt: null });
    await ingest(fixture, [review]);

    expect((await readReview(fixture.orgId, review.sourceReviewId)).slaDueAt).toBeNull();
  });
});

describe("a re-sync", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("resync");
  });

  it("does not undo what the team did, and does not move a lapsed deadline", async () => {
    const review = canonical(fixture.locationId, { rating: 2 });
    await ingest(fixture, [review]);

    const first = await readReview(fixture.orgId, review.sourceReviewId);

    // The team picks it up and takes ownership.
    const [user] = await getAdminDb()
      .insert(schema.users)
      .values({ email: `resync-${suffix}@example.com`, name: "Deniz" })
      .returning({ id: schema.users.id });
    await getAdminDb()
      .update(schema.reviews)
      .set({ status: "in_progress", assigneeUserId: user!.id })
      .where(eq(schema.reviews.id, first.id));

    // The platform hands us the same review again, edited, an hour later.
    await ingest(fixture, [
      { ...review, text: "Servis yavaştı ama tatlı güzeldi.", postedAt: new Date() },
    ]);

    const second = await readReview(fixture.orgId, review.sourceReviewId);

    expect(second.text).toBe("Servis yavaştı ama tatlı güzeldi.");
    expect(second.status).toBe("in_progress");
    expect(second.assigneeUserId).toBe(user!.id);
    expect(second.slaDueAt?.getTime()).toBe(first.slaDueAt?.getTime());
  });
});

describe("refreshPriority", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("refresh");
  });

  it("raises the score once the analysis says the review is negative", async () => {
    // Three stars reads as middling; the words are not.
    const review = canonical(fixture.locationId, { rating: 3 });
    await ingest(fixture, [review]);

    const before = await readReview(fixture.orgId, review.sourceReviewId);

    await getAdminDb()
      .insert(schema.reviewInsights)
      .values({
        organizationId: fixture.orgId,
        reviewId: before.id,
        sentiment: "negative",
        sentimentScore: -0.8,
        topics: ["servis"],
        promptId: "test",
        model: "test",
      });

    const changed = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      refreshPriority(tx, fixture.orgId, [before.id]),
    );

    expect(changed).toBe(1);
    expect((await readReview(fixture.orgId, review.sourceReviewId)).priority!).toBeGreaterThan(
      before.priority!,
    );
  });

  it("lowers the score once a live reply exists, but not for a failed attempt", async () => {
    const review = canonical(fixture.locationId, { rating: 1 });
    await ingest(fixture, [review]);
    const row = await readReview(fixture.orgId, review.sourceReviewId);

    const [failed] = await getAdminDb()
      .insert(schema.replies)
      .values({
        organizationId: fixture.orgId,
        reviewId: row.id,
        text: "Rejected by the platform.",
        status: "failed",
      })
      .returning({ id: schema.replies.id });

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      refreshPriority(tx, fixture.orgId, [row.id]),
    );
    expect((await readReview(fixture.orgId, review.sourceReviewId)).priority).toBe(row.priority);

    await getAdminDb()
      .update(schema.replies)
      .set({ status: "posted" })
      .where(eq(schema.replies.id, failed!.id));

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      refreshPriority(tx, fixture.orgId, [row.id]),
    );
    expect((await readReview(fixture.orgId, review.sourceReviewId)).priority!).toBeLessThan(
      row.priority!,
    );
  });

  it("cannot re-score another organization's review", async () => {
    const other = await makeFixture("refresh-other");
    const review = canonical(other.locationId, { rating: 1 });
    await ingest(other, [review]);
    const row = await readReview(other.orgId, review.sourceReviewId);

    // The neighbour names the id explicitly. RLS makes the read return nothing,
    // so there is nothing to write — the row is untouched rather than reset.
    const changed = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      refreshPriority(tx, fixture.orgId, [row.id]),
    );

    expect(changed).toBe(0);
    expect((await readReview(other.orgId, review.sourceReviewId)).priority).toBe(row.priority);
  });
});

describe("the new workflow tables", () => {
  let fixture: Fixture;
  let neighbour: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("tables");
    neighbour = await makeFixture("tables-other");

    await getAdminDb()
      .insert(schema.replyTemplates)
      .values({
        organizationId: neighbour.orgId,
        name: "Teşekkür",
        body: "Teşekkürler {{author}}!",
        language: "tr",
        tags: ["positive"],
      });
    await getAdminDb()
      .insert(schema.savedViews)
      .values({
        organizationId: neighbour.orgId,
        name: "Overdue",
        filters: { status: "open" },
      });
  });

  it("keeps templates and saved views inside their tenant", async () => {
    const seen = await withTenant({ organizationId: fixture.orgId }, async (tx) => ({
      templates: await tx.select().from(schema.replyTemplates),
      views: await tx.select().from(schema.savedViews),
    }));

    expect(seen.templates).toHaveLength(0);
    expect(seen.views).toHaveLength(0);

    const own = await withTenant({ organizationId: neighbour.orgId }, async (tx) => ({
      templates: await tx.select().from(schema.replyTemplates),
      views: await tx.select().from(schema.savedViews),
    }));

    expect(own.templates).toHaveLength(1);
    expect(own.views).toHaveLength(1);
  });

  it("refuses a template forged into another organization", async () => {
    await expect(
      withTenant({ organizationId: fixture.orgId }, (tx) =>
        tx.insert(schema.replyTemplates).values({
          organizationId: neighbour.orgId,
          name: "Forged",
          body: "…",
          language: "tr",
        }),
      ),
    ).rejects.toThrow();
  });

  it("reads nothing at all without tenant context", async () => {
    const rows = await getAppDb().select().from(schema.savedViews);

    expect(rows).toHaveLength(0);
  });

  it("treats a shared view as one name per organization", async () => {
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      tx.insert(schema.savedViews).values({ organizationId: fixture.orgId, name: "Shared" }),
    );

    // owner_user_id is null on both, and NULLS NOT DISTINCT is what makes the
    // second one a conflict rather than a duplicate nobody notices.
    await expect(
      withTenant({ organizationId: fixture.orgId }, (tx) =>
        tx.insert(schema.savedViews).values({ organizationId: fixture.orgId, name: "Shared" }),
      ),
    ).rejects.toThrow();
  });
});
