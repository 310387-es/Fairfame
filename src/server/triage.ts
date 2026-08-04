"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolveLocationScope } from "@/auth/scope";
import { withAuthenticatedTenant } from "@/auth/session";
import { assignReview, setReviewStatus, TriageError } from "@/inbox/triage";
import { childLogger } from "@/lib/logger";
import { toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Triage actions (P2-T4).
 *
 * Thin: parse, resolve the caller's scope, delegate. The role rule, the location
 * rule and the audit trail live in `src/inbox/triage.ts`, so the bulk actions in
 * P2-T6 get the same enforcement by calling the same function rather than by
 * remembering the same checks.
 *
 * `minimumRole: "member"` here and a second role check inside the service is not
 * redundancy for its own sake: this one refuses the request, that one refuses
 * the *operation*, and only the second still applies when the caller is a job or
 * a future API token rather than a session.
 */

const log = childLogger({ module: "server/triage" });

const statusSchema = z.object({
  reviewId: z.uuid(),
  status: z.enum(["open", "in_progress", "done", "ignored"]),
});

const assignSchema = z.object({
  reviewId: z.uuid(),
  /** Null unassigns. */
  assigneeUserId: z.uuid().nullable(),
});

function toTriageResult(error: unknown): ActionResult {
  if (error instanceof TriageError) return { ok: false, error: error.message, code: error.code };
  return toActionResult(error);
}

export async function setReviewStatusAction(input: {
  reviewId: string;
  status: string;
}): Promise<ActionResult> {
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Unknown status." };

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        const scope = await resolveLocationScope(
          tx,
          actor.organizationId,
          actor.userId,
          actor.role,
        );

        await setReviewStatus(
          tx,
          { ...actor, scope },
          { reviewId: parsed.data.reviewId, status: parsed.data.status },
        );
      },
      { minimumRole: "member" },
    );

    revalidatePath("/inbox");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "setReviewStatus failed");
    return toTriageResult(error);
  }
}

export async function assignReviewAction(input: {
  reviewId: string;
  assigneeUserId: string | null;
}): Promise<ActionResult> {
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Unknown assignee." };

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        const scope = await resolveLocationScope(
          tx,
          actor.organizationId,
          actor.userId,
          actor.role,
        );

        await assignReview(
          tx,
          { ...actor, scope },
          { reviewId: parsed.data.reviewId, assigneeUserId: parsed.data.assigneeUserId },
        );
      },
      { minimumRole: "member" },
    );

    revalidatePath("/inbox");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "assignReview failed");
    return toTriageResult(error);
  }
}
