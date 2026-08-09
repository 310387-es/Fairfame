import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { loadFacts } from "@/dashboard/facts";
import { rangeWindow } from "@/dashboard/range";
import { needsAttention } from "@/dashboard/attention";
import { composeInsight } from "@/dashboard/insight";
import { computeResponseDistribution } from "@/dashboard/metrics";
import { needsReply } from "@/reviews/answered";
import { inboxFacets, listInbox } from "@/reviews/queries";
import { refreshPriority } from "@/reviews/workflow";
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
/** Drafted and never sent — still unanswered, and still outstanding work. */
let drafted: string;
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
      needsAttention(tx, fixture.orgId, [fixture.locationId], window, { limit: 10 }),
    );

    expect(rows.map((row) => row.reviewId)).toEqual([untouched]);
  });

  it("counts it in the response rate", async () => {
    const window = rangeWindow("30d", new Date());
    const facts = await read((tx) => loadFacts(tx, fixture.orgId, [fixture.locationId], window));

    const replied = facts.current.filter((fact) => fact.repliedAt !== null);

    // A business that answers every review in Google was being reported as
    // answering none of them.
    expect(replied.map((fact) => fact.reviewId)).toEqual([answeredInGoogle]);
  });
});

/**
 * A22-A3 — "waiting for a reply" means one thing across the product.
 *
 * W1.2 unified *answered*; it left "waiting" alone, and four surfaces went on
 * counting different sets under the same two words: the Home strip counted
 * unanswered complaints, its second clause counted every complaint on a theme
 * whether answered or not, the response card counted every unanswered item, and
 * the Inbox counted a fourth thing again. The tester read them side by side and
 * stopped believing all four.
 *
 * The rule now: **every count of "waiting" is `needsReply`, and any narrower one
 * is a subset that says on screen what it narrowed to.** Asserted across
 * surfaces, in the spirit of the rest of this file — a unit test of the
 * predicate passes happily while one caller goes on asking its own question.
 */
describe("what is waiting for a reply", () => {
  it("agrees between the Inbox chip and Home's facts", async () => {
    const window = rangeWindow("30d", new Date());

    const [facets, facts] = await Promise.all([
      read((tx) => inboxFacets(tx, fixture.orgId, fixture.locationId, {})),
      read((tx) => loadFacts(tx, fixture.orgId, [fixture.locationId], window)),
    ]);

    const waiting = facts.current.filter(needsReply);

    // Both fixtures fall inside 30 days, so the two populations are the same
    // here and the counts must be identical — the SQL predicate and the fact
    // predicate are two implementations of one rule.
    expect(waiting.map((fact) => fact.reviewId)).toEqual([untouched]);
    expect(waiting).toHaveLength(facets.unanswered);
  });

  it("keeps the Home strip's count inside the Inbox's, and never above it", async () => {
    const window = rangeWindow("30d", new Date());

    const [facets, facts] = await Promise.all([
      read((tx) => inboxFacets(tx, fixture.orgId, fixture.locationId, {})),
      read((tx) => loadFacts(tx, fixture.orgId, [fixture.locationId], window)),
    ]);

    const insight = composeInsight(facts);

    // The strip is deliberately narrower — negatives only — and the copy says
    // so. What it may never be is *larger* than the queue it is drawn from.
    expect(insight.waiting).toBeLessThanOrEqual(facets.unanswered);
    expect(insight.themeNegatives).toBeLessThanOrEqual(insight.waiting);
  });

  it("counts the same review the response distribution calls unanswered", async () => {
    const window = rangeWindow("30d", new Date());
    const facts = await read((tx) => loadFacts(tx, fixture.orgId, [fixture.locationId], window));

    const unanswered = computeResponseDistribution(facts).find(
      (bucket) => bucket.key === "unanswered",
    );

    // The card and the chip were the two numbers a manager compares first.
    expect(unanswered?.count).toBe(facts.current.filter(needsReply).length);
  });
});

/**
 * A22-A4 — a draft is not an answer.
 *
 * Observed in the cafe-owner run: pressing "draft with AI" took the queue from
 * 47 to 46. Nothing had been sent, so the customer was exactly as unanswered as
 * a second earlier — the count of outstanding work fell because somebody
 * *started* it, which is the one thing a work queue must never do. Worse, a
 * draft nobody approves then keeps the review out of every list in the product
 * while the customer waits.
 *
 * A separate fixture, because the whole file's other assertions rest on two
 * reviews and this one adds a third.
 */
