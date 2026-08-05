"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolveLocationScope } from "@/auth/scope";
import { withAuthenticatedTenant } from "@/auth/session";
import { MAX_RECIPIENTS_PER_SEND, parseRecipientList } from "@/collect/input";
import { schema } from "@/db/client";
import { requireFeature } from "@/lib/entitlements";
import { childLogger } from "@/lib/logger";
import { toActionResult, type ActionResult } from "@/server/action-result";
import { createSurvey, surveyInputSchema, updateSurvey } from "@/surveys/store";
import { sendSurveyInvites, type RefusedRecipient } from "@/surveys/send";

/**
 * Survey mutations (P4-T2).
 *
 * Gated on the `surveys` entitlement and on role, like every other mutation in
 * the product. The send is additionally gated **per recipient** by
 * `checkSendAllowed`, which is not something an action can do on behalf of a
 * whole list — see `src/surveys/send.ts`. What this file adds is that the
 * refusals come back to the screen with their reasons intact rather than being
 * flattened into "3 not sent".
 */

const log = childLogger({ module: "server/surveys" });

export async function createSurveyAction(
  input: unknown,
): Promise<ActionResult<{ id?: string; slug?: string }>> {
  const parsed = surveyInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid survey." };
  }

  try {
    const created = await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "surveys");
        const scope = await resolveLocationScope(
          tx,
          actor.organizationId,
          actor.userId,
          actor.role,
        );

        const row = await createSurvey(tx, actor.organizationId, scope, parsed.data);

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "survey.created",
          entity: `survey:${row.id}`,
          meta: { type: parsed.data.type, slug: row.slug },
        });

        return row;
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/surveys");
    return { ok: true, id: created.id, slug: created.slug };
  } catch (error) {
    log.warn({ err: error }, "createSurvey failed");
    return toActionResult(error);
  }
}

export async function updateSurveyAction(input: unknown): Promise<ActionResult> {
  // The type is deliberately absent from the update schema, not merely ignored:
  // changing it would reinterpret every answer already collected — a stored 7 is
  // a passive on NPS and off the scale entirely on CSAT.
  const parsed = surveyInputSchema.omit({ type: true }).extend({ id: z.uuid() }).safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid survey." };
  }

  const { id, ...fields } = parsed.data;

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "surveys");
        const scope = await resolveLocationScope(
          tx,
          actor.organizationId,
          actor.userId,
          actor.role,
        );

        await updateSurvey(tx, actor.organizationId, scope, id, fields);

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "survey.updated",
          entity: `survey:${id}`,
          meta: { status: fields.status },
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/surveys");
    revalidatePath(`/surveys/${id}`);
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "updateSurvey failed");
    return toActionResult(error);
  }
}

export type SendSurveyResult = ActionResult<{
  sent?: number;
  failed?: number;
  invalid?: string[];
  refused?: RefusedRecipient[];
  failures?: { email: string; reason: string }[];
}>;

/**
 * Sends a survey to a pasted list of addresses.
 *
 * The same input shape as a review-request send, so the two screens behave the
 * same way — but the outcome carries `refused`, which review requests have no
 * concept of. That is the visible edge of `docs/20`'s first compliance rule: a
 * recipient with no İYS permission is not silently dropped, they are reported
 * with the reason, because "nothing went out" and "nothing was allowed out" are
 * different problems and only one of them is the operator's to fix.
 */
export async function sendSurveyAction(input: {
  surveyId: string;
  recipients: string;
}): Promise<SendSurveyResult> {
  const parsed = z
    .object({ surveyId: z.uuid(), recipients: z.string().max(40_000) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input." };

  const { recipients, invalid } = parseRecipientList(parsed.data.recipients);

  if (recipients.length === 0) {
    return { ok: false, error: "No valid email addresses were found.", code: "no_recipients" };
  }
  if (recipients.length > MAX_RECIPIENTS_PER_SEND) {
    return {
      ok: false,
      error: `At most ${MAX_RECIPIENTS_PER_SEND} recipients per send.`,
      code: "too_many",
    };
  }

  try {
    const { organizationId, userId } = await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "surveys");
        return { organizationId: actor.organizationId, userId: actor.userId };
      },
      { minimumRole: "admin" },
    );

    const outcome = await sendSurveyInvites({
      organizationId,
      actorUserId: userId,
      surveyId: parsed.data.surveyId,
      recipients,
    });

    revalidatePath(`/surveys/${parsed.data.surveyId}`);

    return {
      ok: true,
      sent: outcome.sent,
      failed: outcome.failed,
      invalid,
      refused: outcome.refused,
      failures: outcome.failures,
    };
  } catch (error) {
    log.warn({ err: error }, "sendSurvey failed");
    return toActionResult(error);
  }
}
