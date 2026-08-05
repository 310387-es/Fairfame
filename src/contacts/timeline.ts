import { and, desc, eq } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { bandFor, type SurveyBand, type SurveyType } from "../surveys/scoring.ts";
import { listContactConsent } from "./consent.ts";

/**
 * One person's history with the business, in one list (P4-T1).
 *
 * `docs/20` asks for "reviews, requests, messages, surveys in one view", and the
 * value of that is not the individual rows — every one of them is already
 * readable somewhere else — but the **order**. "We asked her twice, she never
 * opened it, then she walked in and left two stars" is a sentence nobody can
 * assemble from four screens.
 *
 * Built as one loader per source, merged and sorted, rather than as a UNION.
 * The sources have almost nothing in common column-wise, a UNION would have to
 * flatten them to a lowest common denominator of id + timestamp + text, and the
 * screen wants a rating on a review and a channel on a request. The cost is a
 * handful of small indexed reads for one contact, which is what a profile page
 * is.
 *
 * **Every source here is a real record with a real timestamp.** That became
 * true at P4-T3: until then messages were the exception, approximated from the
 * two timestamps `whatsapp_conversations` keeps for the 24-hour window, so at
 * most two message events appeared and they *moved* rather than accumulated.
 * They are rows now.
 */

export type TimelineEvent =
  | {
      kind: "review";
      at: Date;
      reviewId: string;
      rating: number | null;
      text: string | null;
      source: string;
      itemType: string;
      locationName: string | null;
    }
  | {
      kind: "request_sent";
      at: Date;
      channel: string;
      campaignName: string | null;
      locationName: string | null;
    }
  | { kind: "request_opened"; at: Date; campaignName: string | null }
  | { kind: "request_failed"; at: Date; channel: string; reason: string | null }
  | {
      kind: "consent_granted";
      at: Date;
      consentType: "kvkk" | "iys";
      channel: string | null;
      source: string | null;
    }
  | { kind: "consent_revoked"; at: Date; consentType: "kvkk" | "iys"; channel: string | null }
  | { kind: "survey_sent"; at: Date; surveyName: string; channel: string }
  | {
      kind: "survey_answered";
      at: Date;
      surveyId: string;
      surveyName: string;
      surveyType: SurveyType;
      score: number;
      band: SurveyBand;
      comment: string | null;
      /** The private detractor follow-up, if they wrote one. Never public. */
      followUpComment: string | null;
    }
  | {
      kind: "message_in";
      at: Date;
      channel: string;
      body: string | null;
    }
  | {
      kind: "message_out";
      at: Date;
      channel: string;
      body: string | null;
      status: string;
      /** The basis it was sent under — `service` or `commercial`. */
      intent: string | null;
      failureReason: string | null;
    }
  | { kind: "unsubscribed"; at: Date }
  | { kind: "created"; at: Date };

/**
 * How far back one profile reads.
 *
 * A bound rather than a pager: a timeline is read from the top and the tail is
 * archaeology. If a contact ever has more history than this, the answer is a
 * filtered view rather than an infinite scroll of it.
 */
const MAX_EVENTS_PER_SOURCE = 50;

