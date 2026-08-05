import { and, eq, sql } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";
import { looksLikeSlug, looksLikeToken, generateRequestToken } from "../collect/tokens.ts";
import { getEnv } from "../lib/env.ts";
import { childLogger } from "../lib/logger.ts";
import { consumeRateLimit } from "../lib/rate-limit.ts";
import { withTenant } from "../lib/tenancy.ts";
import { isValidScore, type SurveyType } from "./scoring.ts";

/**
 * The unauthenticated side of a survey: a stranger holding a token or a slug
 * (P4-T2).
 *
 * Same three rules `src/collect/public.ts` set out, and the same reason they
 * are confined to one file: the *first* lookup cannot be tenant-scoped, because
 * a link in an email carries no session and the token itself is what names the
 * organization. So it uses the owner connection, reads the minimum, never
 * accepts a caller-supplied organization id, and every write afterwards goes
 * back through `withTenant()` so RLS still has the final say.
 *
 * One difference from review collection is worth naming. A review submission
 * creates a canonical `reviews` row that the whole product then reasons about;
 * a survey answer is two small columns on a row that already exists. That makes
 * the write narrower and the idempotency simpler — a token answers once, and
 * the check constraint in migration 0037 refuses a half-written answer.
 */

const log = childLogger({ module: "surveys/public" });

export type PublicSurvey = {
  organizationId: string;
  organizationName: string;
  surveyId: string;
  locationId: string;
  locationName: string;
  slug: string;
  type: SurveyType;
  status: "draft" | "active" | "archived";
  locale: string | null;
  question: string | null;
  followUpEnabled: boolean;
  followUpPrompt: string | null;
  /** The campaign whose destination every respondent is offered. Null for none. */
  reviewCampaign: {
    slug: string;
    destination: "firstparty" | "external";
    destinationUrl: string | null;
  } | null;
};

const surveyColumns = {
  organizationId: schema.surveys.organizationId,
  organizationName: schema.organizations.name,
  surveyId: schema.surveys.id,
  locationId: schema.surveys.locationId,
  locationName: schema.locations.name,
  slug: schema.surveys.slug,
  type: schema.surveys.type,
  status: schema.surveys.status,
  locale: sql<
    string | null
  >`coalesce(${schema.surveys.locale}, ${schema.locations.locale}, ${schema.organizations.locale})`,
  question: schema.surveys.question,
  followUpEnabled: schema.surveys.followUpEnabled,
  followUpPrompt: schema.surveys.followUpPrompt,
  campaignSlug: schema.campaigns.slug,
  campaignDestination: schema.campaigns.destination,
  campaignDestinationUrl: schema.campaigns.destinationUrl,
};

type SurveyColumnsRow = {
  campaignSlug: string | null;
  campaignDestination: "firstparty" | "external" | null;
  campaignDestinationUrl: string | null;
} & Omit<PublicSurvey, "reviewCampaign">;

function toPublicSurvey(row: SurveyColumnsRow): PublicSurvey {
  const { campaignSlug, campaignDestination, campaignDestinationUrl, ...survey } = row;

  return {
    ...survey,
    reviewCampaign:
      campaignSlug && campaignDestination
        ? {
            slug: campaignSlug,
            destination: campaignDestination,
            destinationUrl: campaignDestinationUrl,
          }
        : null,
  };
}

/** The survey behind a public slug — the QR-code path. */
export async function resolveSurveyBySlug(slug: string): Promise<PublicSurvey | null> {
  if (!looksLikeSlug(slug)) return null;

  const [row] = await getAdminDb()
    .select(surveyColumns)
    .from(schema.surveys)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.surveys.locationId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.surveys.organizationId))
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.surveys.reviewCampaignId))
    .where(eq(schema.surveys.slug, slug))
    .limit(1);

  return row ? toPublicSurvey(row) : null;
}

export type PublicSurveyInvite = {
  survey: PublicSurvey;
  responseId: string;
  contactName: string | null;
  /** Null until they answer. Non-null means this token is spent. */
  answeredAt: Date | null;
  score: number | null;
  followUpComment: string | null;
};

