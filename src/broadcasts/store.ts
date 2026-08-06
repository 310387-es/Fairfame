import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/client.ts";
import { contactFiltersToRecord } from "../contacts/filters.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { audienceFilters, segmentFilters } from "./audience.ts";

/**
 * Reading and writing broadcasts (P4-T4).
 *
 * The tenant-scoped data layer for the screen. Nothing here sends anything —
 * `./pipeline.ts` owns that, and keeping the two apart is what lets the sweep
 * and a "send now" button be the same code path.
 */

export const broadcastNameSchema = z.string().trim().min(1).max(120);

export const broadcastInputSchema = z
  .object({
    name: broadcastNameSchema,
    kind: z.enum(["review_request", "survey", "message"]),
    channel: z.enum(["email", "sms", "whatsapp"]),
    segmentId: z.uuid(),
    campaignId: z.uuid().nullable(),
    surveyId: z.uuid().nullable(),
    templateName: z.string().max(80).nullable(),
    templateValues: z.array(z.string().max(500)).max(10),
    /** ISO. Null sends on the next explicit "send now". */
    scheduledAt: z.string().datetime().nullable(),
  })
  .refine((value) => value.kind !== "review_request" || value.campaignId !== null, {
    message: "A review-request broadcast needs a campaign.",
    path: ["campaignId"],
  })
  .refine((value) => value.kind !== "survey" || value.surveyId !== null, {
    message: "A survey broadcast needs a survey.",
    path: ["surveyId"],
  })
  .refine((value) => value.kind !== "message" || value.templateName !== null, {
    message: "A message broadcast needs a template.",
    path: ["templateName"],
  })
  .refine((value) => value.kind !== "survey" || value.channel === "email", {
    message: "Surveys can only be sent by email.",
    path: ["channel"],
  })
  .refine((value) => value.kind !== "message" || value.channel !== "email", {
    message: "A message goes out on WhatsApp or SMS, not email.",
    path: ["channel"],
  });

export type BroadcastInput = z.infer<typeof broadcastInputSchema>;

export class BroadcastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BroadcastError";
  }
}

export type BroadcastRow = {
  id: string;
  name: string;
  kind: "review_request" | "survey" | "message";
  channel: string;
  status: "draft" | "scheduled" | "sending" | "sent" | "cancelled";
  segmentId: string | null;
  segmentName: string | null;
  scheduledAt: Date | null;
  finishedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
};

export type BroadcastSummary = BroadcastRow & {
  audience: number;
  sent: number;
  refused: number;
  failed: number;
};

export async function listBroadcasts(
  tx: TenantDatabase,
  organizationId: string,
): Promise<BroadcastSummary[]> {
  const rows = await tx
    .select({
      id: schema.broadcasts.id,
      name: schema.broadcasts.name,
      kind: schema.broadcasts.kind,
      channel: schema.broadcasts.channel,
      status: schema.broadcasts.status,
      segmentId: schema.broadcasts.segmentId,
      segmentName: schema.contactSegments.name,
      scheduledAt: schema.broadcasts.scheduledAt,
      finishedAt: schema.broadcasts.finishedAt,
      failureReason: schema.broadcasts.failureReason,
      createdAt: schema.broadcasts.createdAt,
      // Counted here rather than stored on the broadcast: a stored tally is a
      // second number that can disagree with the rows it counts.
      audience: sql<number>`(
        select count(*)::int from ${schema.broadcastRecipients} r
         where r.broadcast_id = ${schema.broadcasts.id}
      )`.mapWith(Number),
      sent: sql<number>`(
        select count(*)::int from ${schema.broadcastRecipients} r
         where r.broadcast_id = ${schema.broadcasts.id} and r.status = 'sent'
      )`.mapWith(Number),
      refused: sql<number>`(
        select count(*)::int from ${schema.broadcastRecipients} r
         where r.broadcast_id = ${schema.broadcasts.id} and r.status = 'refused'
      )`.mapWith(Number),
      failed: sql<number>`(
        select count(*)::int from ${schema.broadcastRecipients} r
         where r.broadcast_id = ${schema.broadcasts.id} and r.status = 'failed'
      )`.mapWith(Number),
    })
    .from(schema.broadcasts)
    .leftJoin(schema.contactSegments, eq(schema.contactSegments.id, schema.broadcasts.segmentId))
    .where(eq(schema.broadcasts.organizationId, organizationId))
    .orderBy(desc(schema.broadcasts.createdAt));

  return rows;
}

export async function getBroadcast(
  tx: TenantDatabase,
  organizationId: string,
  broadcastId: string,
): Promise<BroadcastSummary | null> {
  const all = await listBroadcasts(tx, organizationId);
  return all.find((row) => row.id === broadcastId) ?? null;
}

export type RecipientRow = {
  contactId: string;
  name: string | null;
  email: string | null;
  status: "pending" | "sent" | "refused" | "failed";
  refusalReason: string | null;
  /** Whether the ask produced what it was asking for. */
  converted: boolean;
};