async function reviewAndRequestEvents(
  tx: TenantDatabase,
  organizationId: string,
  contactId: string,
): Promise<TimelineEvent[]> {
  const rows = await tx
    .select({
      requestId: schema.reviewRequests.id,
      channel: schema.reviewRequests.channel,
      status: schema.reviewRequests.status,
      sentAt: schema.reviewRequests.sentAt,
      openedAt: schema.reviewRequests.openedAt,
      submittedAt: schema.reviewRequests.submittedAt,
      failureReason: schema.reviewRequests.failureReason,
      requestedAt: schema.reviewRequests.createdAt,
      campaignName: schema.campaigns.name,
      locationName: schema.locations.name,
      reviewId: schema.reviews.id,
      rating: schema.reviews.rating,
      text: schema.reviews.text,
      source: schema.reviews.source,
      itemType: schema.reviews.itemType,
      postedAt: schema.reviews.postedAt,
    })
    .from(schema.reviewRequests)
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.reviewRequests.campaignId))
    .leftJoin(schema.locations, eq(schema.locations.id, schema.reviewRequests.locationId))
    .leftJoin(schema.reviews, eq(schema.reviews.id, schema.reviewRequests.reviewId))
    .where(
      and(
        eq(schema.reviewRequests.organizationId, organizationId),
        eq(schema.reviewRequests.contactId, contactId),
      ),
    )
    .orderBy(desc(schema.reviewRequests.createdAt))
    .limit(MAX_EVENTS_PER_SOURCE);

  const events: TimelineEvent[] = [];

  for (const row of rows) {
    // A walk-in submission has a `review_requests` row for bookkeeping but was
    // never sent to anybody — reporting it as "we asked them" would be false.
    if (row.sentAt) {
      events.push({
        kind: "request_sent",
        at: row.sentAt,
        channel: row.channel,
        campaignName: row.campaignName,
        locationName: row.locationName,
      });
    }

    if (row.openedAt) {
      events.push({ kind: "request_opened", at: row.openedAt, campaignName: row.campaignName });
    }

    if (row.status === "failed") {
      events.push({
        kind: "request_failed",
        // A failure has no stamp of its own; the ask's own timestamp is the
        // closest true thing, and it is never null.
        at: row.sentAt ?? row.requestedAt,
        channel: row.channel,
        reason: row.failureReason,
      });
    }

    if (row.reviewId) {
      events.push({
        kind: "review",
        // `posted_at` is when the customer wrote it; `submitted_at` is when our
        // form took it. They agree for first-party and the first is the truth.
        at: row.postedAt ?? row.submittedAt ?? row.requestedAt,
        reviewId: row.reviewId,
        rating: row.rating,
        text: row.text,
        source: row.source ?? "",
        itemType: row.itemType ?? "review",
        locationName: row.locationName,
      });
    }
  }

  return events;
}

async function consentEvents(
  tx: TenantDatabase,
  organizationId: string,
  contactId: string,
): Promise<TimelineEvent[]> {
  const records = await listContactConsent(tx, organizationId, contactId);
  const events: TimelineEvent[] = [];

  for (const record of records) {
    if (record.grantedAt) {
      events.push({
        kind: "consent_granted",
        at: record.grantedAt,
        consentType: record.type,
        channel: record.channel,
        source: record.source,
      });
    }
    // Both, when both happened. A withdrawal that hid the grant behind it would
    // lose the fact that permission was once given — which is the half a
    // business has to be able to prove.
    if (record.revokedAt) {
      events.push({
        kind: "consent_revoked",
        at: record.revokedAt,
        consentType: record.type,
        channel: record.channel,
      });
    }
  }

  return events;
}

/**
 * Surveys (P4-T2) — the source `docs/20` P4-T1 promised and T2 delivers.
 *
 * Two events from one row, because they are two different moments: we asked,
 * and they answered. A survey that was sent and ignored is exactly the thing a
 * manager wants to see beside a bad review a week later.
 *
 * The private follow-up travels with the answer rather than as an event of its
 * own: it has no timestamp of its own, and inventing one — the answer's, say —
 * would put a fabricated time on a customer's complaint.
 */
