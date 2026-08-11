import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStubProvider } from "@/ai/providers/stub";
import { setLlmProviderForTesting } from "@/ai/client";
import { connectSource } from "@/connectors/sync";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { currentPeriod, withinLimit } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";
import { MAX_REPLY_CHARS } from "@/prompts/index";
import {
  approveReply,
  discardReply,
  draftReplyForReview,
  liveReplyFor,
  postReply,
  ReplyError,
  saveReplyDraft,
  writeReplyDraft,
} from "@/replies/service";

/**
 * The reply lifecycle against a real database (P1a-T6).
 *
 * The Definition of Done is "a user drafts, edits, and posts (mock) an AI reply
 * end to end; entitlement + usage enforced; guardrails hold" — so the three
 * groups below are the state machine, the plan gate, and the guardrails, plus
 * tenant isolation because this is the table that publishes under a business's
 * own name.
 *
 * The provider is the offline stub (forced in tests/db/setup.ts).
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

type Fixture = {
  orgId: string;
  locationId: string;
  userId: string;
  connectionId: string;
};

let counter = 0;

async function makeUser(label: string): Promise<string> {
  const [user] = await getAdminDb()
    .insert(schema.users)
    .values({ email: `${label}-${suffix}@example.test`, name: label, emailVerified: true })
    .returning({ id: schema.users.id });
  if (!user) throw new Error("user insert returned nothing");
  userIds.push(user.id);
  return user.id;
}

async function makeFixture(label: string, provider = "mock"): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Reply ${label} ${suffix}`, slug: `reply-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Şubesi` })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  const userId = await makeUser(`reply-${label}`);
  await getAdminDb()
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId, role: "owner" });

  const connection = await withTenant({ organizationId: org.id }, (tx) =>
    connectSource(tx, {
      organizationId: org.id,
      provider,
      config: { locationId: location.id, backfillCount: 0 },
    }),
  );

  return { orgId: org.id, locationId: location.id, userId, connectionId: connection.id };
}

async function addReview(
  fixture: Fixture,
  options: { rating?: number | null; text?: string | null; source?: string } = {},
): Promise<string> {
  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      source: options.source ?? "mock",
      sourceReviewId: `rev-${suffix}-${counter++}`,
      authorName: "Mehmet",
      rating: options.rating === undefined ? 2 : options.rating,
      text: options.text === undefined ? "Servis çok yavaştı ve yemek soğuktu." : options.text,
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });
  if (!review) throw new Error("review insert returned nothing");
  return review.id;
}

/** Runs a service call inside a tenant transaction, as an action would. */
function act<T>(fixture: Fixture, fn: (tx: Parameters<typeof liveReplyFor>[0]) => Promise<T>) {
  return withTenant({ organizationId: fixture.orgId, userId: fixture.userId }, fn);
}

async function auditActions(orgId: string): Promise<string[]> {
  const rows = await getAdminDb()
    .select({ action: schema.auditLogs.action })
    .from(schema.auditLogs)
    .where(
      and(eq(schema.auditLogs.organizationId, orgId), like(schema.auditLogs.action, "reply.%")),
    );
  return rows.map((row) => row.action);
}

async function usageOf(orgId: string): Promise<number> {
  const [row] = await getAdminDb()
    .select({ count: schema.usageCounters.count })
    .from(schema.usageCounters)
    .where(
      and(
        eq(schema.usageCounters.organizationId, orgId),
        eq(schema.usageCounters.metric, "ai_analyses_per_month"),
        eq(schema.usageCounters.period, currentPeriod()),
      ),
    );
  return row?.count ?? 0;
}

beforeAll(() => {
  // Deterministic text, so length and edit assertions mean something.
  setLlmProviderForTesting(createStubProvider());
});

afterAll(async () => {
  setLlmProviderForTesting(null);
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await getAdminDb().delete(schema.users).where(inArray(schema.users.id, userIds));
  await closeDatabasePools();
});

