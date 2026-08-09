import { and, eq, isNull } from "drizzle-orm";
import { resolveScopeForUser, withinScope, type LocationScope } from "../auth/scope.ts";
import { roleAtLeast, type Role } from "../auth/permissions.ts";
import { schema } from "../db/client.ts";
import type { ReviewStatus } from "../db/schema.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { refreshPriority } from "./workflow.ts";
import { notifyAssignment } from "../notifications/assignment.ts";

/**
 * Moving work through the inbox (P2-T4).
 *
 * Status and assignment, and nothing else. Both are small operations with the
 * same three obligations, which is why they live together rather than beside the
 * queries they change:
 *
 *   - **Authorization is checked here, not in the action.** A server action is a
 *     transport; putting the rule in it means the next caller — a bulk action in
 *     P2-T6, a job, an API — has to remember to repeat it.
 *   - **Location scope is part of authorization.** RLS keeps organizations
 *     apart and knows nothing about which branch a member works at, so "may this
 *     person touch this review" is only half-answered by the database.
 *   - **Every change is audit-logged.** `docs/06` §3 asks for it, and "who moved
 *     this to done" is exactly the question asked a week later, when nobody
 *     remembers.
 */

export type TriageErrorCode = "not_found" | "forbidden" | "out_of_scope" | "not_a_member";

export class TriageError extends Error {
  readonly code: TriageErrorCode;

  constructor(message: string, code: TriageErrorCode) {
    super(message);
    this.name = "TriageError";
    this.code = code;
  }
}

export type TriageActor = {
  organizationId: string;
  userId: string;
  role: Role;
  /** Resolved once per request and passed in, so one action is one scope read. */
  scope: LocationScope;
};

/**
 * The review, and the permission to touch it.
 *
 * A single read that answers both questions. Doing them separately invites the
 * version where the row is fetched, the caller forgets the scope check, and the
 * bug is invisible until a two-location tenant signs up.
 */
async function readForTriage(
  tx: TenantDatabase,
  actor: TriageActor,
  reviewId: string,
): Promise<{
  id: string;
  locationId: string;
  status: ReviewStatus;
  assigneeUserId: string | null;
}> {
  // A client may read their locations; they may not run the business's queue.
  if (!roleAtLeast(actor.role, "member")) {
    throw new TriageError("Your role cannot change reviews.", "forbidden");
  }

  const [review] = await tx
    .select({
      id: schema.reviews.id,
      locationId: schema.reviews.locationId,
      status: schema.reviews.status,
      assigneeUserId: schema.reviews.assigneeUserId,
    })
    .from(schema.reviews)
    .where(
      and(eq(schema.reviews.organizationId, actor.organizationId), eq(schema.reviews.id, reviewId)),
    )
    .limit(1);

  // RLS already hides another tenant's review; this turns a silent empty result
  // into a message that names the problem.
  if (!review) throw new TriageError("That review does not exist.", "not_found");

  if (!withinScope(actor.scope, review.locationId)) {
    throw new TriageError("That review belongs to a location you cannot see.", "out_of_scope");
  }

  return review;
}

async function audit(
  tx: TenantDatabase,
  actor: TriageActor,
  action: string,
  reviewId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await tx.insert(schema.auditLogs).values({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action,
    entity: `review:${reviewId}`,
    meta,
  });
}

/**
 * Moves a review through triage.
 *
 * Any status to any status, deliberately. The build plan writes the happy path
 * as `open → in_progress → done`, but a workflow that refuses to reopen a review
 * closed by mistake is a workflow people work around by writing a note
 * somewhere else. The audit log is what makes a wrong move recoverable, not a
 * state machine that forbids it.
 *
 * Setting the status a review already has is a no-op that writes nothing —
 * including no audit row, since a log of "changed done to done" is noise in the
 * one place noise is most expensive.
 */