/** The single ask behind a survey token, or null. */
export async function resolveSurveyByToken(token: string): Promise<PublicSurveyInvite | null> {
  if (!looksLikeToken(token)) return null;

  const [row] = await getAdminDb()
    .select({
      ...surveyColumns,
      responseId: schema.surveyResponses.id,
      contactName: schema.contacts.name,
      answeredAt: schema.surveyResponses.answeredAt,
      score: schema.surveyResponses.score,
      followUpComment: schema.surveyResponses.followUpComment,
    })
    .from(schema.surveyResponses)
    .innerJoin(schema.surveys, eq(schema.surveys.id, schema.surveyResponses.surveyId))
    .innerJoin(schema.locations, eq(schema.locations.id, schema.surveys.locationId))
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.surveyResponses.organizationId),
    )
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.surveyResponses.contactId))
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.surveys.reviewCampaignId))
    .where(eq(schema.surveyResponses.token, token))
    .limit(1);

  if (!row) return null;

  const { responseId, contactName, answeredAt, score, followUpComment, ...rest } = row;

  return {
    survey: toPublicSurvey(rest),
    responseId,
    contactName,
    answeredAt,
    score,
    followUpComment,
  };
}

/**
 * Records that the customer opened their survey.
 *
 * First touch only, and the status never travels backwards from `answered`.
 * Unlike `/r/{token}` — which redirects, so a repeated side effect would be a
 * repeated redirect — this is written while rendering the question page, which
 * is safe precisely because the write is idempotent: `coalesce` keeps the first
 * timestamp and the status only moves forwards.
 */
export async function markSurveyOpened(
  organizationId: string,
  responseId: string,
  now = new Date(),
): Promise<void> {
  try {
    await withTenant({ organizationId }, (tx) =>
      tx
        .update(schema.surveyResponses)
        .set({
          openedAt: sql`coalesce(${schema.surveyResponses.openedAt}, ${now})`,
          status: sql`case when ${schema.surveyResponses.status} in ('pending', 'sent')
                        then 'opened'::survey_response_status
                        else ${schema.surveyResponses.status} end`,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.surveyResponses.organizationId, organizationId),
            eq(schema.surveyResponses.id, responseId),
          ),
        ),
    );
  } catch (error) {
    // Tracking must never stand between a customer and the question they were
    // asked; log it and render the page.
    log.warn({ organizationId, responseId, err: error }, "Could not record survey open");
  }
}

export type AnswerFailure =
  "not_found" | "closed" | "invalid_score" | "already_answered" | "rate_limited";

export type AnswerResult =
  | { ok: true; responseId: string; token: string; score: number }
  | { ok: false; error: AnswerFailure };

export type AnswerInput = {
  /** A token (we asked this person) or a slug (they scanned a code). */
  token?: string | undefined;
  slug?: string | undefined;
  score: number;
  comment?: string | undefined;
};

export type AnswerContext = { ip: string | null };

/**
 * Records an answer.
 *
 * Two arrival paths, one write. With a token the row already exists and this
 * fills it in; with a slug nobody was asked, so a row is created at answer time
 * with `sent_at` null — the same shape `recordWalkInRequest` gives a walk-in
 * review, and the reason `survey_responses` is one table rather than two.
 *
 * The token is returned either way, because the outcome screen — including a
 * detractor's private follow-up — is addressed by it.
 */