describe("draft to posted", () => {
  let fixture: Fixture;
  let reviewId: string;
  let replyId: string;

  beforeAll(async () => {
    fixture = await makeFixture("lifecycle");
    reviewId = await addReview(fixture);
  });

  it("drafts a reply and records what produced it", async () => {
    const reply = await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );

    replyId = reply.id;

    expect(reply.status).toBe("draft");
    expect(reply.aiGenerated).toBe(true);
    expect(reply.edited).toBe(false);
    expect(reply.text.length).toBeGreaterThan(0);
    // Same reason `review_insights` keeps them: an old draft is otherwise
    // indistinguishable from a current one after a prompt change.
    expect(reply.promptId).toMatch(/^draft_reply@/);
    expect(reply.model).toBe("stub-1");
  });

  it("marks an edited draft as edited and keeps the original", async () => {
    const reply = await act(fixture, (tx) =>
      saveReplyDraft({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId,
        text: "Geri bildiriminiz için teşekkürler, bunu ekiple paylaşacağız.",
      }),
    );

    // "The AI wrote this" and "a human changed it" are different facts, and
    // the combination is what matters for quality review and disclosure.
    expect(reply.aiGenerated).toBe(true);
    expect(reply.edited).toBe(true);
    expect(reply.originalText).not.toBe(reply.text);
  });

  it("approves, recording who signed off", async () => {
    const reply = await act(fixture, (tx) =>
      approveReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId,
      }),
    );

    expect(reply.status).toBe("approved");
    expect(reply.approvedByUserId).toBe(fixture.userId);
    expect(reply.approvedAt).not.toBeNull();
  });

  it("posts through the connector and stores the platform's id", async () => {
    const outcome = await act(fixture, (tx) =>
      postReply({ tx, organizationId: fixture.orgId, actorUserId: fixture.userId, replyId }),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.reply.status).toBe("posted");
    expect(outcome.reply.postedAt).not.toBeNull();
    expect(outcome.reply.externalId).toMatch(/^mock_reply_/);
  });

  it("audit-logged every step with the actor", async () => {
    // "Who approved this" is the question asked after a bad reply goes out.
    expect(await auditActions(fixture.orgId)).toEqual(
      expect.arrayContaining(["reply.drafted", "reply.edited", "reply.approved", "reply.posted"]),
    );

    const [posted] = await getAdminDb()
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.organizationId, fixture.orgId),
          eq(schema.auditLogs.action, "reply.posted"),
        ),
      );

    expect(posted?.actorUserId).toBe(fixture.userId);
    // The reply text must not be duplicated into an append-only log.
    expect(JSON.stringify(posted?.meta)).not.toContain("teşekkürler");
  });
});

