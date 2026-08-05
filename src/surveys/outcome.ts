import {
  resolveDestination,
  type CampaignRoute,
  type RoutableCampaign,
} from "../collect/routing.ts";
import { bandFor, type SurveyBand, type SurveyType } from "./scoring.ts";

/**
 * What a respondent sees after they answer (P4-T2).
 *
 * **This is the module `docs/20`'s compliance rule is about**, and it answers
 * it the way `src/collect/routing.ts` answers rating-gating for review
 * requests: with a type signature rather than a policy document.
 *
 * The prohibited pattern is precise. Routing an unhappy customer into a private
 * follow-up is fine and is good practice — it is what a complaints process *is*.
 * What is forbidden is deciding **where a public review is solicited** from how
 * happy someone turned out to be: promoters to Google, detractors quietly into
 * a suggestion box. Google's and Trustpilot's policies forbid it, `docs/02` R2
 * requires that no such option exists in the UI, and it is the single most
 * common dark pattern in this category.
 *
 * So the two decisions are split, and only one of them is allowed to see the
 * score:
 *
 *   - `surveyReviewInvite` takes **the survey and nothing else**. It cannot see
 *     a score, a band or a response, because it is never given one. It then
 *     delegates to `resolveDestination`, which has the same property and three
 *     other callers depending on it — so adding score-based routing here would
 *     mean adding a parameter in two places, which is exactly the kind of edit
 *     a reviewer notices and `tests/lib/survey-gating.test.ts` rejects.
 *   - `resolveSurveyOutcome` may see the score, and the only thing it decides
 *     with it is whether to offer a **private** box.
 *
 * The composition below is deliberately dull: it calls one function that knows
 * the score and one that cannot, and puts both in the result.
 */

/**
 * A survey, as far as the review invitation is concerned.
 *
 * Deliberately a campaign rather than a URL. A survey has no review destination
 * of its own — it points at a collection campaign, whose destination was fixed
 * before anybody rated anything. That is what makes the guarantee inherited
 * rather than re-implemented, and it means an external-platform invitation
 * (Google, Trustpilot) gets the same treatment for free.
 */
export type InvitableSurvey = {
  /** Null when the survey never mentions reviews at all. */
  reviewCampaign: RoutableCampaign | null;
};

/**
 * Where — if anywhere — this survey invites a public review.
 *
 * **Every respondent gets the same answer**, and that is enforced by this
 * function having no way to tell them apart. A business may decide whether its
 * survey mentions reviews at all; it may not decide that per customer.
 */
export function surveyReviewInvite(survey: InvitableSurvey, baseUrl: string): CampaignRoute | null {
  if (!survey.reviewCampaign) return null;
  return resolveDestination(survey.reviewCampaign, baseUrl);
}

export type SurveyOutcome = {
  /**
   * Which band the answer fell in. Null when there is no answer yet — the
   * outcome screen is also what somebody sees if they land on it early.
   */
  band: SurveyBand | null;
  /**
   * Offer a private "tell us more" box.
   *
   * The **only** thing the score decides. It adds a place to write; it does not
   * take anything away, and in particular it does not change `reviewInvite`
   * below by so much as a query parameter.
   */
  privateFollowUp: boolean;
  /** Computed from the survey alone. Identical for every score. */
  reviewInvite: CampaignRoute | null;
};

export type OutcomeSurvey = InvitableSurvey & {
  type: SurveyType;
  followUpEnabled: boolean;
};

export function resolveSurveyOutcome(
  survey: OutcomeSurvey,
  score: number | null,
  baseUrl: string,
): SurveyOutcome {
  const band = score === null ? null : bandFor(survey.type, score);

  return {
    band,
    privateFollowUp: survey.followUpEnabled && band === "detractor",
    // Note what is *not* passed. This line is the rule.
    reviewInvite: surveyReviewInvite(survey, baseUrl),
  };
}