export async function recordAnswer(
  input: AnswerInput,
  context: AnswerContext,
  now = new Date(),
): Promise<AnswerResult> {
  const invite = input.token ? await resolveSurveyByToken(input.token) : null;
  const survey = invite?.survey ?? (input.slug ? await resolveSurveyBySlug(input.slug) : null);

  if (!survey) return { ok: false, error: "not_found" };
  if (survey.status !== "active") return { ok: false, error: "closed" };

  // The scale is a property of the type, and this is the boundary where an
  // arbitrary number from the internet meets it. The database's 0–10 check is
  // the floor; this is the actual rule.
  if (!isValidScore(survey.type, input.score)) return { ok: false, error: "invalid_score" };

  // One ask, one answer. A leaked token would otherwise be a way to move a
  // business's score.
  if (invite?.answeredAt) return { ok: false, error: "already_answered" };

  /**
   * The abuse guard, on the **anonymous path only**.
   *
   * An invited answer arrives with an unguessable token that the update below
   * lets be used exactly once, so rate-limiting it would cost real answers and
   * prevent nothing. What needs a guard is the slug: anybody who can read a
   * card can post to it.
   *
   * Its own allowance rather than the review endpoint's, because the traffic is
   * genuinely different — a survey card comes with the bill, so a dozen people
   * on one café's Wi-Fi inside ten minutes is the normal case rather than
   * abuse. Scoped per survey as well as per IP, so one venue's rush cannot
   * throttle another's.
   */
  if (!invite) {
    const env = getEnv();
    const limit = await consumeRateLimit(
      `survey:${survey.surveyId}:${context.ip ?? "unknown"}`,
      env.PUBLIC_SURVEY_LIMIT,
      env.PUBLIC_SUBMIT_WINDOW_SECONDS,
    );
    if (!limit.allowed) return { ok: false, error: "rate_limited" };
  }

  const comment = input.comment?.trim() ? input.comment.trim().slice(0, 2_000) : null;

  return withTenant({ organizationId: survey.organizationId }, async (tx) => {
    if (invite) {
      const [row] = await tx
        .update(schema.surveyResponses)
        .set({
          score: input.score,
          comment,
          answeredAt: now,
          status: "answered",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.surveyResponses.organizationId, survey.organizationId),
            eq(schema.surveyResponses.id, invite.responseId),
            // Re-checked in the WHERE rather than only above, so two taps on a
            // slow connection cannot both write.
            sql`${schema.surveyResponses.answeredAt} is null`,
          ),
        )
        .returning({ id: schema.surveyResponses.id, token: schema.surveyResponses.token });

      if (!row) return { ok: false, error: "already_answered" } as const;
      return { ok: true, responseId: row.id, token: row.token, score: input.score } as const;
    }

    const [row] = await tx
      .insert(schema.surveyResponses)
      .values({
        organizationId: survey.organizationId,
        surveyId: survey.surveyId,
        locationId: survey.locationId,
        // Nobody was asked and nobody handed over an address.
        contactId: null,
        channel: "link",
        status: "answered",
        token: generateRequestToken(),
        score: input.score,
        comment,
        answeredAt: now,
      })
      .returning({ id: schema.surveyResponses.id, token: schema.surveyResponses.token });

    if (!row) return { ok: false, error: "not_found" } as const;
    return { ok: true, responseId: row.id, token: row.token, score: input.score } as const;
  });
}

/**
 * Records the private follow-up a detractor was offered.
 *
 * Separate from `recordAnswer` because it happens at a different moment, under a
 * different promise, and into a different column — see the schema note on
 * `follow_up_comment`. It requires a token: there is no anonymous path to it,
 * because there would be no answer to attach it to.
 *
 * Deliberately **not** gated on the band. The check that a detractor is the one
 * being offered the box lives in `resolveSurveyOutcome`; re-deriving it here
 * would be a second definition of who counts as unhappy, and refusing a
 * promoter who typed something anyway would throw away feedback the customer
 * chose to give.
 */
export async function recordFollowUp(
  token: string,
  comment: string,
  now = new Date(),
): Promise<{ ok: boolean }> {
  const invite = await resolveSurveyByToken(token);
  if (!invite?.answeredAt) return { ok: false };

  const trimmed = comment.trim();
  if (!trimmed) return { ok: false };

  await withTenant({ organizationId: invite.survey.organizationId }, (tx) =>
    tx
      .update(schema.surveyResponses)
      .set({ followUpComment: trimmed.slice(0, 2_000), updatedAt: now })
      .where(
        and(
          eq(schema.surveyResponses.organizationId, invite.survey.organizationId),
          eq(schema.surveyResponses.id, invite.responseId),
        ),
      ),
  );

  return { ok: true };
}