describe("the state machine", () => {
  it("refuses to approve something that is not a draft", async () => {
    const fixture = await makeFixture("approve-twice");
    const reviewId = await addReview(fixture);

    const reply = await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );

    await act(fixture, (tx) =>
      approveReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: reply.id,
      }),
    );

    await expect(
      act(fixture, (tx) =>
        approveReply({
          tx,
          organizationId: fixture.orgId,
          actorUserId: fixture.userId,
          replyId: reply.id,
        }),
      ),
    ).rejects.toThrow(ReplyError);
  });

  it("refuses to post a draft that was never approved", async () => {
    const fixture = await makeFixture("post-unapproved");
    const reviewId = await addReview(fixture);

    const reply = await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );

    // The whole point of the approve step: nothing reaches a platform without
    // an explicit human signature.
    await expect(
      act(fixture, (tx) =>
        postReply({
          tx,
          organizationId: fixture.orgId,
          actorUserId: fixture.userId,
          replyId: reply.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "wrong_status" });
  });

  it("returns an approved reply to draft when its text is edited", async () => {
    const fixture = await makeFixture("edit-after-approve");
    const reviewId = await addReview(fixture);

    const draft = await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );

    await act(fixture, (tx) =>
      approveReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: draft.id,
      }),
    );

    const edited = await act(fixture, (tx) =>
      saveReplyDraft({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: draft.id,
        text: "Tamamen farklı bir metin.",
      }),
    );

    // Approval was given for specific words. Carrying it silently to different
    // ones would make the signature meaningless.
    expect(edited.status).toBe("draft");
    expect(edited.approvedByUserId).toBeNull();
    expect(edited.approvedAt).toBeNull();
  });

  it("keeps one live reply per review", async () => {
    const fixture = await makeFixture("one-live");
    const reviewId = await addReview(fixture);

    await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );

    // Re-drafting replaces the draft rather than stacking a second one.
    await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );

    const rows = await getAdminDb()
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.reviewId, reviewId));

    expect(rows).toHaveLength(1);
  });

  it("refuses to re-draft over a posted reply", async () => {
    const fixture = await makeFixture("redraft-posted");
    const reviewId = await addReview(fixture);

    const reply = await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );
    await act(fixture, (tx) =>
      approveReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: reply.id,
      }),
    );
    await act(fixture, (tx) =>
      postReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: reply.id,
      }),
    );

    await expect(
      act(fixture, (tx) =>
        draftReplyForReview({
          tx,
          organizationId: fixture.orgId,
          actorUserId: fixture.userId,
          reviewId,
        }),
      ),
    ).rejects.toMatchObject({ code: "already_replied" });
  });

  it("will not delete a posted reply", async () => {
    const fixture = await makeFixture("discard-posted");
    const reviewId = await addReview(fixture);

    const reply = await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );
    await act(fixture, (tx) =>
      approveReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: reply.id,
      }),
    );
    await act(fixture, (tx) =>
      postReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: reply.id,
      }),
    );

    // Deleting the row would not unpublish anything; it would only lose the
    // trail of what was said.
    await expect(
      act(fixture, (tx) =>
        discardReply({
          tx,
          organizationId: fixture.orgId,
          actorUserId: fixture.userId,
          replyId: reply.id,
        }),
      ),
    ).rejects.toThrow(ReplyError);
  });

  it("frees the review for another attempt after a failed post", async () => {
    const fixture = await makeFixture("post-fail");

    // The mock refuses replies when told to.
    await getAdminDb()
      .update(schema.connections)
      .set({ config: { locationId: fixture.locationId, simulate: { failReply: true } } })
      .where(eq(schema.connections.id, fixture.connectionId));

    const reviewId = await addReview(fixture);
    const reply = await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );
    await act(fixture, (tx) =>
      approveReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: reply.id,
      }),
    );

    const outcome = await act(fixture, (tx) =>
      postReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: reply.id,
      }),
    );

    // Returned, not thrown: throwing would roll back the `failed` row written
    // moments earlier in the same transaction, losing the reason and leaving
    // the live slot occupied.
    expect(outcome.ok).toBe(false);

    const [failed] = await getAdminDb()
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.id, reply.id));

    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toContain("Simulated");

    // `failed` vacates the live slot, so a different reply can be written.
    expect(await act(fixture, (tx) => liveReplyFor(tx, fixture.orgId, reviewId))).toBeNull();
    expect(await auditActions(fixture.orgId)).toContain("reply.post_failed");
  });
});

/**
 * A22-B5 — answering a review closes it, and nothing else does.
 *
 * The tester posted a reply and the row still said **Açık**, so the screen
 * disagreed with what he had just done. `reviews.status` is deliberately not
 * derived from reply state — a review can be `done` because somebody phoned the
 * customer, and it can carry a posted reply and still be open work because a
 * promised refund has not happened. What resolves those two is *which* status
 * moves: `open` is the arrival default nobody chose; everything else is a
 * person's decision, and overwriting one would be the product arguing with
 * somebody who knows something it does not.
 */
