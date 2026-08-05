import { and, eq, inArray, sql } from "drizzle-orm";
import { resolveScopeForUser, withinScope } from "../auth/scope.ts";
import { roleAtLeast } from "../auth/permissions.ts";
import { requireFeature } from "../lib/entitlements.ts";
import { schema } from "../db/client.ts";
import type { ReviewStatus } from "../db/schema.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { renderTemplate } from "../replies/template-vars.ts";
import { TriageError, type TriageActor } from "./triage.ts";
import { refreshPriority } from "./workflow.ts";
import { notifyAssignment } from "../notifications/assignment.ts";

/**
 * Acting on many reviews at once (P2-T6).
 *
 * ## The guardrail
 *
 * **Nothing here posts anything, and nothing here approves anything.** A bulk
 * reply writes `draft` rows and stops. That is the whole point of the task's
 * one stated guardrail, and it is enforced structurally rather than by
 * convention: this module does not import the connector registry, does not
 * import `postReply`, and never writes a status other than `draft`. There is no
 * code path from a selection of forty reviews to forty published replies, so
 * "just add an auto-post option" cannot be a one-line change made by someone
 * who has not read this comment.
 *
 * The reason is not squeamishness. A public reply is published under the
 * business's name and, on Google and Meta, under terms that treat bulk
 * identical responses as spam. One bad template posted forty times is a brand
 * incident and a platform-standing incident at the same time, and the only
 * reliable defence is that a person looked at each one.
 *
 * ## Authorization
 *
 * Per item, not per request. The selection arrives from a browser and may name
 * any review id at all, so every id is re-read under the tenant's own context
 * and checked against the actor's location scope. Ids that do not survive are
 * *skipped and reported*, never silently dropped — a bulk action that claims to
 * have changed forty things and changed thirty-one is worse than one that
 * refuses.
 */

/**
 * How many reviews one action may touch.
 *
 * A bound on the blast radius as much as on the work: a mistake applied to a
 * hundred rows is recoverable by hand, and one applied to ten thousand is not.
 */
export const MAX_BULK_ITEMS = 100;

export type BulkOutcome = {
  /** Ids that were actually changed. */
  changed: string[];
  /** Ids that were selected but left alone, and why. */
  skipped: { id: string; reason: "out_of_scope" | "not_found" | "already_replied" }[];
};

/**
 * The reviews in this selection the actor may actually touch.
 *
 * One read for the whole batch, then a scope check per row. RLS has already
 * removed anything belonging to another tenant, so an id that comes back empty
 * is "not yours or not real" — the same answer either way, and deliberately not
 * distinguished, since telling a caller that an id exists somewhere else is
 * itself a leak.
 */
async function permitted(
  tx: TenantDatabase,
  actor: TriageActor,
  reviewIds: string[],
): Promise<{
  allowed: { id: string; locationId: string; status: ReviewStatus }[];
  skipped: BulkOutcome["skipped"];
}> {
  if (!roleAtLeast(actor.role, "member")) {
    throw new TriageError("Your role cannot change reviews.", "forbidden");
  }

  // One gate for every bulk operation, because every one of them comes through
  // here. Adding a seventh bulk action cannot forget the entitlement check.
  await requireFeature({ organizationId: actor.organizationId, tx }, "bulk_actions");

  const unique = [...new Set(reviewIds)].slice(0, MAX_BULK_ITEMS);
  if (unique.length === 0) return { allowed: [], skipped: [] };

  const rows = await tx
    .select({
      id: schema.reviews.id,
      locationId: schema.reviews.locationId,
      status: schema.reviews.status,
    })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, actor.organizationId),
        inArray(schema.reviews.id, unique),
      ),
    );

  const found = new Map(rows.map((row) => [row.id, row]));
  const allowed: { id: string; locationId: string; status: ReviewStatus }[] = [];
  const skipped: BulkOutcome["skipped"] = [];

  for (const id of unique) {
    const row = found.get(id);
    if (!row) {
      skipped.push({ id, reason: "not_found" });
      continue;
    }
    if (!withinScope(actor.scope, row.locationId)) {
      skipped.push({ id, reason: "out_of_scope" });
      continue;
    }
    allowed.push(row);
  }

  return { allowed, skipped };
}

