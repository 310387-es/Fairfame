import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/client.ts";
import { generateCampaignSlug } from "../collect/tokens.ts";
import type { LocationScope } from "../auth/scope.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { scoreSurvey, SURVEY_TYPES, type SurveyScore, type SurveyType } from "./scoring.ts";

/**
 * Reading and writing surveys (P4-T2).
 *
 * The tenant-scoped data layer for the builder and the results screen. Scoring
 * is not done here — `./scoring.ts` owns it, and this module's job is to hand it
 * a list of numbers, so the arithmetic stays testable without a database and
 * cannot quietly differ between the survey list, the results page and the
 * Insights card.
 */

export const surveyNameSchema = z.string().trim().min(1).max(80);
export const surveyQuestionSchema = z.string().trim().max(280);
export const followUpPromptSchema = z.string().trim().max(280);

export const surveyInputSchema = z.object({
  name: surveyNameSchema,
  type: z.enum(SURVEY_TYPES),
  locationId: z.uuid(),
  locale: z.string().max(10).nullable(),
  question: surveyQuestionSchema.nullable(),
  followUpEnabled: z.boolean(),
  followUpPrompt: followUpPromptSchema.nullable(),
  /** The collection campaign whose destination every respondent is offered. */
  reviewCampaignId: z.uuid().nullable(),
  status: z.enum(["draft", "active", "archived"]),
});

export type SurveyInput = z.infer<typeof surveyInputSchema>;

export class SurveyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurveyError";
  }
}

/** Location scope, as a clause. Empty scope means nothing, never everything. */
function scopeClause(scope: LocationScope) {
  if (scope.all) return undefined;
  if (scope.locationIds.length === 0) return sql`false`;
  return inArray(schema.surveys.locationId, scope.locationIds);
}

export type SurveyRow = {
  id: string;
  name: string;
  type: SurveyType;
  status: "draft" | "active" | "archived";
  locationId: string;
  locationName: string;
  slug: string;
  locale: string | null;
  question: string | null;
  followUpEnabled: boolean;
  followUpPrompt: string | null;
  reviewCampaignId: string | null;
  createdAt: Date;
};

export type SurveySummary = SurveyRow & {
  /** Asked, and answered. Both are needed to read a response rate honestly. */
  sent: number;
  answered: number;
  score: SurveyScore;
};

const SURVEY_COLUMNS = {
  id: schema.surveys.id,
  name: schema.surveys.name,
  type: schema.surveys.type,
  status: schema.surveys.status,
  locationId: schema.surveys.locationId,
  locationName: schema.locations.name,
  slug: schema.surveys.slug,
  locale: schema.surveys.locale,
  question: schema.surveys.question,
  followUpEnabled: schema.surveys.followUpEnabled,
  followUpPrompt: schema.surveys.followUpPrompt,
  reviewCampaignId: schema.surveys.reviewCampaignId,
  createdAt: schema.surveys.createdAt,
};

export async function listSurveys(
  tx: TenantDatabase,
  organizationId: string,
  scope: LocationScope,
): Promise<SurveySummary[]> {
  const rows = await tx
    .select(SURVEY_COLUMNS)
    .from(schema.surveys)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.surveys.locationId))
    .where(and(eq(schema.surveys.organizationId, organizationId), scopeClause(scope)))
    .orderBy(desc(schema.surveys.createdAt));

  if (rows.length === 0) return [];

  // Every answer for every listed survey, in one read. The alternative — a
  // score query per survey — is an N+1 on a page that exists to be scanned.
  const answers = await tx
    .select({
      surveyId: schema.surveyResponses.surveyId,
      score: schema.surveyResponses.score,
      sentAt: schema.surveyResponses.sentAt,
    })
    .from(schema.surveyResponses)
    .where(
      and(
        eq(schema.surveyResponses.organizationId, organizationId),
        inArray(
          schema.surveyResponses.surveyId,
          rows.map((row) => row.id),
        ),
      ),
    );

  const bySurvey = new Map<string, { scores: number[]; sent: number }>();
  for (const answer of answers) {
    const entry = bySurvey.get(answer.surveyId) ?? { scores: [], sent: 0 };
    if (answer.score !== null) entry.scores.push(answer.score);
    if (answer.sentAt !== null) entry.sent += 1;
    bySurvey.set(answer.surveyId, entry);
  }

  return rows.map((row) => {
    const entry = bySurvey.get(row.id) ?? { scores: [], sent: 0 };
    return {
      ...row,
      sent: entry.sent,
      answered: entry.scores.length,
      score: scoreSurvey(row.type, entry.scores),
    };
  });
}