describe("what posting does to the review", () => {
  async function postedReview(label: string, status?: "in_progress" | "ignored") {
    const fixture = await makeFixture(label);
    const reviewId = await addReview(fixture);

    if (status) {
      await getAdminDb()
        .update(schema.reviews)
        .set({ status })
        .where(eq(schema.reviews.id, reviewId));
    }

    const reply = await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );

    await act(fixture, (tx) =>
      approveReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: reply.id,
      }),
    );
    await act(fixture, (tx) =>
      postReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: reply.id,
      }),
    );

    const [row] = await getAdminDb()
      .select({ status: schema.reviews.status })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, reviewId));

    return row?.status;
  }

  it("closes a review that nobody had touched", async () => {
    expect(await postedReview("post-closes")).toBe("done");
  });

  it("leaves work somebody said was in progress", async () => {
    // The refund case, and the reason this is not simply derived from the
    // reply: the reply went out and the promise behind it has not been kept.
    expect(await postedReview("post-keeps-progress", "in_progress")).toBe("in_progress");
  });

  it("leaves a review somebody deliberately ignored", async () => {
    expect(await postedReview("post-keeps-ignored", "ignored")).toBe("ignored");
  });
});

describe("entitlements and usage", () => {
  it("meters each draft against the monthly allowance", async () => {
    const fixture = await makeFixture("metered");
    const reviewId = await addReview(fixture);

    expect(await usageOf(fixture.orgId)).toBe(0);

    await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );

    // Replies share `ai_analyses_per_month` — the plan config says so.
    expect(await usageOf(fixture.orgId)).toBe(1);
  });

  it("refuses to draft once the allowance is spent", async () => {
    const fixture = await makeFixture("capped");
    const reviewId = await addReview(fixture);

    // The whole allowance, derived rather than written down. Since the
    // 11 Aug 2026 repricing the catalog figure is per location and the resolver
    // multiplies it by the organization's branches, so a literal 250 stopped
    // being the ceiling — it became a number under it, which would leave these
    // tests asserting against an allowance that was never actually spent.
    const { limit } = await withinLimit(fixture.orgId, "ai_analyses_per_month", { additional: 0 });
    if (limit === null) throw new Error("expected a finite analysis allowance");

    await getAdminDb().insert(schema.usageCounters).values({
      organizationId: fixture.orgId,
      metric: "ai_analyses_per_month",
      period: currentPeriod(),
      count: limit,
    });

    await expect(
      act(fixture, (tx) =>
        draftReplyForReview({
          tx,
          organizationId: fixture.orgId,
          actorUserId: fixture.userId,
          reviewId,
        }),
      ),
    ).rejects.toMatchObject({ code: "limit_reached" });

    const rows = await getAdminDb()
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.organizationId, fixture.orgId));

    expect(rows).toHaveLength(0);
  });
});