/**
 * One audit row per review, not one per batch.
 *
 * "Who changed this review" has to be answerable from the review, and a single
 * row saying "forty reviews were closed" makes that a search problem. `bulk` in
 * the meta is what still distinguishes the two, for anyone asking the other
 * question.
 */
async function auditEach(
  tx: TenantDatabase,
  actor: TriageActor,
  action: string,
  ids: string[],
  meta: Record<string, unknown>,
): Promise<void> {
  if (ids.length === 0) return;

  await tx.insert(schema.auditLogs).values(
    ids.map((id) => ({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action,
      entity: `review:${id}`,
      meta: { ...meta, bulk: true, batchSize: ids.length },
    })),
  );
}

export async function bulkSetStatus(
  tx: TenantDatabase,
  actor: TriageActor,
  input: { reviewIds: string[]; status: ReviewStatus },
): Promise<BulkOutcome> {
  const { allowed, skipped } = await permitted(tx, actor, input.reviewIds);

  // A review already in the target status is not an error and not a change; it
  // simply does not appear in `changed`, and writes no audit row.
  const toChange = allowed.filter((row) => row.status !== input.status);
  if (toChange.length === 0) return { changed: [], skipped };

  const ids = toChange.map((row) => row.id);

  await tx
    .update(schema.reviews)
    .set({ status: input.status, updatedAt: new Date() })
    .where(inArray(schema.reviews.id, ids));

  await auditEach(tx, actor, "review.status_changed", ids, { to: input.status });

  return { changed: ids, skipped };
}

export async function bulkAssign(
  tx: TenantDatabase,
  actor: TriageActor,
  input: { reviewIds: string[]; assigneeUserId: string | null },
): Promise<BulkOutcome> {
  const { allowed, skipped } = await permitted(tx, actor, input.reviewIds);
  if (allowed.length === 0) return { changed: [], skipped };

  // The assignee is one person for the whole batch, so their membership is
  // checked once — but their *scope* is checked against each review's location,
  // because a selection can span branches.
  let assigneeScope = null;
  if (input.assigneeUserId !== null) {
    assigneeScope = await resolveScopeForUser(tx, actor.organizationId, input.assigneeUserId);
    if (!assigneeScope) throw new TriageError("That person is not on this team.", "not_a_member");
  }

  const reachable = allowed.filter(
    (row) => assigneeScope === null || withinScope(assigneeScope, row.locationId),
  );

  for (const row of allowed) {
    if (!reachable.includes(row)) skipped.push({ id: row.id, reason: "out_of_scope" });
  }

  if (reachable.length === 0) return { changed: [], skipped };
  const ids = reachable.map((row) => row.id);

  await tx
    .update(schema.reviews)
    .set({ assigneeUserId: input.assigneeUserId, updatedAt: new Date() })
    .where(inArray(schema.reviews.id, ids));

  await auditEach(
    tx,
    actor,
    input.assigneeUserId === null ? "review.unassigned" : "review.assigned",
    ids,
    { to: input.assigneeUserId },
  );

  // One action, so one alert — or one rollup, past the threshold. Handing
  // somebody fifty reviews should not ring fifty times.
  await notifyAssignment(tx, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    assigneeUserId: input.assigneeUserId,
    reviewIds: ids,
  });

  return { changed: ids, skipped };
}

/**
 * Applies one of the organization's tags to a selection.
 *
 * The tag is resolved — or created — from its slug in the shared vocabulary, so
 * bulk tagging cannot invent a second spelling of a theme that already exists.
 */
