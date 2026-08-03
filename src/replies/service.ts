import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { draftReply } from "../ai/analyze.ts";
import { schema } from "../db/client.ts";
import { getConnector } from "../connectors/registry.ts";
import { toConnection } from "../connectors/sync.ts";
import { can, recordUsage, withinLimit } from "../lib/entitlements.ts";
import { childLogger } from "../lib/logger.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { MAX_REPLY_CHARS } from "../prompts/index.ts";
import { boundOutput } from "../ai/guardrails.ts";

/**
 * The reply lifecycle: draft → edit → approve → post (P1a-T6).
 *
 * Generation itself lives in ../ai/analyze.ts. What is here is everything
 * around it — the entitlement gate, the state machine, the audit trail, and
 * the one call that actually publishes words in the business's name.
 *
 * Three rules shape the whole module:
 *
 *   - **Nothing reaches a platform without an explicit human approval.** The
 *     model drafts; a person approves; only then can it post. There is no code
 *     path from `draftReplyForReview` to `postReply`, deliberately, so no
 *     future "just auto-post the 5-star ones" can slip in without someone
 *     noticing this comment.
 *   - **Posting is the irreversible step**, so it is the one that verifies the
 *     source can actually accept a reply, re-reads the row inside the
 *     transaction, and records what the platform said.
 *   - **Every transition is audit-logged** with the actor, because "who
 *     approved this" is the question that gets asked after a bad reply goes
 *     out, and reconstructing it from timestamps is not an answer.
 */

const log = childLogger({ module: "replies/service" });

export type ReplyRow = typeof schema.replies.$inferSelect;

/** Statuses that occupy the single live slot per review. */
const LIVE_STATUSES = ["draft", "approved", "posted"] as const;

export type ReplyErrorCode =
  | "not_found"
  | "not_entitled"
  | "limit_reached"
  | "already_replied"
  | "wrong_status"
  | "empty"
  | "no_connection"
  | "cannot_reply"
  | "post_failed";

export class ReplyError extends Error {
  readonly code: ReplyErrorCode;

  constructor(message: string, code: ReplyErrorCode) {
    super(message);
    this.name = "ReplyError";
    this.code = code;
  }
}

/** The live reply for a review, if there is one. */
export async function liveReplyFor(
  tx: TenantDatabase,
  organizationId: string,
  reviewId: string,
): Promise<ReplyRow | null> {
  const [row] = await tx
    .select()
    .from(schema.replies)
    .where(
      and(
        eq(schema.replies.organizationId, organizationId),
        eq(schema.replies.reviewId, reviewId),
        ne(schema.replies.status, "failed"),
      ),
    )
    .limit(1);

  return row ?? null;
}

/** Live replies for a set of reviews, keyed by review id — the Inbox query. */
export async function repliesForReviews(
  tx: TenantDatabase,
  organizationId: string,
  reviewIds: string[],
): Promise<Map<string, ReplyRow>> {
  if (reviewIds.length === 0) return new Map();

  const rows = await tx
    .select()
    .from(schema.replies)
    .where(
      and(
        eq(schema.replies.organizationId, organizationId),
        inArray(schema.replies.reviewId, reviewIds),
        ne(schema.replies.status, "failed"),
      ),
    )
    .orderBy(desc(schema.replies.createdAt));

  return new Map(rows.map((row) => [row.reviewId, row]));
}

type ReviewContext = {
  reviewId: string;
  locationId: string;
  locationName: string;
  brandTone: string | null;
  source: string;
  sourceReviewId: string;
  text: string | null;
  rating: number | null;
  organizationName: string;
};

async function loadReview(
  tx: TenantDatabase,
  organizationId: string,
  reviewId: string,
): Promise<ReviewContext> {
  const [row] = await tx
    .select({
      reviewId: schema.reviews.id,
      locationId: schema.reviews.locationId,
      locationName: schema.locations.name,
      brandTone: schema.locations.brandTone,
      source: schema.reviews.source,
      sourceReviewId: schema.reviews.sourceReviewId,
      text: schema.reviews.text,
      rating: schema.reviews.rating,
      organizationName: schema.organizations.name,
    })
    .from(schema.reviews)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.reviews.locationId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.reviews.organizationId))
    .where(and(eq(schema.reviews.organizationId, organizationId), eq(schema.reviews.id, reviewId)))
    .limit(1);

  // RLS already hides another tenant's review; this turns a silent empty
  // result into a message that names the problem.
  if (!row) throw new ReplyError("That review does not exist.", "not_found");
  return row;
}