/**
 * Who it went to, and whether it worked.
 *
 * **Conversion is read from the funnel it points at, never copied.**
 * `review_requests.submitted_at` and `survey_responses.answered_at` already
 * mean "they did the thing"; a `converted` column here would be a second
 * number able to disagree with them, and it would have to be kept up to date by
 * something watching two other tables.
 */
export async function listRecipients(
  tx: TenantDatabase,
  organizationId: string,
  broadcastId: string,
  limit = 500,
): Promise<RecipientRow[]> {
  const rows = await tx
    .select({
      contactId: schema.broadcastRecipients.contactId,
      name: schema.contacts.name,
      email: schema.contacts.email,
      status: schema.broadcastRecipients.status,
      refusalReason: schema.broadcastRecipients.refusalReason,
      submittedAt: schema.reviewRequests.submittedAt,
      answeredAt: schema.surveyResponses.answeredAt,
      messageStatus: schema.messages.status,
    })
    .from(schema.broadcastRecipients)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.broadcastRecipients.contactId))
    .leftJoin(
      schema.reviewRequests,
      eq(schema.reviewRequests.id, schema.broadcastRecipients.reviewRequestId),
    )
    .leftJoin(
      schema.surveyResponses,
      eq(schema.surveyResponses.id, schema.broadcastRecipients.surveyResponseId),
    )
    .leftJoin(schema.messages, eq(schema.messages.id, schema.broadcastRecipients.messageId))
    .where(
      and(
        eq(schema.broadcastRecipients.organizationId, organizationId),
        eq(schema.broadcastRecipients.broadcastId, broadcastId),
      ),
    )
    .orderBy(schema.broadcastRecipients.createdAt)
    .limit(limit);

  return rows.map((row) => ({
    contactId: row.contactId,
    name: row.name,
    email: row.email,
    status: row.status,
    refusalReason: row.refusalReason,
    converted:
      row.submittedAt !== null ||
      row.answeredAt !== null ||
      // A message "converts" when the customer saw it. There is nothing else
      // to measure: a template does not ask for anything countable.
      row.messageStatus === "read",
  }));
}

/**
 * Creates a broadcast, snapshotting the audience it was aimed at.
 *
 * The segment's filter is copied onto the row because a segment is a live
 * query: re-resolving it at send time would answer a different question from
 * the one the business saw when they pressed the button. The *people* are
 * resolved at send time under the creator's scope — see `./pipeline.ts` — but
 * the *question* is fixed here.
 */
export async function createBroadcast(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
  input: BroadcastInput,
): Promise<{ id: string }> {
  const filters = await segmentFilters(tx, organizationId, input.segmentId);
  if (!filters) throw new BroadcastError("That segment does not exist.");

  await assertOwned(tx, organizationId, input);

  const [row] = await tx
    .insert(schema.broadcasts)
    .values({
      organizationId,
      name: input.name,
      kind: input.kind,
      channel: input.channel,
      segmentId: input.segmentId,
      audience: contactFiltersToRecord(filters),
      campaignId: input.campaignId,
      surveyId: input.surveyId,
      templateName: input.templateName,
      templateValues: input.templateValues,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      status: input.scheduledAt ? "scheduled" : "draft",
      createdByUserId: userId,
    })
    .returning({ id: schema.broadcasts.id });

  if (!row) throw new BroadcastError("Could not create the broadcast.");
  return row;
}

/** Never trust an id from the browser: a foreign payload is a foreign send. */
async function assertOwned(
  tx: TenantDatabase,
  organizationId: string,
  input: BroadcastInput,
): Promise<void> {
  if (input.campaignId) {
    const [row] = await tx
      .select({ id: schema.campaigns.id })
      .from(schema.campaigns)
      .where(
        and(
          eq(schema.campaigns.organizationId, organizationId),
          eq(schema.campaigns.id, input.campaignId),
        ),
      )
      .limit(1);
    if (!row) throw new BroadcastError("That campaign does not exist.");
  }

  if (input.surveyId) {
    const [row] = await tx
      .select({ id: schema.surveys.id })
      .from(schema.surveys)
      .where(
        and(
          eq(schema.surveys.organizationId, organizationId),
          eq(schema.surveys.id, input.surveyId),
        ),
      )
      .limit(1);
    if (!row) throw new BroadcastError("That survey does not exist.");
  }
}

/**
 * Cancels a broadcast that has not gone out.
 *
 * The status is in the WHERE clause, so cancelling one that is mid-send does
 * nothing rather than half-stopping it — a send that has started has already
 * put messages in front of people, and pretending otherwise would make the
 * record wrong.
 */
export async function cancelBroadcast(
  tx: TenantDatabase,
  organizationId: string,
  broadcastId: string,
  now = new Date(),
): Promise<boolean> {
  const rows = await tx
    .update(schema.broadcasts)
    .set({ status: "cancelled", finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.broadcasts.organizationId, organizationId),
        eq(schema.broadcasts.id, broadcastId),
        sql`${schema.broadcasts.status} in ('draft', 'scheduled')`,
      ),
    )
    .returning({ id: schema.broadcasts.id });

  return rows.length > 0;
}

/** The filter a broadcast was queued with, for showing what it aimed at. */
export function storedAudience(row: { audience: unknown }) {
  return audienceFilters(row.audience);
}