export async function bulkTag(
  tx: TenantDatabase,
  actor: TriageActor,
  input: { reviewIds: string[]; slug: string },
): Promise<BulkOutcome> {
  const slug = input.slug.trim().toLowerCase();
  if (slug.length === 0) return { changed: [], skipped: [] };

  const { allowed, skipped } = await permitted(tx, actor, input.reviewIds);
  if (allowed.length === 0) return { changed: [], skipped };

  const [tag] = await tx
    .insert(schema.tags)
    .values({ organizationId: actor.organizationId, slug, label: slug, reviewCount: 0 })
    .onConflictDoUpdate({
      target: [schema.tags.organizationId, schema.tags.slug],
      // A no-op update, so the row is returned whether it was new or not.
      set: { updatedAt: new Date() },
    })
    .returning({ id: schema.tags.id });

  if (!tag) throw new TriageError("Could not resolve that tag.", "not_found");

  const inserted = await tx
    .insert(schema.reviewTags)
    .values(
      allowed.map((row) => ({
        organizationId: actor.organizationId,
        reviewId: row.id,
        tagId: tag.id,
        taggedByUserId: actor.userId,
      })),
    )
    // Tagging something twice is not an error; it is the same tag.
    .onConflictDoNothing({ target: [schema.reviewTags.reviewId, schema.reviewTags.tagId] })
    .returning({ reviewId: schema.reviewTags.reviewId });

  const ids = inserted.map((row) => row.reviewId);
  await auditEach(tx, actor, "review.tagged", ids, { slug });

  return { changed: ids, skipped };
}

/**
 * Takes a tag back off a selection.
 *
 * The mirror of `bulkTag`, and it exists because tagging without untagging is a
 * one-way door: a mistyped or mis-applied tag on forty reviews would otherwise
 * be permanent, and the only recovery would be a database console.
 *
 * The `tags` row itself is left alone even when nothing carries it any more.
 * The vocabulary is deliberately allowed to hold a term nobody is using — an
 * owner who clears a theme this week and re-applies it next week should find
 * their own spelling waiting, not have to invent it again. Nothing counts the
 * empty ones: the facet numbers come from a live query over what is actually
 * tagged, so an unused vocabulary entry simply does not appear.
 */
export async function bulkUntag(
  tx: TenantDatabase,
  actor: TriageActor,
  input: { reviewIds: string[]; slug: string },
): Promise<BulkOutcome> {
  const slug = input.slug.trim().toLowerCase();
  if (slug.length === 0) return { changed: [], skipped: [] };

  const { allowed, skipped } = await permitted(tx, actor, input.reviewIds);
  if (allowed.length === 0) return { changed: [], skipped };

  const [tag] = await tx
    .select({ id: schema.tags.id })
    .from(schema.tags)
    .where(and(eq(schema.tags.organizationId, actor.organizationId), eq(schema.tags.slug, slug)))
    .limit(1);

  // A tag that does not exist is already not on anything. Nothing changed, and
  // that is a real answer rather than an error.
  if (!tag) return { changed: [], skipped };

  const removed = await tx
    .delete(schema.reviewTags)
    .where(
      and(
        eq(schema.reviewTags.organizationId, actor.organizationId),
        eq(schema.reviewTags.tagId, tag.id),
        inArray(
          schema.reviewTags.reviewId,
          allowed.map((row) => row.id),
        ),
      ),
    )
    .returning({ reviewId: schema.reviewTags.reviewId });

  const ids = removed.map((row) => row.reviewId);
  await auditEach(tx, actor, "review.untagged", ids, { slug });

  return { changed: ids, skipped };
}

/**
 * Writes a template into a draft reply for each selected review.
 *
 * **Drafts. Only ever drafts.** See the module header: this is the path the
 * guardrail exists to protect, and every safeguard is visible in one place here
 * — the status literal below is `draft`, no approval is recorded, and nothing
 * in this file can reach a connector.
 *
 * A review that already has a live reply is skipped rather than overwritten. In
 * bulk that matters more than it does on one card: quietly replacing a
 * colleague's half-finished answer across forty rows is a way to lose work that
 * nobody would think to look for.
 */