async function audit(
  tx: TenantDatabase,
  input: {
    organizationId: string;
    actorUserId: string | null;
    action: string;
    replyId: string;
    meta: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(schema.auditLogs).values({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.action,
    entity: `reply:${input.replyId}`,
    // Never the reply text itself: an append-only log is the worst place to
    // keep a second copy of content that may have to be corrected or erased.
    meta: input.meta,
  });
}

export type DraftArgs = {
  tx: TenantDatabase;
  organizationId: string;
  /**
   * Who asked for this draft. **Null when nobody did** — the digest pipeline
   * generates reply drafts on a schedule, and there is no user to attribute
   * them to. `replies.author_user_id` is nullable for exactly this case, and
   * forcing a placeholder id here is how an empty string reached a uuid column
   * and aborted the whole digest transaction.
   */
  actorUserId: string | null;
  reviewId: string;
  /** Overrides the location's configured voice for this draft only. */
  brandTone?: string | null;
};

/**
 * Generates a reply and stores it as a draft.
 *
 * Gated twice: `ai_replies` decides whether the plan has the feature at all,
 * and `ai_analyses_per_month` caps the volume — the plan config says so
 * explicitly (`ai_replies: true, // capped — see limits.ai_analyses_per_month`
 * in src/lib/plans.ts), so replies and analyses share one allowance rather
 * than inventing a second counter the plans never declared.
 */
export async function draftReplyForReview(args: DraftArgs): Promise<ReplyRow> {
  const { tx, organizationId, actorUserId, reviewId } = args;

  if (!(await can({ organizationId, tx }, "ai_replies"))) {
    throw new ReplyError("AI replies are not included in this plan.", "not_entitled");
  }

  const budget = await withinLimit({ organizationId, tx }, "ai_analyses_per_month");
  if (!budget.allowed) {
    throw new ReplyError(
      "This month's AI allowance is used up. It resets at the start of the next billing period.",
      "limit_reached",
    );
  }

  const existing = await liveReplyFor(tx, organizationId, reviewId);
  if (existing && existing.status !== "draft") {
    // A posted or approved reply is not something to silently overwrite.
    throw new ReplyError("This review already has a reply.", "already_replied");
  }

  const review = await loadReview(tx, organizationId, reviewId);

  if (!review.text || review.text.trim().length === 0) {
    throw new ReplyError(
      "There is nothing to reply to — this review is a rating with no text.",
      "empty",
    );
  }

  const outcome = await draftReply({
    organizationId,
    actorUserId,
    text: review.text,
    rating: review.rating,
    businessName: review.organizationName,
    ...(args.brandTone !== undefined && args.brandTone !== null
      ? { brandTone: args.brandTone }
      : review.brandTone
        ? { brandTone: review.brandTone }
        : {}),
    tx,
  });

  // Metered only on success. A refusal or a provider error produced no draft,
  // and charging for it would make an outage look like usage.
  await recordUsage({ organizationId, tx }, "ai_analyses_per_month", 1);

  const values = {
    organizationId,
    reviewId,
    authorUserId: actorUserId,
    text: outcome.reply,
    status: "draft" as const,
    aiGenerated: true,
    edited: false,
    originalText: outcome.reply,
    promptId: outcome.promptId,
    model: outcome.model,
    lastError: null,
  };

  const [row] = existing
    ? await tx
        .update(schema.replies)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.replies.id, existing.id))
        .returning()
    : await tx.insert(schema.replies).values(values).returning();

  if (!row) throw new Error("Could not persist the reply draft.");

  await audit(tx, {
    organizationId,
    actorUserId,
    action: "reply.drafted",
    replyId: row.id,
    meta: {
      reviewId,
      model: outcome.model,
      promptId: outcome.promptId,
      length: outcome.reply.length,
      costUsd: outcome.costUsd,
    },
  });

  return row;
}