describe("guardrails", () => {
  it("refuses to draft against a review with no text", async () => {
    const fixture = await makeFixture("no-text");
    const reviewId = await addReview(fixture, { rating: 3, text: null });

    // Nothing to respond to; a draft here would be pure invention.
    await expect(
      act(fixture, (tx) =>
        draftReplyForReview({
          tx,
          organizationId: fixture.orgId,
          actorUserId: fixture.userId,
          reviewId,
        }),
      ),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("bounds a generated draft to the reply limit", async () => {
    const fixture = await makeFixture("bounded");
    const reviewId = await addReview(fixture);

    const reply = await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );

    expect(reply.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
  });

  it("bounds an over-long human edit too", async () => {
    const fixture = await makeFixture("bounded-edit");
    const reviewId = await addReview(fixture);

    const draft = await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );

    const saved = await act(fixture, (tx) =>
      saveReplyDraft({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: draft.id,
        text: "a".repeat(MAX_REPLY_CHARS * 2),
      }),
    );

    // The limit exists so replies stay readable on a review platform; a human
    // typing past it hits the same wall the model does.
    expect(saved.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
  });

  it("refuses an empty edit", async () => {
    const fixture = await makeFixture("empty-edit");
    const reviewId = await addReview(fixture);

    const draft = await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );

    await expect(
      act(fixture, (tx) =>
        saveReplyDraft({
          tx,
          organizationId: fixture.orgId,
          actorUserId: fixture.userId,
          replyId: draft.id,
          text: "   ",
        }),
      ),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("drafts with no actor, for a scheduled job", async () => {
    const fixture = await makeFixture("no-actor");
    const reviewId = await addReview(fixture);

    // The digest pipeline generates drafts on a schedule with nobody to
    // attribute them to. Forcing a placeholder id here put an empty string
    // into a uuid column and aborted the whole digest transaction.
    const reply = await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: null,
        reviewId,
      }),
    );

    expect(reply.status).toBe("draft");
    expect(reply.authorUserId).toBeNull();
  });

  it("uses the location's brand voice when one is set", async () => {
    const fixture = await makeFixture("tone");
    await getAdminDb()
      .update(schema.locations)
      .set({ brandTone: "playful and very informal" })
      .where(eq(schema.locations.id, fixture.locationId));

    const reviewId = await addReview(fixture);

    // The stub derives its answer from the prompt, so a different tone
    // produces different bytes — enough to prove the tone reached the prompt.
    const withTone = await act(fixture, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
      }),
    );

    const plain = await makeFixture("tone-plain");
    const plainReviewId = await addReview(plain);
    const withoutTone = await act(plain, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: plain.orgId,
        actorUserId: plain.userId,
        reviewId: plainReviewId,
      }),
    );

    expect(withTone.text).not.toBe(withoutTone.text);
  });
});

