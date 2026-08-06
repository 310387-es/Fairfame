"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolveLocationScope } from "@/auth/scope";
import { withAuthenticatedTenant } from "@/auth/session";
import {
  bulkAssign,
  bulkDraftFromTemplate,
  bulkDraftWithAi,
  bulkSetStatus,
  bulkTag,
  bulkUntag,
  MAX_BULK_ITEMS,
  type BulkOutcome,
} from "@/reviews/bulk";
import { TriageError } from "@/reviews/triage";
import { childLogger } from "@/lib/logger";
import { draftReplyForReview } from "@/replies/service";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Bulk actions (P2-T6).
 *
 * Every one of these is a thin wrapper: parse, resolve the caller's scope,
 * delegate to `src/inbox/bulk.ts`, report what was skipped. The authorization is
 * per item and it lives in that module, not here — so a future caller that is
 * not a form submission gets the same enforcement.
 *
 * **There is no bulk post action, and no bulk approve action.** That absence is
 * the feature. Bulk reply writes drafts; publishing stays a per-item decision in
 * the composer, where a person has read the words in front of them.
 */

const log = childLogger({ module: "server/bulk" });

const idsSchema = z.array(z.uuid()).min(1).max(MAX_BULK_ITEMS);

type BulkResult = ActionResult<{ changed: number; skipped: number }>;

function toBulkResult(error: unknown): BulkResult {
  if (error instanceof TriageError) return { ok: false, error: error.message, code: error.code };
  return toActionResult(error);
}

function report(outcome: BulkOutcome): BulkResult {
  return { ok: true, changed: outcome.changed.length, skipped: outcome.skipped.length };
}

/** Resolves the caller's scope once, then runs one bulk operation. */
async function runBulk(
  operation: (
    tx: Parameters<Parameters<typeof withAuthenticatedTenant>[0]>[0],
    actor: {
      organizationId: string;
      userId: string;
      role: "owner" | "admin" | "member" | "client";
      scope: Awaited<ReturnType<typeof resolveLocationScope>>;
    },
  ) => Promise<BulkOutcome>,
): Promise<BulkResult> {
  const outcome = await withAuthenticatedTenant(
    async (tx, actor) => {
      const scope = await resolveLocationScope(tx, actor.organizationId, actor.userId, actor.role);
      return operation(tx, { ...actor, scope });
    },
    { minimumRole: "member" },
  );

  revalidatePath("/reviews");
  return report(outcome);
}

export async function bulkSetStatusAction(input: {
  reviewIds: string[];
  status: string;
}): Promise<BulkResult> {
  const parsed = z
    .object({
      reviewIds: idsSchema,
      status: z.enum(["open", "in_progress", "done", "ignored"]),
    })
    .safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Nothing selected.");

  try {
    return await runBulk((tx, actor) => bulkSetStatus(tx, actor, parsed.data));
  } catch (error) {
    log.warn({ err: error }, "bulkSetStatus failed");
    return toBulkResult(error);
  }
}

export async function bulkAssignAction(input: {
  reviewIds: string[];
  assigneeUserId: string | null;
}): Promise<BulkResult> {
  const parsed = z
    .object({ reviewIds: idsSchema, assigneeUserId: z.uuid().nullable() })
    .safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Nothing selected.");

  try {
    return await runBulk((tx, actor) => bulkAssign(tx, actor, parsed.data));
  } catch (error) {
    log.warn({ err: error }, "bulkAssign failed");
    return toBulkResult(error);
  }
}

export async function bulkTagAction(input: {
  reviewIds: string[];
  slug: string;
}): Promise<BulkResult> {
  const parsed = z
    .object({ reviewIds: idsSchema, slug: z.string().trim().min(1).max(48) })
    .safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Give the tag a name.");

  try {
    return await runBulk((tx, actor) => bulkTag(tx, actor, parsed.data));
  } catch (error) {
    log.warn({ err: error }, "bulkTag failed");
    return toBulkResult(error);
  }
}

export async function bulkUntagAction(input: {
  reviewIds: string[];
  slug: string;
}): Promise<BulkResult> {
  const parsed = z
    .object({ reviewIds: idsSchema, slug: z.string().trim().min(1).max(48) })
    .safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Name the tag to remove.");

  try {
    return await runBulk((tx, actor) => bulkUntag(tx, actor, parsed.data));
  } catch (error) {
    log.warn({ err: error }, "bulkUntag failed");
    return toBulkResult(error);
  }
}

/**
 * Writes a template into a draft on each selected review.
 *
 * Drafts, never posts — see `src/inbox/bulk.ts`. What the caller gets back is a
 * count of drafts *waiting for someone to read them*, which is deliberately not
 * the same sentence as "replies sent".
 */
export async function bulkDraftFromTemplateAction(input: {
  reviewIds: string[];
  templateId: string;
}): Promise<BulkResult> {
  const parsed = z.object({ reviewIds: idsSchema, templateId: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Pick a template.");

  try {
    return await runBulk((tx, actor) => bulkDraftFromTemplate(tx, actor, parsed.data));
  } catch (error) {
    log.warn({ err: error }, "bulkDraftFromTemplate failed");
    return toBulkResult(error);
  }
}

export async function bulkDraftWithAiAction(input: { reviewIds: string[] }): Promise<BulkResult> {
  const parsed = z.object({ reviewIds: idsSchema }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Nothing selected.");

  try {
    return await runBulk((tx, actor) =>
      bulkDraftWithAi(tx, actor, {
        reviewIds: parsed.data.reviewIds,
        // The single-review path, reused rather than reimplemented: it owns the
        // entitlement gate, the allowance, the guardrails and the audit row.
        draft: (reviewId) =>
          draftReplyForReview({
            tx,
            organizationId: actor.organizationId,
            actorUserId: actor.userId,
            reviewId,
          }).then(() => undefined),
      }),
    );
  } catch (error) {
    log.warn({ err: error }, "bulkDraftWithAi failed");
    return toBulkResult(error);
  }
}
