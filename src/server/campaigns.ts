"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withAuthenticatedTenant } from "@/auth/session";
import { createCampaign } from "@/collect/campaigns";
import {
  MAX_RECIPIENTS_PER_SEND,
  parseCreateCampaign,
  parseRecipientList,
  sendRequestsSchema,
} from "@/collect/input";
import { sendReviewRequests } from "@/collect/requests";
import { schema } from "@/db/client";
import { childLogger } from "@/lib/logger";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Campaign and review-request mutations.
 *
 * Same two gates as every other mutation: role first (creating a campaign or
 * emailing customers is admin work), then entitlement — `requests_per_month`
 * is checked inside the send's own transaction, not here, so the count cannot
 * drift between the check and the write.
 */

const log = childLogger({ module: "server/campaigns" });

export async function createCampaignAction(formData: FormData): Promise<ActionResult> {
  const parsed = parseCreateCampaign(formData);

  if (!parsed.success) {
    return invalidInput(parsed.error, parsed.error.issues[0]?.message ?? "Invalid input.");
  }

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        const [location] = await tx
          .select({ id: schema.locations.id })
          .from(schema.locations)
          .where(eq(schema.locations.id, parsed.data.locationId))
          .limit(1);

        // RLS would hide another tenant's location anyway; this turns a silent
        // failure into a sentence.
        if (!location) throw new Error("That location does not exist.");

        await createCampaign(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          input: parsed.data,
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/requests");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "createCampaign failed");
    return toActionResult(error);
  }
}

export type SendRequestsResult = ActionResult<{
  sent: number;
  failed: number;
  skipped: number;
  invalid: string[];
}>;

/**
 * Emails a review request to a pasted list of addresses.
 *
 * Invalid addresses are reported rather than silently dropped: an owner who
 * mistypes one customer's email should learn that nobody wrote to them.
 */
export async function sendRequestsAction(formData: FormData): Promise<SendRequestsResult> {
  const campaignId = String(formData.get("campaignId") ?? "");
  const { recipients, invalid } = parseRecipientList(String(formData.get("recipients") ?? ""));

  const parsed = sendRequestsSchema.safeParse({ campaignId, recipients });
  if (!parsed.success) {
    return invalidInput(
      parsed.error,
      recipients.length > MAX_RECIPIENTS_PER_SEND
        ? `Send to at most ${MAX_RECIPIENTS_PER_SEND} people at a time.`
        : "Add at least one valid email address.",
    );
  }

  try {
    const actor = await withAuthenticatedTenant(async (_tx, actor) => actor, {
      minimumRole: "admin",
    });

    const outcome = await sendReviewRequests({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      campaignId: parsed.data.campaignId,
      recipients: parsed.data.recipients,
    });

    revalidatePath("/requests");
    return {
      ok: true,
      sent: outcome.sent,
      failed: outcome.failed,
      skipped: outcome.skipped.length,
      invalid,
    };
  } catch (error) {
    log.warn({ err: error }, "sendRequests failed");
    return toActionResult(error);
  }
}

/** Stops a campaign accepting submissions. Its link starts returning "closed". */
export async function archiveCampaignAction(input: { campaignId: string }): Promise<ActionResult> {
  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        const [row] = await tx
          .update(schema.campaigns)
          .set({ status: "archived", updatedAt: new Date() })
          .where(eq(schema.campaigns.id, input.campaignId))
          .returning({ id: schema.campaigns.id });

        if (!row) throw new Error("That campaign does not exist.");

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "campaign.archived",
          entity: `campaign:${row.id}`,
          meta: {},
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/requests");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "archiveCampaign failed");
    return toActionResult(error);
  }
}