async function surveyEvents(
  tx: TenantDatabase,
  organizationId: string,
  contactId: string,
): Promise<TimelineEvent[]> {
  const rows = await tx
    .select({
      surveyId: schema.surveys.id,
      surveyName: schema.surveys.name,
      surveyType: schema.surveys.type,
      channel: schema.surveyResponses.channel,
      sentAt: schema.surveyResponses.sentAt,
      answeredAt: schema.surveyResponses.answeredAt,
      score: schema.surveyResponses.score,
      comment: schema.surveyResponses.comment,
      followUpComment: schema.surveyResponses.followUpComment,
    })
    .from(schema.surveyResponses)
    .innerJoin(schema.surveys, eq(schema.surveys.id, schema.surveyResponses.surveyId))
    .where(
      and(
        eq(schema.surveyResponses.organizationId, organizationId),
        eq(schema.surveyResponses.contactId, contactId),
      ),
    )
    .orderBy(desc(schema.surveyResponses.createdAt))
    .limit(MAX_EVENTS_PER_SOURCE);

  const events: TimelineEvent[] = [];

  for (const row of rows) {
    if (row.sentAt) {
      events.push({
        kind: "survey_sent",
        at: row.sentAt,
        surveyName: row.surveyName,
        channel: row.channel,
      });
    }

    // The check constraint guarantees these two are null together, so one test
    // narrows both.
    if (row.answeredAt && row.score !== null) {
      events.push({
        kind: "survey_answered",
        at: row.answeredAt,
        surveyId: row.surveyId,
        surveyName: row.surveyName,
        surveyType: row.surveyType,
        score: row.score,
        band: bandFor(row.surveyType, row.score),
        comment: row.comment,
        followUpComment: row.followUpComment,
      });
    }
  }

  return events;
}

/**
 * Messages (P4-T3) — real rows at last.
 *
 * Until T3 this read `whatsapp_conversations`, which holds only the last
 * inbound and last outbound *timestamp* because that is all Meta's 24-hour
 * window needs. So the timeline rendered at most two message events and they
 * **moved** rather than accumulated. That was the honest rendering of what the
 * table held; this is the honest rendering of a conversation.
 */
async function messageEvents(
  tx: TenantDatabase,
  organizationId: string,
  contactId: string,
): Promise<TimelineEvent[]> {
  const rows = await tx
    .select({
      direction: schema.messages.direction,
      channel: schema.messages.channel,
      body: schema.messages.body,
      status: schema.messages.status,
      intent: schema.messages.intent,
      failureReason: schema.messages.failureReason,
      createdAt: schema.messages.createdAt,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.organizationId, organizationId),
        eq(schema.messages.contactId, contactId),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(MAX_EVENTS_PER_SOURCE);

  return rows.map((row) =>
    row.direction === "inbound"
      ? { kind: "message_in", at: row.createdAt, channel: row.channel, body: row.body }
      : {
          kind: "message_out",
          at: row.createdAt,
          channel: row.channel,
          body: row.body,
          status: row.status,
          intent: row.intent,
          failureReason: row.failureReason,
        },
  );
}

/**
 * The whole history, newest first.
 *
 * Ties break on nothing in particular and that is fine — two events sharing a
 * millisecond are a review and the request it closed, and either order reads
 * correctly.
 */
export async function contactTimeline(
  tx: TenantDatabase,
  organizationId: string,
  contact: { id: string; createdAt: Date; unsubscribedAt: Date | null },
): Promise<TimelineEvent[]> {
  // Sequential, not `Promise.all`. These share one `pg` client inside the
  // caller's transaction, and that client can only have one query in flight —
  // overlapping them is deprecated in pg@8 and an error in pg@9. Three small
  // indexed reads for one contact do not need the concurrency anyway.
  const requests = await reviewAndRequestEvents(tx, organizationId, contact.id);
  const surveys = await surveyEvents(tx, organizationId, contact.id);
  const consent = await consentEvents(tx, organizationId, contact.id);
  const messages = await messageEvents(tx, organizationId, contact.id);

  const events: TimelineEvent[] = [
    ...requests,
    ...surveys,
    ...consent,
    ...messages,
    { kind: "created", at: contact.createdAt },
  ];

  if (contact.unsubscribedAt) {
    events.push({ kind: "unsubscribed", at: contact.unsubscribedAt });
  }

  return events.sort((left, right) => right.at.getTime() - left.at.getTime());
}