export async function setReviewStatus(
  tx: TenantDatabase,
  actor: TriageActor,
  input: { reviewId: string; status: ReviewStatus },
): Promise<{ changed: boolean }> {
  const review = await readForTriage(tx, actor, input.reviewId);

  if (review.status === input.status) return { changed: false };

  await tx
    .update(schema.reviews)
    .set({ status: input.status, updatedAt: new Date() })
    .where(eq(schema.reviews.id, review.id));

  await audit(tx, actor, "review.status_changed", review.id, {
    from: review.status,
    to: input.status,
    locationId: review.locationId,
  });

  return { changed: true };
}

/**
 * Gives a review to somebody, or takes it back.
 *
 * `assigneeUserId: null` unassigns. The assignee is checked against *their* own
 * scope, not the actor's: a manager who can see every branch must still not be
 * able to hand the Kadıköy queue to someone who only works at Beşiktaş, because
 * the result is an item that sits in a queue nobody can open.
 */
export async function assignReview(
  tx: TenantDatabase,
  actor: TriageActor,
  input: { reviewId: string; assigneeUserId: string | null },
): Promise<{ changed: boolean }> {
  const review = await readForTriage(tx, actor, input.reviewId);

  if (review.assigneeUserId === input.assigneeUserId) return { changed: false };

  if (input.assigneeUserId !== null) {
    const scope = await resolveScopeForUser(tx, actor.organizationId, input.assigneeUserId);

    if (!scope) {
      throw new TriageError("That person is not on this team.", "not_a_member");
    }
    if (!withinScope(scope, review.locationId)) {
      throw new TriageError("That person cannot see this location.", "out_of_scope");
    }
  }

  await tx
    .update(schema.reviews)
    .set({ assigneeUserId: input.assigneeUserId, updatedAt: new Date() })
    .where(eq(schema.reviews.id, review.id));

  await audit(
    tx,
    actor,
    input.assigneeUserId === null ? "review.unassigned" : "review.assigned",
    review.id,
    {
      from: review.assigneeUserId,
      to: input.assigneeUserId,
      locationId: review.locationId,
    },
  );

  // Tell the person who just inherited it. In the same transaction as the write,
  // so an assignment that rolls back takes its alert with it.
  await notifyAssignment(tx, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    assigneeUserId: input.assigneeUserId,
    reviewIds: [review.id],
  });

  return { changed: true };
}

/**
 * Records the moment a review was first answered.
 *
 * Called from the reply service when a reply reaches the platform. **Set once
 * and never moved**: it is the numerator of every response-time figure, so a
 * follow-up reply three days later must not overwrite the answer that actually
 * arrived within the hour. The `is null` in the predicate is what enforces that,
 * rather than a read-then-write that two concurrent posts could both pass.
 *
 * Also re-scores the review: a review that now has a live reply is no longer
 * waiting for one, and the triage queue should stop offering it first.
 */
export async function recordFirstResponse(
  tx: TenantDatabase,
  organizationId: string,
  reviewId: string,
  at: Date,
): Promise<void> {
  await tx
    .update(schema.reviews)
    .set({ firstResponseAt: at })
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.id, reviewId),
        // The whole rule, in the predicate: a row that already has a first
        // response is not matched, so there is nothing to overwrite.
        isNull(schema.reviews.firstResponseAt),
      ),
    );

  /**
   * Answering closes it — but only from `open` (A22-B5).
   *
   * The tester posted a reply and the review still said **Açık**, so the screen
   * disagreed with what he had just done. `reviews.status` is deliberately not
   * derived from reply state — the schema says so, and it is right: a review can
   * be `done` because somebody phoned the customer, and it can carry a posted
   * reply and still be open work because a promised refund has not happened.
   *
   * What resolves the two is *which* status. `open` is the arrival default that
   * nobody chose; `in_progress` and `ignored` are somebody's explicit decision,
   * and overwriting those would be the product arguing with a person who knows
   * something it does not. So the default advances and a choice is left alone.
   */
  await tx
    .update(schema.reviews)
    .set({ status: "done", updatedAt: at })
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.id, reviewId),
        eq(schema.reviews.status, "open"),
      ),
    );

  await refreshPriority(tx, organizationId, [reviewId]);
}