/**
 * Saves an edited draft.
 *
 * Bounded to the same length the prompt asks the model for, because the limit
 * exists to keep replies readable on a review platform — a human typing past
 * it hits the same wall as the model.
 */
export async function saveReplyDraft(args: {
  tx: TenantDatabase;
  organizationId: string;
  actorUserId: string;
  replyId: string;
  text: string;
}): Promise<ReplyRow> {
  const { tx, organizationId, actorUserId, replyId } = args;

  const text = boundOutput(args.text, MAX_REPLY_CHARS);
  if (text.length === 0) throw new ReplyError("A reply cannot be empty.", "empty");

  const [current] = await tx
    .select()
    .from(schema.replies)
    .where(and(eq(schema.replies.organizationId, organizationId), eq(schema.replies.id, replyId)))
    .limit(1);

  if (!current) throw new ReplyError("That draft does not exist.", "not_found");
  if (current.status === "posted") {
    throw new ReplyError("A posted reply cannot be edited here.", "wrong_status");
  }

  const [row] = await tx
    .update(schema.replies)
    .set({
      text,
      authorUserId: actorUserId,
      // Editing an approved reply returns it to draft: approval was given for
      // specific words, and silently carrying it over to different ones would
      // make the signature meaningless.
      status: "draft",
      approvedByUserId: null,
      approvedAt: null,
      edited: current.originalText !== null && text !== current.originalText,
      updatedAt: new Date(),
    })
    .where(eq(schema.replies.id, replyId))
    .returning();

  if (!row) throw new Error("Could not save the reply.");

  await audit(tx, {
    organizationId,
    actorUserId,
    action: "reply.edited",
    replyId,
    meta: { reviewId: row.reviewId, length: text.length, aiGenerated: row.aiGenerated },
  });

  return row;
}

/** Records a human signing off on the exact text currently stored. */
export async function approveReply(args: {
  tx: TenantDatabase;
  organizationId: string;
  actorUserId: string;
  replyId: string;
  now?: Date;
}): Promise<ReplyRow> {
  const { tx, organizationId, actorUserId, replyId, now = new Date() } = args;

  const [row] = await tx
    .update(schema.replies)
    .set({
      status: "approved",
      approvedByUserId: actorUserId,
      approvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.replies.organizationId, organizationId),
        eq(schema.replies.id, replyId),
        // Only a draft can be approved. Guarding in the WHERE rather than after
        // a read closes the window where two people approve at once.
        eq(schema.replies.status, "draft"),
      ),
    )
    .returning();

  if (!row) {
    throw new ReplyError("That draft is not awaiting approval.", "wrong_status");
  }

  await audit(tx, {
    organizationId,
    actorUserId,
    action: "reply.approved",
    replyId,
    meta: { reviewId: row.reviewId, aiGenerated: row.aiGenerated, edited: row.edited },
  });

  return row;
}

export type PostOutcome =
  | { ok: true; reply: ReplyRow }
  | { ok: false; reply: ReplyRow; reason: string; retryable: boolean };

/**
 * Publishes an approved reply through the source's connector.
 *
 * The irreversible step, so it checks everything again rather than trusting
 * what the caller believed a moment ago: that the reply is approved, that the
 * review's source still has a live connection, and that the connector actually
 * declares an API reply capability.
 *
 * **A platform rejection is returned, not thrown.** Everything here runs inside
 * one tenant transaction, so throwing after writing `status = 'failed'` would
 * roll that write back — losing both the reason the owner needs to see and the
 * vacated live slot that lets them try again. Programmer errors (wrong status,
 * missing connection, a source that cannot reply) still throw, because there is
 * nothing to record and nothing for the owner to act on.
 */