export async function getSurvey(
  tx: TenantDatabase,
  organizationId: string,
  scope: LocationScope,
  surveyId: string,
): Promise<SurveyRow | null> {
  const [row] = await tx
    .select(SURVEY_COLUMNS)
    .from(schema.surveys)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.surveys.locationId))
    .where(
      and(
        eq(schema.surveys.organizationId, organizationId),
        eq(schema.surveys.id, surveyId),
        scopeClause(scope),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Checks that a named review campaign is this organization's, and returns it.
 *
 * Never trusts the id from the browser. RLS would refuse a foreign campaign on
 * the foreign key anyway, but failing here names the actual problem — and, more
 * to the point, a survey pointing at another tenant's campaign would send a
 * customer to a stranger's review page.
 */
async function assertOwnCampaign(
  tx: TenantDatabase,
  organizationId: string,
  campaignId: string | null,
): Promise<void> {
  if (!campaignId) return;

  const [row] = await tx
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(
      and(eq(schema.campaigns.organizationId, organizationId), eq(schema.campaigns.id, campaignId)),
    )
    .limit(1);

  if (!row) throw new SurveyError("That review campaign does not exist.");
}

async function assertOwnLocation(
  tx: TenantDatabase,
  organizationId: string,
  scope: LocationScope,
  locationId: string,
): Promise<void> {
  if (!scope.all && !scope.locationIds.includes(locationId)) {
    throw new SurveyError("That location does not exist.");
  }

  const [row] = await tx
    .select({ id: schema.locations.id })
    .from(schema.locations)
    .where(
      and(eq(schema.locations.organizationId, organizationId), eq(schema.locations.id, locationId)),
    )
    .limit(1);

  if (!row) throw new SurveyError("That location does not exist.");
}

export async function createSurvey(
  tx: TenantDatabase,
  organizationId: string,
  scope: LocationScope,
  input: SurveyInput,
): Promise<{ id: string; slug: string }> {
  await assertOwnLocation(tx, organizationId, scope, input.locationId);
  await assertOwnCampaign(tx, organizationId, input.reviewCampaignId);

  // `surveys.slug` is globally unique because it is a URL. Retried rather than
  // pre-checked: the race between "is it taken" and "insert" is real, and the
  // unique index is the only thing that can actually settle it.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = generateCampaignSlug(input.name);

    const [row] = await tx
      .insert(schema.surveys)
      .values({
        organizationId,
        locationId: input.locationId,
        name: input.name,
        type: input.type,
        status: input.status,
        locale: input.locale,
        slug,
        question: input.question,
        followUpEnabled: input.followUpEnabled,
        followUpPrompt: input.followUpPrompt,
        reviewCampaignId: input.reviewCampaignId,
      })
      .onConflictDoNothing({ target: schema.surveys.slug })
      .returning({ id: schema.surveys.id, slug: schema.surveys.slug });

    if (row) return row;
  }

  throw new SurveyError("Could not allocate a link for this survey. Try a different name.");
}

/**
 * Updates a survey.
 *
 * **The type is not editable**, and neither is the slug. Changing the type
 * would reinterpret every answer already collected — a stored 7 is a passive on
 * NPS and off the scale entirely on CSAT — and changing the slug would break a
 * QR code already printed on a table. Both are omitted from the update rather
 * than guarded, so there is no path that could set them.
 */
export async function updateSurvey(
  tx: TenantDatabase,
  organizationId: string,
  scope: LocationScope,
  surveyId: string,
  input: Omit<SurveyInput, "type">,
): Promise<void> {
  const existing = await getSurvey(tx, organizationId, scope, surveyId);
  if (!existing) throw new SurveyError("That survey does not exist.");

  await assertOwnLocation(tx, organizationId, scope, input.locationId);
  await assertOwnCampaign(tx, organizationId, input.reviewCampaignId);

  await tx
    .update(schema.surveys)
    .set({
      name: input.name,
      locationId: input.locationId,
      status: input.status,
      locale: input.locale,
      question: input.question,
      followUpEnabled: input.followUpEnabled,
      followUpPrompt: input.followUpPrompt,
      reviewCampaignId: input.reviewCampaignId,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.surveys.organizationId, organizationId), eq(schema.surveys.id, surveyId)));
}

