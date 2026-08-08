import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";
import {
  autoReplyCandidates,
  locationsWithAutoReply,
  renderAutoReply,
  runAutoReply,
  type AutoReplyRule,
} from "@/replies/auto";

/**
 * Auto-reply to a wordless five-star review (W5-6).
 *
 * This is the only thing in the product that puts words on a public platform
 * with nobody pressing anything, so almost every test here is about what it
 * **refuses**. `src/replies/service.ts` has carried a comment since P1a-T6
 * warning that a future "just auto-post the 5-star ones" must not slip past
 * unnoticed; these are what make the narrowness checkable rather than asserted
 * in a comment.
 *
 * The one positive case is deliberately last. If the refusals ever stop
 * holding, the feature is not "slightly too eager" — it is publishing canned
 * text under a business's name in reply to a complaint.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

const HOUR = 60 * 60 * 1_000;
const NOW = new Date("2026-08-08T12:00:00.000Z");
/** Comfortably past a 24-hour delay. */
const OLD = new Date(NOW.getTime() - 48 * HOUR);
/** Well inside it. */
const FRESH = new Date(NOW.getTime() - 2 * HOUR);

let org: string;
let locationId: string;
let templateId: string;
let rule: AutoReplyRule;

async function addReview(input: {
  rating: number | null;
  text: string | null;
  postedAt: Date;
  source?: string;
  ownerRepliedAt?: Date | null;
  itemType?: "review" | "dm";
}): Promise<string> {
  const [row] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: org,
      locationId,
      source: input.source ?? "mock",
      sourceReviewId: `${suffix}-${crypto.randomUUID().slice(0, 8)}`,
      rating: input.rating,
      text: input.text,
      postedAt: input.postedAt,
      ownerRepliedAt: input.ownerRepliedAt ?? null,
      itemType: input.itemType ?? "review",
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });

  return row!.id;
}

