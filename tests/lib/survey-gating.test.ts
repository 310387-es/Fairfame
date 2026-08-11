import { describe, expect, it } from "vitest";
import type { RoutableCampaign } from "@/collect/routing";
import { resolveSurveyOutcome, surveyReviewInvite, type OutcomeSurvey } from "@/surveys/outcome";
import { bandFor, scalePoints, SCALE, SURVEY_TYPES } from "@/surveys/scoring";

/**
 * **The no-review-gating test** (P4-T2, `docs/20` §Compliance).
 *
 * The prohibited pattern is precise: steering happy customers to a public
 * review while diverting unhappy ones into a private box instead. Routing a
 * detractor into a private follow-up *in addition* is fine and is what a
 * complaints process is; what may never happen is the public-review destination
 * changing with the score.
 *
 * `tests/lib/collect.test.ts` asserts the same property for review requests,
 * where it is guaranteed by `resolveDestination` never being handed a rating.
 * Surveys are the case where a rating exists at the moment the destination is
 * shown, so the guarantee has to be asserted rather than inferred — this file
 * is what makes the DoD's "the detractor flow has no public-review gating"
 * checkable instead of asserted.
 */

const BASE = "https://fairfame.test";

const firstparty: RoutableCampaign = {
  slug: "kadikoy-kahve-h7m2qp",
  destination: "firstparty",
  destinationUrl: null,
};

const external: RoutableCampaign = {
  slug: "kadikoy-kahve-h7m2qp",
  destination: "external",
  destinationUrl: "https://maps.example/place/kadikoy",
};

function survey(overrides: Partial<OutcomeSurvey> = {}): OutcomeSurvey {
  return {
    type: "nps",
    followUpEnabled: true,
    reviewCampaign: firstparty,
    ...overrides,
  };
}

describe("the public-review invitation", () => {
  it("is identical at every point on every scale", () => {
    for (const type of SURVEY_TYPES) {
      for (const campaign of [firstparty, external, null]) {
        const config = survey({ type, reviewCampaign: campaign });
        const expected = resolveSurveyOutcome(config, null, BASE).reviewInvite;

        for (const score of scalePoints(type)) {
          const outcome = resolveSurveyOutcome(config, score, BASE);
          expect(
            outcome.reviewInvite,
            `${type} scored ${score} was offered a different destination`,
          ).toEqual(expected);
        }
      }
    }
  });

  it("is the same for a detractor and a promoter, spelled out", () => {
    // The two cases the dark pattern is actually made of, asserted on their own
    // so a failure names them rather than pointing at a loop.
    const config = survey({ reviewCampaign: external });

    const detractor = resolveSurveyOutcome(config, 0, BASE);
    const promoter = resolveSurveyOutcome(config, 10, BASE);

    expect(bandFor("nps", 0)).toBe("detractor");
    expect(bandFor("nps", 10)).toBe("promoter");
    expect(detractor.reviewInvite).toEqual(promoter.reviewInvite);
    expect(detractor.reviewInvite?.url).toBe("https://maps.example/place/kadikoy");
  });

  it("is computed from a survey that carries no score to compute it from", () => {
    // The structural half. `surveyReviewInvite` takes `InvitableSurvey`, whose
    // only field is the campaign — there is nowhere to put a score, so gating
    // would require changing a signature rather than an `if`.
    expect(surveyReviewInvite({ reviewCampaign: firstparty }, BASE)).toEqual({
      kind: "firstparty",
      url: `${BASE}/c/kadikoy-kahve-h7m2qp`,
    });

    expect(surveyReviewInvite({ reviewCampaign: null }, BASE)).toBeNull();
  });

  it("is absent for everybody when the survey does not mention reviews", () => {
    const config = survey({ reviewCampaign: null });
    for (const score of scalePoints("nps")) {
      expect(resolveSurveyOutcome(config, score, BASE).reviewInvite).toBeNull();
    }
  });
});

describe("the private follow-up", () => {
  it("is the one thing the score decides, and only ever adds", () => {
    const config = survey();

    expect(resolveSurveyOutcome(config, 0, BASE).privateFollowUp).toBe(true);
    expect(resolveSurveyOutcome(config, 6, BASE).privateFollowUp).toBe(true);
    expect(resolveSurveyOutcome(config, 7, BASE).privateFollowUp).toBe(false);
    expect(resolveSurveyOutcome(config, 10, BASE).privateFollowUp).toBe(false);

    // …and offering it takes nothing away.
    expect(resolveSurveyOutcome(config, 0, BASE).reviewInvite).not.toBeNull();
  });

  it("can be switched off without touching the invitation", () => {
    const off = survey({ followUpEnabled: false });
    expect(resolveSurveyOutcome(off, 0, BASE).privateFollowUp).toBe(false);
    expect(resolveSurveyOutcome(off, 0, BASE).reviewInvite).not.toBeNull();
  });

  it("uses each instrument's own threshold for unhappy", () => {
    // A 3 is a detractor on NPS and a *passive* on CSAT, because CSAT's middle
    // is 3 of 5. Sharing one number would silently mislabel one of the two.
    expect(resolveSurveyOutcome(survey({ type: "nps" }), 3, BASE).privateFollowUp).toBe(true);
    expect(resolveSurveyOutcome(survey({ type: "csat" }), 3, BASE).privateFollowUp).toBe(false);
    expect(resolveSurveyOutcome(survey({ type: "csat" }), 2, BASE).privateFollowUp).toBe(true);
  });

  it("shows nothing at all before there is an answer", () => {
    const outcome = resolveSurveyOutcome(survey(), null, BASE);
    expect(outcome.band).toBeNull();
    expect(outcome.privateFollowUp).toBe(false);
  });
});

describe("the scales are not interchangeable", () => {
  it("starts NPS at 0 and CSAT at 1", () => {
    // An NPS 0 is a real answer; a CSAT 0 does not exist. A shared 1–10 scale
    // would move every NPS detractor by one.
    expect(SCALE.nps).toEqual({ min: 0, max: 10 });
    expect(SCALE.csat).toEqual({ min: 1, max: 5 });
    expect(scalePoints("nps")).toHaveLength(11);
    expect(scalePoints("csat")).toEqual([1, 2, 3, 4, 5]);
  });
});
