"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withAuthenticatedTenant } from "@/auth/session";
import { requireVerifiedSender } from "@/auth/verification";
import { resolveLocationScope } from "@/auth/scope";
import { createCampaign } from "@/collect/campaigns";
import { parseRecipientCsv } from "@/collect/csv";
import {
  MAX_RECIPIENTS_PER_SEND,
  parseCreateCampaign,
  parseRecipientList,
  sendRequestsSchema,
} from "@/collect/input";
import {
  sendReviewRequests,
  type DeliveryFailure,
  type SkippedRecipient,
} from "@/collect/requests";
import { EMPTY_CONTACT_FILTERS } from "@/contacts/filters";
import { listContacts } from "@/contacts/queries";
import { schema } from "@/db/client";
import { childLogger } from "@/lib/logger";
import { z } from "zod";
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

/** Enough to choose from without turning a picker into a data export. */
const PICKER_RESULTS = 20;

export type PickerContact = { id: string; name: string | null; address: string | null };

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

    revalidatePath("/get-reviews");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "createCampaign failed");
    return toActionResult(error);
  }
}

export type SendRequestsResult = ActionResult<{
  sent: number;
  failed: number;
  /**
   * Skipped, by reason. One number would be a lie now that there are two:
   * "they opted out" is settled and "we hold no address for them" is fixable,
   * and the summary used to call every skip an opt-out (W2.2).
   */
  skipped: number;
  skippedNoAddress: number;
  invalid: string[];
  /**
   * Who did not get it, one entry each (A22-B3).
   *
   * The action used to compute these counts and **throw `failures` away**, so
   * a send that reached nobody reported "0 sent · 1 failed" and kept the
   * reason — an İYS refusal, a bounced address, a number we do not hold — in
   * the database where the operator could not see it. A count says something
   * went wrong; only the reason says whether it is theirs to fix.
   */
  failures: DeliveryFailure[];
  /**
   * Nobody was written to, and no row implies we meant to: an opt-out, or no
   * address on this channel. Reported per person for the same reason.
   */
  skippedDetail: SkippedRecipient[];
}>;

/**
 * Emails a review request to a pasted list of addresses.
 *
 * Invalid addresses are reported rather than silently dropped: an owner who
 * mistypes one customer's email should learn that nobody wrote to them.
 */
export async function sendRequestsAction(formData: FormData): Promise<SendRequestsResult> {
  const campaignId = String(formData.get("campaignId") ?? "");

  /**
   * Two ways to name people, and a send may use either or both (W2.2).
   *
   * **Pasted or imported text** produces email recipients: an address may
   * belong to somebody we have never heard of, and the contact is created as
   * part of preparing the send. A CSV is tried first and the looser paste
   * parser second — a real export (`Ayşe Yılmaz,ayse@example.com`) came back
   * from the paste parser with every row invalid, because it splits on commas
   * and a name is not an address.
   *
   * **Picked contacts** produce `contactId` recipients, which is the only shape
   * a WhatsApp or SMS send can take: consent is recorded against a person, so
   * the gate has to be asked about somebody we already hold.
   */
  const rawText = String(formData.get("recipients") ?? "").trim();
  const csv = rawText === "" ? null : parseRecipientCsv(rawText);
  const pasted =
    csv && csv.recipients.length > 0
      ? {
          recipients: csv.recipients.map((entry) => ({ email: entry.email, name: entry.name })),
          invalid: csv.invalid,
        }
      : parseRecipientList(rawText);

  const contactIds = String(formData.get("contactIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  const recipients = [
    ...pasted.recipients,
    ...contactIds.map((contactId) => ({ contactId, name: null })),
  ];
  const invalid = pasted.invalid;

  const parsed = sendRequestsSchema.safeParse({ campaignId, recipients });
  if (!parsed.success) {
    return invalidInput(
      parsed.error,
      recipients.length > MAX_RECIPIENTS_PER_SEND
        ? `Send to at most ${MAX_RECIPIENTS_PER_SEND} people at a time.`
        : "Choose at least one contact, or add a valid email address.",
    );
  }

  try {
    const actor = await withAuthenticatedTenant(async (_tx, actor) => actor, {
      minimumRole: "admin",
    });

    // Nothing reaches a customer's inbox until the sender has proved their own
    // (P5-T4). Before the recipients are prepared, so a refusal creates no
    // contacts and no half-run — see `src/auth/verification.ts`.
    await requireVerifiedSender(actor.userId);

    const outcome = await sendReviewRequests({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      campaignId: parsed.data.campaignId,
      recipients: parsed.data.recipients,
    });

    revalidatePath("/get-reviews");
    return {
      ok: true,
      sent: outcome.sent,
      failed: outcome.failed,
      skipped: outcome.skipped.filter((entry) => entry.reason === "unsubscribed").length,
      skippedNoAddress: outcome.skipped.filter((entry) => entry.reason === "no_address").length,
      invalid,
      failures: outcome.failures,
      skippedDetail: outcome.skipped,
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

    revalidatePath("/get-reviews");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "archiveCampaign failed");
    return toActionResult(error);
  }
}

/**
 * Contacts you could send this campaign to (W2.2).
 *
 * The picker's only query, and it is deliberately **scoped exactly as
 * `/contacts` is** — through `contactsWhere`, from the member's own location
 * scope. A picker that could reach somebody the contacts screen hides would be
 * a way to read the customer list by typing into a search box, and it is
 * exactly the sort of endpoint nobody remembers to check.
 *
 * `channel` narrows to people who have the kind of address the campaign needs:
 * offering a contact with no phone number to a WhatsApp campaign would produce
 * a send that could only ever be skipped.
 */
export async function findRecipientsAction(input: {
  query: string;
  channel: "email" | "whatsapp" | "sms";
}): Promise<ActionResult<{ contacts: PickerContact[] }>> {
  const parsed = z
    .object({ query: z.string().trim().max(120), channel: z.enum(["email", "whatsapp", "sms"]) })
    .safeParse(input);

  if (!parsed.success) return invalidInput(parsed.error, "Invalid search.");

  try {
    const contacts = await withAuthenticatedTenant(async (tx, actor) => {
      const scope = await resolveLocationScope(tx, actor.organizationId, actor.userId, actor.role);

      const page = await listContacts({
        tx,
        organizationId: actor.organizationId,
        scope,
        filters: {
          ...EMPTY_CONTACT_FILTERS,
          query: parsed.data.query || null,
          // An email campaign needs an address; a messaging one needs a number.
          channel: parsed.data.channel === "email" ? "email" : "phone",
          // Somebody who has opted out cannot be asked, so offering them is
          // offering a row that will be skipped.
          subscription: "subscribed",
        },
        page: 1,
        pageSize: PICKER_RESULTS,
      });

      return page.rows.map((row) => ({
        id: row.id,
        name: row.name,
        address: parsed.data.channel === "email" ? row.email : row.phone,
      }));
    });

    return { ok: true, contacts };
  } catch (error) {
    log.warn({ err: error }, "findRecipients failed");
    return toActionResult(error);
  }
}