beforeAll(async () => {
  const db = getAdminDb();

  const [created] = await db
    .insert(schema.organizations)
    .values({ name: `Auto ${suffix}`, slug: `auto-${suffix}` })
    .returning({ id: schema.organizations.id });
  org = created!.id;
  orgIds.push(org);

  const [location] = await db
    .insert(schema.locations)
    .values({
      organizationId: org,
      name: "Kadıköy Şubesi",
      replySignature: "— Ayşe, Kadıköy",
    })
    .returning({ id: schema.locations.id });
  locationId = location!.id;

  const [template] = await db
    .insert(schema.replyTemplates)
    .values({
      organizationId: org,
      name: "Yıldız teşekkürü",
      language: "tr",
      body: "Teşekkür ederiz {{author}}! Sizi {{location}} şubemizde ağırlamak güzeldi.",
    })
    .returning({ id: schema.replyTemplates.id });
  templateId = template!.id;

  await db
    .update(schema.locations)
    .set({ autoReplyTemplateId: templateId, autoReplyDelayHours: 24 })
    .where(eq(schema.locations.id, locationId));

  // The rule can only answer a review whose source is still connected, so the
  // fixture needs one — the same shape a real branch has.
  await db.insert(schema.connections).values({
    organizationId: org,
    locationId,
    provider: "mock",
    status: "active",
    capabilities: { read: "full", reply: "api", realtime: false },
    config: { locationId, backfillCount: 0, spanDays: 180, dripIntervalMinutes: null, seed: "" },
  });

  rule = { organizationId: org, locationId, templateId, delayHours: 24 };
});

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("what it refuses", () => {
  it("refuses a five-star review that has words in it", async () => {
    // "Five stars, but the coffee was cold" is a five-star review with
    // something in it, and a canned thank-you reads as not having been read.
    const id = await addReview({ rating: 5, text: "Harika ama kahve soğuktu.", postedAt: OLD });

    const candidates = await withTenant({ organizationId: org }, (tx) =>
      autoReplyCandidates(tx, rule, NOW),
    );

    expect(candidates.map((c) => c.reviewId)).not.toContain(id);
  });

  it("treats an empty string as no words, not as words", async () => {
    // A platform that stores `''` or a space is not a review with content, and
    // reading it as content would exclude exactly the reviews this exists for.
    const id = await addReview({ rating: 5, text: "   ", postedAt: OLD });

    const candidates = await withTenant({ organizationId: org }, (tx) =>
      autoReplyCandidates(tx, rule, NOW),
    );

    expect(candidates.map((c) => c.reviewId)).toContain(id);
  });

  it("refuses four stars", async () => {
    // Not "positive enough". A four-star review is somebody telling you what
    // to fix, and it is answered by a person.
    const id = await addReview({ rating: 4, text: null, postedAt: OLD });

    const candidates = await withTenant({ organizationId: org }, (tx) =>
      autoReplyCandidates(tx, rule, NOW),
    );

    expect(candidates.map((c) => c.reviewId)).not.toContain(id);
  });

  it("refuses a review with no rating at all", async () => {
    const id = await addReview({ rating: null, text: null, postedAt: OLD });

    const candidates = await withTenant({ organizationId: org }, (tx) =>
      autoReplyCandidates(tx, rule, NOW),
    );

    expect(candidates.map((c) => c.reviewId)).not.toContain(id);
  });

  it("refuses one that is still inside the delay", async () => {
    // The delay is the window a person has to answer it themselves, which is
    // what makes this reversible without a support ticket.
    const id = await addReview({ rating: 5, text: null, postedAt: FRESH });

    const candidates = await withTenant({ organizationId: org }, (tx) =>
      autoReplyCandidates(tx, rule, NOW),
    );

    expect(candidates.map((c) => c.reviewId)).not.toContain(id);
  });

  it("refuses one the owner already answered on the platform", async () => {
    const id = await addReview({
      rating: 5,
      text: null,
      postedAt: OLD,
      ownerRepliedAt: new Date(NOW.getTime() - 30 * HOUR),
    });

    const candidates = await withTenant({ organizationId: org }, (tx) =>
      autoReplyCandidates(tx, rule, NOW),
    );

    expect(candidates.map((c) => c.reviewId)).not.toContain(id);
  });

  it("refuses one that already has a reply of ours", async () => {
    const id = await addReview({ rating: 5, text: null, postedAt: OLD });
    await getAdminDb().insert(schema.replies).values({
      organizationId: org,
      reviewId: id,
      text: "Teşekkürler!",
      status: "draft",
      aiGenerated: false,
    });

    const candidates = await withTenant({ organizationId: org }, (tx) =>
      autoReplyCandidates(tx, rule, NOW),
    );

    expect(candidates.map((c) => c.reviewId)).not.toContain(id);
  });

  it("cannot even be handed a five-star DM — the database refuses it", async () => {
    // Stronger than asserting the query filters it out: `reviews_rating_only_
    // _on_reviews` means a rated DM is not a row that can exist. The clause in
    // `autoReplyCandidates` stays anyway, because it states the intent where
    // somebody would come to loosen the rating condition.
    await expect(
      addReview({ rating: 5, text: null, postedAt: OLD, itemType: "dm" }),
    ).rejects.toThrow(/insert into "reviews"/);
  });

  it("refuses a review whose source is no longer connected", async () => {
    // Not a failure to log every hour for ever: a branch that disconnected
    // Google still has its old five-star reviews, and "nobody can reply to
    // this" is a property of the review rather than an error.
    const id = await addReview({ rating: 5, text: null, postedAt: OLD, source: "google" });

    const candidates = await withTenant({ organizationId: org }, (tx) =>
      autoReplyCandidates(tx, rule, NOW),
    );

    expect(candidates.map((c) => c.reviewId)).not.toContain(id);
  });

  it("is off by default, for every location that has not chosen it", async () => {
    const [other] = await getAdminDb()
      .insert(schema.locations)
      .values({ organizationId: org, name: "Beşiktaş Şubesi" })
      .returning({ id: schema.locations.id });

    const rules = await locationsWithAutoReply(getAdminDb());

    // Off is the default, and no organization acquires this by upgrading.
    expect(rules.map((entry) => entry.locationId)).not.toContain(other!.id);
    expect(rules.map((entry) => entry.locationId)).toContain(locationId);
  });

  it("stops when the template it points at is deleted", async () => {
    // ON DELETE SET NULL turns the rule off rather than leaving it pointing at
    // nothing — the safe direction, and what somebody tidying templates expects.
    const [spare] = await getAdminDb()
      .insert(schema.replyTemplates)
      .values({
        organizationId: org,
        name: `Geçici ${suffix}`,
        language: "tr",
        body: "Teşekkürler.",
      })
      .returning({ id: schema.replyTemplates.id });

    const [location] = await getAdminDb()
      .insert(schema.locations)
      .values({
        organizationId: org,
        name: "Moda Şubesi",
        autoReplyTemplateId: spare!.id,
      })
      .returning({ id: schema.locations.id });

    await getAdminDb().delete(schema.replyTemplates).where(eq(schema.replyTemplates.id, spare!.id));

    const rules = await locationsWithAutoReply(getAdminDb());
    expect(rules.map((entry) => entry.locationId)).not.toContain(location!.id);
  });
});

