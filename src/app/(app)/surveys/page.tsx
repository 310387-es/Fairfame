import { ClipboardList } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { resolveLocationScope } from "@/auth/scope";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { SurveyForm } from "@/components/surveys/survey-form";
import { Eyebrow } from "@/components/ds/eyebrow";
import { Metric } from "@/components/ds/metric";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
import { SectionTabs } from "@/components/shell/section-tabs";
import { ResourcePage } from "@/components/ds/resource-page";
import { Badge } from "@/components/ui/badge";
import { listLocationsForActor } from "@/lib/active-location";
import { can } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";
import { headline, MIN_MEANINGFUL_RESPONSES } from "@/surveys/scoring";
import { listReviewCampaigns, listSurveys } from "@/surveys/store";

/**
 * Surveys (P4-T2).
 *
 * The list is the scoreboard: every survey with what it has actually measured,
 * because "we ran an NPS" and "our NPS is 34 on 12 answers" are different
 * amounts of information and only the second is worth opening a page for.
 *
 * Scores come from `src/surveys/scoring.ts`, the same module the results page
 * and the Insights card use, so the number here cannot disagree with the number
 * there.
 */
export default async function SurveysPage() {
  const [actor, t, format] = await Promise.all([
    requireActor(),
    getTranslations("surveys"),
    getFormatter(),
  ]);

  const data = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const org = { organizationId: actor.organizationId, tx };
      if (!(await can(org, "surveys"))) return { unlocked: false as const };

      const scope = await resolveLocationScope(tx, actor.organizationId, actor.userId, actor.role);

      return {
        unlocked: true as const,
        surveys: await listSurveys(tx, actor.organizationId, scope),
        locations: await listLocationsForActor(tx, actor),
        campaigns: await listReviewCampaigns(tx, actor.organizationId, scope),
      };
    },
  );

  if (!data.unlocked) {
    return (
      <>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <SectionTabs active="surveys" />
        <SectionCard title={t("locked.title")} icon={ClipboardList}>
          <p className="pb-(--card-py) text-body text-ink-400">{t("locked.body")}</p>
        </SectionCard>
      </>
    );
  }

  const { surveys, locations, campaigns } = data;
  const canManage = roleAtLeast(actor.role, "admin");

  const statusLabel = {
    draft: t("statusDraft"),
    active: t("statusActive"),
    archived: t("statusArchived"),
  } as const;

  // A survey is asked *about* a branch, so no branch means nothing to ask about.
  const create =
    !canManage || locations.length === 0
      ? null
      : {
          label: t("newSurvey"),
          title: t("newSurvey"),
          description: t("empty.body"),
          form: (
            <SurveyForm
              initial={{
                name: "",
                type: "nps",
                locationId: locations[0]!.id,
                locale: null,
                question: null,
                followUpEnabled: true,
                followUpPrompt: null,
                reviewCampaignId: null,
                status: "draft",
              }}
              locations={locations}
              campaigns={campaigns}
            />
          ),
        };

  return (
    <>
      {/*
        Into `ResourcePage`'s `tabs` slot, which renders them *under* the page
        header — the placement `/locations`, `/connections` and `/contacts`
        already use.

        These three had them above the header instead, on the reasoning that a
        tab strip switches section while the header describes the page. That is
        true and it is not what the reader sees: above the title, the strip
        reads as chrome the title hangs off, and the page's own name comes
        second on its own screen.

        What settles it is that this file already did both. The locked-plan
        branch a few lines up renders `PageHeader` then `SectionTabs`, so the
        tab strip moved up or down the page depending on the organization's
        entitlement — the same screen, two layouts, decided by billing.
      */}
      <ResourcePage
        title={t("title")}
        subtitle={t("subtitle")}
        icon={ClipboardList}
        tabs={<SectionTabs active="surveys" />}
        isEmpty={surveys.length === 0}
        empty={{ line: t("empty.title"), hint: t("empty.body") }}
        create={create}
      >
        <ul className="grid gap-(--grid-gap) sm:grid-cols-2">
          {surveys.map((survey) => {
            const figure = headline(survey.score);
            const thin =
              survey.score.responses > 0 && survey.score.responses < MIN_MEANINGFUL_RESPONSES;

            return (
              <li key={survey.id}>
                <SectionCard
                  title={
                    <Link
                      href={`/surveys/${survey.id}`}
                      className="rounded-sm hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      {survey.name}
                    </Link>
                  }
                  meta={survey.locationName}
                  action={
                    <Badge variant={survey.status === "active" ? "positive" : "secondary"}>
                      {statusLabel[survey.status]}
                    </Badge>
                  }
                >
                  <div className="flex flex-wrap items-end justify-between gap-3 pb-(--card-py)">
                    <div className="flex flex-col gap-0.5">
                      <Eyebrow>{survey.type === "nps" ? t("typeNps") : t("typeCsat")}</Eyebrow>
                      {/*
                        A survey with no answers reads as an em dash, never as a
                        zero. An NPS of 0 is a real result — as many promoters as
                        detractors — so printing it for "nobody replied" would
                        show a business a score it had not earned.
                      */}
                      <Metric>
                        {figure.value === null
                          ? "—"
                          : format.number(figure.value, {
                              minimumFractionDigits: figure.digits,
                              maximumFractionDigits: figure.digits,
                            })}
                      </Metric>
                    </div>

                    <div className="flex flex-col items-end gap-0.5 text-right">
                      {/*
                        "7 answers from 0 people" is what a response rate reads
                        like for a survey nobody was emailed — every answer came
                        from a printed code. So the rate is only shown when
                        there is a rate: a denominator of zero is not a low
                        response rate, it is a different measurement.
                      */}
                      <p className="text-meta text-faint">
                        {survey.sent > 0
                          ? t("funnel", { sent: survey.sent, answered: survey.answered })
                          : t("answerCount", { count: survey.answered })}
                      </p>
                      {thin ? (
                        <p className="text-meta text-state-rating-text">
                          {t("thinSample", { min: MIN_MEANINGFUL_RESPONSES })}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </SectionCard>
              </li>
            );
          })}
        </ul>
      </ResourcePage>
    </>
  );
}
