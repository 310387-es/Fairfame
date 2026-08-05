import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { loadFacts } from "@/dashboard/facts";
import { rangeWindow } from "@/dashboard/range";
import { needsAttention } from "@/dashboard/attention";
import { inboxFacets, listInbox } from "@/inbox/queries";
import { refreshPriority } from "@/inbox/workflow";
import { withTenant } from "@/lib/tenancy";
import { notifySlaBreaches } from "@/notifications/service";
import { subscribeToPlanWith } from "./plan-fixture";

/**
 * One definition of "answered" (W1.2).
 *
 * **The bug, in one sentence:** a review the owner had already answered in
 * Google Business Profile showed an "answered on Google" badge *and* counted as
 * unanswered in the chips, *and* accrued an overdue badge, *and* sat at the top
 * of the triage queue, *and* appeared in the digest's "answer these" list, *and*
 * dragged the response rate down — because six surfaces each asked a different
 * question and only the badge knew about platform replies.
 *
 * So this file is deliberately organised **per surface** rather than per
 * module, in the spirit of `public-leakage.test.ts`: the same two reviews are
 * walked past every reader in the product, and the assertion is always that
 * they agree. A unit test of `answered.ts` would pass while any one of these
 * callers went on asking its own question, which is exactly what happened.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

type Fixture = { orgId: string; locationId: string };

/** Old enough that its deadline has long lapsed — the overdue cases need that. */
const POSTED_AT = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
const SLA_DUE_AT = new Date(POSTED_AT.getTime() + 24 * 60 * 60 * 1000);
const OWNER_REPLIED_AT = new Date(POSTED_AT.getTime() + 2 * 60 * 60 * 1000);

/** Answered on the platform. Everything must treat it as answered. */
let answeredInGoogle: string;
/** Identical in every other way, and answered by nobody. The control. */
let untouched: string;

let fixture: Fixture;

async function addReview(options: {
  ownerRepliedAt?: Date | null;
  rating?: number;
  reply?: "posted" | "failed";
}): Promise<string> {
  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      source: "google",
      sourceReviewId: `ans-${suffix}-${counter++}`,
      authorName: "Ayşe",
      rating: options.rating ?? 1,
      text: "Servis çok yavaştı ve kimse ilgilenmedi.",
      postedAt: POSTED_AT,
      slaDueAt: SLA_DUE_AT,
      ownerRepliedAt: options.ownerRepliedAt ?? null,
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });

  await getAdminDb()
    .insert(schema.reviewInsights)
    .values({
      organizationId: fixture.orgId,
      reviewId: review!.id,
      sentiment: "negative",
      sentimentScore: -0.8,
      topics: ["servis"],
      language: "tr",
      promptId: "test@1",
      model: "test",
    });

  if (options.reply) {
    await getAdminDb().insert(schema.replies).values({
      organizationId: fixture.orgId,
      reviewId: review!.id,
      text: "Özür dileriz.",
      status: options.reply,
      postedAt: OWNER_REPLIED_AT,
    });
  }

  return review!.id;
}