describe("what it posts", () => {
  it("posts the business's own words, with the branch's signature", () => {
    const text = renderAutoReply(
      {
        body: "Teşekkür ederiz {{author}}! {{location}} sizi ağırlamaktan mutlu.",
        signature: "— Ayşe",
      },
      { authorName: "Mehmet", locationName: "Kadıköy", organizationName: "Moda Kahve" },
    );

    expect(text).toBe("Teşekkür ederiz Mehmet! Kadıköy sizi ağırlamaktan mutlu.\n\n— Ayşe");
  });

  it("collapses an anonymous reviewer rather than greeting a blank", () => {
    const text = renderAutoReply(
      { body: "Teşekkürler {{author}}!", signature: null },
      { authorName: null, locationName: "Kadıköy", organizationName: "Moda Kahve" },
    );

    // "Teşekkürler !" is what a naive substitution produces, and it is the one
    // failure a customer would actually see.
    expect(text).toBe("Teşekkürler!");
  });

  it("answers an eligible review and marks it posted", async () => {
    const id = await addReview({ rating: 5, text: null, postedAt: OLD });

    const outcome = await runAutoReply(rule, NOW);
    expect(outcome.posted).toBeGreaterThan(0);

    const [reply] = await withTenant({ organizationId: org }, (tx) =>
      tx.select().from(schema.replies).where(eq(schema.replies.reviewId, id)),
    );

    expect(reply?.status).toBe("posted");
    // Not generated. The whole argument for this feature is that the words are
    // the owner's, so the provenance the Inbox prints must say so.
    expect(reply?.aiGenerated).toBe(false);
    // Nobody approved it, and the row says nobody rather than borrowing an id.
    expect(reply?.approvedByUserId).toBeNull();
    expect(reply?.authorUserId).toBeNull();
    expect(reply?.text).toContain("— Ayşe, Kadıköy");
  });

  it("does not answer the same review twice", async () => {
    const before = await withTenant({ organizationId: org }, (tx) =>
      autoReplyCandidates(tx, rule, NOW),
    );
    await runAutoReply(rule, NOW);
    const after = await withTenant({ organizationId: org }, (tx) =>
      autoReplyCandidates(tx, rule, NOW),
    );

    expect(after.length).toBeLessThan(before.length + 1);
    const second = await runAutoReply(rule, NOW);
    expect(second.posted).toBe(0);
  });
});