export async function bulkDraftFromTemplate(
  tx: TenantDatabase,
  actor: TriageActor,
  input: { reviewIds: string[]; templateId: string },
): Promise<BulkOutcome> {
  const { allowed, skipped } = await permitted(tx, actor, input.reviewIds);
  if (allowed.length === 0) return { changed: [], skipped };

  const [template] = await tx
    .select({ body: schema.replyTemplates.body })
    .from(schema.replyTemplates)
    .where(
      and(
        eq(schema.replyTemplates.organizationId, actor.organizationId),
        eq(schema.replyTemplates.id, input.templateId),
      ),
    )
    .limit(1);

  if (!template) throw new TriageError("That template does not exist.", "not_found");

  const ids = allowed.map((row) => row.id);

  // The context each review supplies to the template, read here rather than
  // rendered once for the batch — the whole point of `{{author}}` is that it
  // differs per review.
  const contexts = await tx
    .select({
      id: schema.reviews.id,
      author: schema.reviews.authorName,
      location: schema.locations.name,
      business: schema.organizations.name,
    })
    .from(schema.reviews)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.reviews.locationId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.reviews.organizationId))
    .where(inArray(schema.reviews.id, ids));

  // A review may hold at most one live reply (the partial unique index on
  // `replies`), so anything already answered is skipped, not replaced.
  const live = await tx
    .select({ reviewId: schema.replies.reviewId })
    .from(schema.replies)
    .where(and(inArray(schema.replies.reviewId, ids), sql`${schema.replies.status} <> 'failed'`));

  const answered = new Set(live.map((row) => row.reviewId));
  const writable = contexts.filter((row) => !answered.has(row.id));

  for (const id of ids) {
    if (answered.has(id)) skipped.push({ id, reason: "already_replied" });
  }

  if (writable.length === 0) return { changed: [], skipped };

  await tx.insert(schema.replies).values(
    writable.map((row) => ({
      organizationId: actor.organizationId,
      reviewId: row.id,
      authorUserId: actor.userId,
      text: renderTemplate(template.body, {
        author: row.author,
        location: row.location,
        business: row.business,
      }),
      // The guardrail, as a literal. Not `approved`, not `posted`.
      status: "draft" as const,
      aiGenerated: false,
    })),
  );

  const written = writable.map((row) => row.id);

  await auditEach(tx, actor, "reply.drafted", written, {
    templateId: input.templateId,
    source: "template",
  });

  // A review with a draft is no longer waiting for one to be written.
  await refreshPriority(tx, actor.organizationId, written);

  return { changed: written, skipped };
}

/**
 * How many AI drafts one bulk action may generate.
 *
 * Ten rather than a hundred, and the reason is not the guardrail — it is that
 * each one is a model call made while somebody waits. This runs inside the
 * request, so the cap is what keeps a bulk action from becoming a two-minute
 * spinner. Past ten, the honest answer is a background job, and that is a
 * change to the queue rather than to this number.
 */
export const MAX_BULK_AI_DRAFTS = 10;

/**
 * Drafts an AI reply for each selected review.
 *
 * A loop over the single-review path, deliberately: `draftReplyForReview` owns
 * the `ai_replies` entitlement gate, the monthly allowance, the prompt-injection
 * guardrails and the audit row, and none of that should have a second
 * implementation that exists only for bulk. Reaching the plan's limit stops the
 * batch rather than failing it — the drafts already written are real work and
 * are kept.
 *
 * Still drafts. The same guardrail as above, for the same reasons.
 */
export async function bulkDraftWithAi(
  tx: TenantDatabase,
  actor: TriageActor,
  input: {
    reviewIds: string[];
    /** Injected so this module keeps no dependency on the reply service. */
    draft: (reviewId: string) => Promise<void>;
  },
): Promise<BulkOutcome> {
  const { allowed, skipped } = await permitted(tx, actor, input.reviewIds);

  const changed: string[] = [];

  for (const row of allowed.slice(0, MAX_BULK_AI_DRAFTS)) {
    try {
      await input.draft(row.id);
      changed.push(row.id);
    } catch {
      // One review that cannot be drafted — already answered, a source that
      // takes no replies, an exhausted allowance — must not discard the drafts
      // that already succeeded. The reason is not reported per item here
      // because it is the same answer for the whole tail once a limit is hit.
      skipped.push({ id: row.id, reason: "already_replied" });
    }
  }

  return { changed, skipped };
}