export type SurveyAnswer = {
  id: string;
  score: number;
  comment: string | null;
  followUpComment: string | null;
  answeredAt: Date;
  contactId: string | null;
  contactName: string | null;
  channel: string;
};

/** The answers to one survey, newest first. */
export async function listAnswers(
  tx: TenantDatabase,
  organizationId: string,
  surveyId: string,
  limit = 100,
): Promise<SurveyAnswer[]> {
  const rows = await tx
    .select({
      id: schema.surveyResponses.id,
      score: schema.surveyResponses.score,
      comment: schema.surveyResponses.comment,
      followUpComment: schema.surveyResponses.followUpComment,
      answeredAt: schema.surveyResponses.answeredAt,
      contactId: schema.surveyResponses.contactId,
      contactName: schema.contacts.name,
      channel: schema.surveyResponses.channel,
    })
    .from(schema.surveyResponses)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.surveyResponses.contactId))
    .where(
      and(
        eq(schema.surveyResponses.organizationId, organizationId),
        eq(schema.surveyResponses.surveyId, surveyId),
        isNotNull(schema.surveyResponses.answeredAt),
      ),
    )
    .orderBy(desc(schema.surveyResponses.answeredAt))
    .limit(limit);

  // The two not-null columns are guaranteed together by the
  // `survey_responses_answered_has_score` check constraint; the filter above
  // narrows on one, so the other is safe to assert.
  return rows.map((row) => ({
    ...row,
    score: row.score as number,
    answeredAt: row.answeredAt as Date,
  }));
}

/**
 * The campaigns a survey or a broadcast may point at.
 *
 * **Everything that can send, which is everything but `link`.** A link campaign
 * has nothing to deliver — the customer arrives from a QR code on their own —
 * so offering one and refusing it at send time is a picker that lets somebody
 * be wrong and then tells them off. Found by doing exactly that: a broadcast
 * aimed at a link campaign got as far as the mailer before `prepareRequests`
 * said "share its link instead".
 *
 * **It filtered to `email` until A22-A2, and that was the other half of the
 * WhatsApp bug.** A broadcast could name WhatsApp and then had no WhatsApp
 * campaign to point at, so it pointed at an email one — and `prepareRequests`
 * took the channel from there and emailed people who had been gated on their
 * WhatsApp permission. The channel is now the *caller's* to state, so this can
 * offer every sendable campaign; it returns each one's own channel so a picker
 * can narrow to the send being described rather than pairing a WhatsApp
 * broadcast with something labelled "E-posta".
 */
export async function listReviewCampaigns(
  tx: TenantDatabase,
  organizationId: string,
  scope: LocationScope,
): Promise<
  { id: string; name: string; locationId: string; channel: "email" | "sms" | "whatsapp" }[]
> {
  const rows = await tx
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      locationId: schema.campaigns.locationId,
      channel: schema.campaigns.channel,
    })
    .from(schema.campaigns)
    .where(
      and(
        eq(schema.campaigns.organizationId, organizationId),
        eq(schema.campaigns.status, "active"),
        ne(schema.campaigns.channel, "link"),
        scope.all
          ? undefined
          : scope.locationIds.length === 0
            ? sql`false`
            : inArray(schema.campaigns.locationId, scope.locationIds),
      ),
    )
    .orderBy(schema.campaigns.name);

  // `link` is excluded in SQL; the cast states what that leaves rather than
  // widening every caller's type to a channel this list cannot contain.
  return rows.map((row) => ({ ...row, channel: row.channel as "email" | "sms" | "whatsapp" }));
}