describe("a saved draft", () => {
  beforeAll(async () => {
    drafted = await addReview({});
    await getAdminDb().insert(schema.replies).values({
      organizationId: fixture.orgId,
      reviewId: drafted,
      text: "Bunu henüz göndermedik.",
      status: "draft",
    });
  });

  it("leaves the review in the unanswered queue", async () => {
    const page = await read((tx) =>
      listInbox(tx, fixture.orgId, fixture.locationId, { reply: "unanswered" }),
    );

    expect(page.rows.map((row) => row.id)).toContain(drafted);
  });

  it("does not move the chip that counts outstanding work", async () => {
    const facets = await read((tx) => inboxFacets(tx, fixture.orgId, fixture.locationId, {}));

    // Two unanswered: the untouched one and the drafted one. Before this, the
    // draft silently took the second out.
    expect(facets.unanswered).toBe(2);
    // And it is reported as a subset, so a screen can say "one of these has
    // been written" without adding it to anything.
    expect(facets.drafted).toBe(1);
    expect(facets.drafted).toBeLessThanOrEqual(facets.unanswered);
  });

  it("is reachable on its own, which is what the queue is for", async () => {
    const page = await read((tx) =>
      listInbox(tx, fixture.orgId, fixture.locationId, { reply: "drafted" }),
    );

    expect(page.rows.map((row) => row.id)).toEqual([drafted]);
  });

  it("is not counted as answered", async () => {
    const page = await read((tx) =>
      listInbox(tx, fixture.orgId, fixture.locationId, { reply: "answered" }),
    );

    expect(page.rows.map((row) => row.id)).toEqual([answeredInGoogle]);
  });

  it("does not sink the review in the triage queue", async () => {
    await read((tx) => refreshPriority(tx, fixture.orgId, [drafted, untouched]));

    const rows = await getAdminDb()
      .select({ id: schema.reviews.id, priority: schema.reviews.priority })
      .from(schema.reviews)
      .where(inArray(schema.reviews.id, [drafted, untouched]));

    const scored = new Map(rows.map((row) => [row.id, row.priority]));

    // Identical reviews, one of them drafted. Starting on the angriest review
    // in the queue used to push it 55 points down the queue.
    expect(scored.get(drafted)).toBe(scored.get(untouched));
  });

  it("stays in Home's attention queue, marked rather than hidden", async () => {
    const window = rangeWindow("30d", new Date());
    const rows = await read((tx) =>
      needsAttention(tx, fixture.orgId, [fixture.locationId], window, { limit: 10 }),
    );

    const row = rows.find((candidate) => candidate.reviewId === drafted);

    // Hiding it was the old rule, and its price was a draft nobody sent taking
    // the review out of every work list in the product.
    expect(row).toBeDefined();
    expect(row?.drafted).toBe(true);
    expect(rows.find((candidate) => candidate.reviewId === untouched)?.drafted).toBe(false);
  });

  it("counts as unanswered on Home, exactly as the Inbox does", async () => {
    const window = rangeWindow("30d", new Date());

    const [facets, facts] = await Promise.all([
      read((tx) => inboxFacets(tx, fixture.orgId, fixture.locationId, {})),
      read((tx) => loadFacts(tx, fixture.orgId, [fixture.locationId], window)),
    ]);

    // The disagreement A22-A3 left standing: the facts loader always knew a
    // draft was not a reply, and the Inbox did not. On the tester's real data
    // that was 4 against 6.
    expect(facts.current.filter(needsReply)).toHaveLength(facets.unanswered);
  });
});

describe("the SLA breach sweep", () => {
  it("does not claim a review the owner already answered", async () => {
    await subscribeToPlanWith(fixture.orgId, ["sla_tracking"]);

    const result = await notifySlaBreaches({ organizationId: fixture.orgId });

    // Emailing a manager about a review their own owner answered in Google is
    // the version of this bug that makes the product argue with somebody who
    // was right. The platform-answered one is not a breach; the untouched one
    // and the *drafted* one both are — a deadline is about when the customer
    // hears back, and nobody has sent the draft (A22-A4).
    expect(result.reviews).toBe(2);

    const claimed = await getAdminDb()
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(
        and(
          eq(schema.reviews.organizationId, fixture.orgId),
          isNotNull(schema.reviews.slaAlertedAt),
        ),
      );

    expect(claimed.map((row) => row.id).sort()).toEqual([untouched, drafted].sort());
  });
});