beforeAll(async () => {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Answered ${suffix}`, slug: `answered-${suffix}` })
    .returning({ id: schema.organizations.id });
  orgIds.push(org!.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org!.id, name: "Kadıköy" })
    .returning({ id: schema.locations.id });

  fixture = { orgId: org!.id, locationId: location!.id };

  answeredInGoogle = await addReview({ ownerRepliedAt: OWNER_REPLIED_AT });
  untouched = await addReview({});
}, 30_000);

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

function read<T>(fn: (tx: Parameters<typeof listInbox>[0]) => Promise<T>): Promise<T> {
  return withTenant({ organizationId: fixture.orgId }, fn);
}

// ---------------------------------------------------------------------------

describe("the Inbox list", () => {
  it("returns a platform-answered review under the answered filter", async () => {
    const page = await read((tx) =>
      listInbox(tx, fixture.orgId, fixture.locationId, { reply: "answered" }),
    );

    expect(page.rows.map((row) => row.id)).toEqual([answeredInGoogle]);
  });

  it("keeps it out of the unanswered filter", async () => {
    const page = await read((tx) =>
      listInbox(tx, fixture.orgId, fixture.locationId, { reply: "unanswered" }),
    );

    expect(page.rows.map((row) => row.id)).toEqual([untouched]);
  });

  it("keeps it out of the overdue filter, though its deadline lapsed a week ago", async () => {
    const page = await read((tx) =>
      listInbox(tx, fixture.orgId, fixture.locationId, { overdue: true }),
    );

    expect(page.rows.map((row) => row.id)).toEqual([untouched]);
  });

  it("carries the timestamp to the card, so the badge and the filters share a source", async () => {
    // The badge used to be computed from `raw_payload` while the filters read
    // `replies` — one row, two answers, and that is the bug.
    const page = await read((tx) => listInbox(tx, fixture.orgId, fixture.locationId, {}));
    const row = page.rows.find((candidate) => candidate.id === answeredInGoogle);

    expect(row?.ownerRepliedAt).toBeInstanceOf(Date);
    expect(page.rows.find((candidate) => candidate.id === untouched)?.ownerRepliedAt).toBeNull();
  });
});

describe("the quick-filter chips", () => {
  it("counts it as answered and not as overdue", async () => {
    const facets = await read((tx) => inboxFacets(tx, fixture.orgId, fixture.locationId, {}));

    // A chip that promises a number the list then contradicts is worse than no
    // chip, so these are asserted against the same fixture the list saw.
    expect(facets.unanswered).toBe(1);
    expect(facets.overdue).toBe(1);
    expect(facets.total).toBe(2);
  });
});

describe("triage priority", () => {
  it("sinks it the way a reply of our own would", async () => {
    await read((tx) => refreshPriority(tx, fixture.orgId, [answeredInGoogle, untouched]));

    const rows = await getAdminDb()
      .select({ id: schema.reviews.id, priority: schema.reviews.priority })
      .from(schema.reviews)
      .where(inArray(schema.reviews.id, [answeredInGoogle, untouched]));

    const scored = new Map(rows.map((row) => [row.id, row.priority]));

    // Same rating, same sentiment: the only difference is who answered, and it
    // is worth 55 points — the unanswered bonus plus the answered penalty.
    expect(scored.get(untouched)! - scored.get(answeredInGoogle)!).toBe(55);
  });
});

describe("Home", () => {
  it("does not put it in the needs-attention queue", async () => {
    const window = rangeWindow("30d", new Date());
    const rows = await read((tx) =>
      needsAttention(tx, fixture.orgId, fixture.locationId, window, { limit: 10 }),
    );

    expect(rows.map((row) => row.reviewId)).toEqual([untouched]);
  });

  it("counts it in the response rate", async () => {
    const window = rangeWindow("30d", new Date());
    const facts = await read((tx) => loadFacts(tx, fixture.orgId, fixture.locationId, window));

    const replied = facts.current.filter((fact) => fact.repliedAt !== null);

    // A business that answers every review in Google was being reported as
    // answering none of them.
    expect(replied.map((fact) => fact.reviewId)).toEqual([answeredInGoogle]);
  });
});

describe("the SLA breach sweep", () => {
  it("does not claim a review the owner already answered", async () => {
    await subscribeToPlanWith(fixture.orgId, ["sla_tracking"]);

    const result = await notifySlaBreaches({ organizationId: fixture.orgId });

    // Emailing a manager about a review their own owner answered in Google is
    // the version of this bug that makes the product argue with somebody who
    // was right. Exactly one of the two is a genuine breach.
    expect(result.reviews).toBe(1);

    const [claimed] = await getAdminDb()
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(
        and(
          eq(schema.reviews.organizationId, fixture.orgId),
          isNotNull(schema.reviews.slaAlertedAt),
        ),
      );

    expect(claimed?.id).toBe(untouched);
  });
});