describe("tenant isolation", () => {
  it("cannot draft against another organization's review", async () => {
    const mine = await makeFixture("iso-mine");
    const theirs = await makeFixture("iso-theirs");
    const theirReview = await addReview(theirs);

    // RLS hides the row, so the lookup fails rather than leaking its existence.
    await expect(
      act(mine, (tx) =>
        draftReplyForReview({
          tx,
          organizationId: mine.orgId,
          actorUserId: mine.userId,
          reviewId: theirReview,
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("cannot approve another organization's draft", async () => {
    const mine = await makeFixture("iso-approve-mine");
    const theirs = await makeFixture("iso-approve-theirs");
    const theirReview = await addReview(theirs);

    const theirDraft = await act(theirs, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: theirs.orgId,
        actorUserId: theirs.userId,
        reviewId: theirReview,
      }),
    );

    await expect(
      act(mine, (tx) =>
        approveReply({
          tx,
          organizationId: mine.orgId,
          actorUserId: mine.userId,
          replyId: theirDraft.id,
        }),
      ),
    ).rejects.toThrow(ReplyError);

    const [untouched] = await getAdminDb()
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.id, theirDraft.id));

    expect(untouched?.status).toBe("draft");
  });
});

describe("writing a reply by hand", () => {
  it("stores a draft with no model involved", async () => {
    const fixture = await makeFixture("manual");
    const reviewId = await addReview(fixture);

    const row = await act(fixture, (tx) =>
      writeReplyDraft({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
        text: "Teşekkürler, yine bekleriz.",
      }),
    );

    expect(row.status).toBe("draft");
    expect(row.text).toBe("Teşekkürler, yine bekleriz.");
    // Provenance matters downstream: the composer labels it, and the digest's
    // "replies drafted" figure counts AI work rather than human work.
    expect(row.aiGenerated).toBe(false);
    expect(row.model).toBeNull();
    expect(row.promptId).toBeNull();
    // No original to diff against — the person's own first words are it.
    expect(row.originalText).toBeNull();
  });

  it("costs nothing against the AI allowance", async () => {
    const fixture = await makeFixture("manual-free");
    const reviewId = await addReview(fixture);

    await act(fixture, (tx) =>
      writeReplyDraft({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
        text: "Sağ olun.",
      }),
    );

    expect(await usageOf(fixture.orgId)).toBe(0);
  });

  it("still works when the month's AI allowance is spent", async () => {
    const fixture = await makeFixture("manual-capped");
    const reviewId = await addReview(fixture);

    // The whole allowance, derived rather than written down. Since the
    // 11 Aug 2026 repricing the catalog figure is per location and the resolver
    // multiplies it by the organization's branches, so a literal 250 stopped
    // being the ceiling — it became a number under it, which would leave these
    // tests asserting against an allowance that was never actually spent.
    const { limit } = await withinLimit(fixture.orgId, "ai_analyses_per_month", { additional: 0 });
    if (limit === null) throw new Error("expected a finite analysis allowance");

    await getAdminDb().insert(schema.usageCounters).values({
      organizationId: fixture.orgId,
      metric: "ai_analyses_per_month",
      period: currentPeriod(),
      count: limit,
    });

    // The reason this exists. Metering a typed sentence against the model
    // allowance would make the Inbox read-only for the rest of the billing
    // period — an owner locked out of answering their own customers.
    const row = await act(fixture, (tx) =>
      writeReplyDraft({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
        text: "Geri bildiriminiz için teşekkürler.",
      }),
    );

    expect(row.status).toBe("draft");
  });

  it("goes through the same approval before it can be posted", async () => {
    const fixture = await makeFixture("manual-approve");
    const reviewId = await addReview(fixture);

    const draft = await act(fixture, (tx) =>
      writeReplyDraft({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
        text: "Özür dileriz, ilgileneceğiz.",
      }),
    );

    // Nothing reaches a platform without an explicit human approval — the rule
    // holds whoever wrote the words.
    await expect(
      act(fixture, (tx) =>
        postReply({
          tx,
          organizationId: fixture.orgId,
          actorUserId: fixture.userId,
          replyId: draft.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "wrong_status" });

    await act(fixture, (tx) =>
      approveReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: draft.id,
      }),
    );

    const outcome = await act(fixture, (tx) =>
      postReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: draft.id,
      }),
    );

    expect(outcome.ok).toBe(true);
  });

  it("refuses to overwrite a reply that is already out", async () => {
    const fixture = await makeFixture("manual-posted");
    const reviewId = await addReview(fixture);

    const draft = await act(fixture, (tx) =>
      writeReplyDraft({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
        text: "İlk yanıt.",
      }),
    );
    await act(fixture, (tx) =>
      approveReply({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        replyId: draft.id,
      }),
    );

    await expect(
      act(fixture, (tx) =>
        writeReplyDraft({
          tx,
          organizationId: fixture.orgId,
          actorUserId: fixture.userId,
          reviewId,
          text: "İkinci yanıt.",
        }),
      ),
    ).rejects.toMatchObject({ code: "already_replied" });
  });

  it("refuses an empty reply", async () => {
    const fixture = await makeFixture("manual-empty");
    const reviewId = await addReview(fixture);

    await expect(
      act(fixture, (tx) =>
        writeReplyDraft({
          tx,
          organizationId: fixture.orgId,
          actorUserId: fixture.userId,
          reviewId,
          text: "   ",
        }),
      ),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("is bounded to the same length a model draft is", async () => {
    const fixture = await makeFixture("manual-long");
    const reviewId = await addReview(fixture);

    const row = await act(fixture, (tx) =>
      writeReplyDraft({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
        text: "a".repeat(5_000),
      }),
    );

    // The limit is about staying readable on a review platform, so it applies
    // to a person as much as to the model.
    expect(row.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
  });

  it("records who wrote it", async () => {
    const fixture = await makeFixture("manual-audit");
    const reviewId = await addReview(fixture);

    await act(fixture, (tx) =>
      writeReplyDraft({
        tx,
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        reviewId,
        text: "Teşekkürler.",
      }),
    );

    expect(await auditActions(fixture.orgId)).toContain("reply.written");
  });
});