export async function postReply(args: {
  tx: TenantDatabase;
  organizationId: string;
  actorUserId: string;
  replyId: string;
  now?: Date;
}): Promise<PostOutcome> {
  const { tx, organizationId, actorUserId, replyId, now = new Date() } = args;

  const [reply] = await tx
    .select()
    .from(schema.replies)
    .where(and(eq(schema.replies.organizationId, organizationId), eq(schema.replies.id, replyId)))
    // Serialize concurrent posts of the same row: two clicks must not become
    // two replies on the platform.
    .for("update")
    .limit(1);

  if (!reply) throw new ReplyError("That reply does not exist.", "not_found");
  if (reply.status !== "approved") {
    throw new ReplyError("Only an approved reply can be posted.", "wrong_status");
  }

  const review = await loadReview(tx, organizationId, reply.reviewId);

  const [connectionRow] = await tx
    .select()
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.organizationId, organizationId),
        eq(schema.connections.locationId, review.locationId),
        eq(schema.connections.provider, review.source),
      ),
    )
    .limit(1);

  if (!connectionRow) {
    throw new ReplyError(
      "The source this review came from is no longer connected.",
      "no_connection",
    );
  }

  const connector = getConnector(review.source);
  if (connector.capabilities.reply !== "api" || !connector.postReply) {
    // The UI reads the same capability, so reaching here means the source
    // changed under a page that was already open.
    throw new ReplyError(
      `Replies cannot be posted to ${review.source} through the API.`,
      "cannot_reply",
    );
  }

  const result = await connector.postReply(
    toConnection(connectionRow),
    review.sourceReviewId,
    reply.text,
  );

  if (!result.ok) {
    // `failed` frees the live slot, so the owner can write a different reply.
    const [failed] = await tx
      .update(schema.replies)
      .set({ status: "failed", lastError: result.reason, updatedAt: now })
      .where(eq(schema.replies.id, replyId))
      .returning();

    await audit(tx, {
      organizationId,
      actorUserId,
      action: "reply.post_failed",
      replyId,
      meta: { reviewId: reply.reviewId, reason: result.reason, retryable: result.retryable },
    });

    log.warn(
      { organizationId, replyId, provider: review.source, reason: result.reason },
      "Reply post rejected by the platform",
    );

    if (!failed) throw new Error("Could not record the failed reply.");
    return { ok: false, reply: failed, reason: result.reason, retryable: result.retryable };
  }

  const [row] = await tx
    .update(schema.replies)
    .set({
      status: "posted",
      postedAt: now,
      externalId: result.externalId ?? null,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(schema.replies.id, replyId))
    .returning();

  if (!row) throw new Error("Could not record the posted reply.");

  await audit(tx, {
    organizationId,
    actorUserId,
    action: "reply.posted",
    replyId,
    meta: {
      reviewId: reply.reviewId,
      provider: review.source,
      externalId: result.externalId ?? null,
      aiGenerated: reply.aiGenerated,
      edited: reply.edited,
    },
  });

  log.info(
    { organizationId, replyId, provider: review.source, externalId: result.externalId },
    "Reply posted",
  );

  return { ok: true, reply: row };
}

/** Deletes a draft, freeing the review for a fresh attempt. */
export async function discardReply(args: {
  tx: TenantDatabase;
  organizationId: string;
  actorUserId: string;
  replyId: string;
}): Promise<void> {
  const { tx, organizationId, actorUserId, replyId } = args;

  const rows = await tx
    .delete(schema.replies)
    .where(
      and(
        eq(schema.replies.organizationId, organizationId),
        eq(schema.replies.id, replyId),
        // A posted reply is a public fact; deleting the record would not
        // unpublish it, it would only lose the trail.
        sql`${schema.replies.status} in ('draft', 'approved', 'failed')`,
      ),
    )
    .returning({ id: schema.replies.id, reviewId: schema.replies.reviewId });

  const removed = rows[0];
  if (!removed) throw new ReplyError("That draft does not exist.", "not_found");

  await audit(tx, {
    organizationId,
    actorUserId,
    action: "reply.discarded",
    replyId,
    meta: { reviewId: removed.reviewId },
  });
}

/** Statuses that occupy the live slot — exported for callers building filters. */
export { LIVE_STATUSES };
