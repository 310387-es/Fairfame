import { qrSvg } from "@/lib/qr";
import { ClipboardList, Link2, MessageSquare, Send } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { resolveLocationScope } from "@/auth/scope";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { SurveyForm } from "@/components/surveys/survey-form";
import { SurveySend } from "@/components/surveys/survey-send";
import { Eyebrow } from "@/components/ds/eyebrow";
import { Metric } from "@/components/ds/metric";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { listLocationsForActor } from "@/lib/active-location";
import { can } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";
import { buildSurveyUrl, publicBaseUrl } from "@/lib/urls";
import { bandFor, headline, MIN_MEANINGFUL_RESPONSES, scoreSurvey } from "@/surveys/scoring";
import { getSurvey, listAnswers, listReviewCampaigns } from "@/surveys/store";

/**
 * One survey: configure it, send it, read what came back (P4-T2).
 *
 * The answers list leads with the score and the words, in that order, because a
 * detractor's sentence is the thing somebody on this page can act on today —
 * and the **private follow-up sits underneath, marked private**, so a reader
 * skimming can tell which of the two boxes the customer thought was going on a
 * website and which they thought was a complaint.
 */

type PageProps = { params: Promise<{ id: string }> };

export default async function SurveyDetailPage({ params }: PageProps) {
  const [{ id }, actor, t, format] = await Promise.all([
    params,
    requireActor(),
    getTranslations("surveys"),
    getFormatter(),
  ]);

  const data = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const org = { organizationId: actor.organizationId, tx };
      if (!(await can(org, "surveys"))) return null;

      const scope = await resolveLocationScope(tx, actor.organizationId, actor.userId, actor.role);
      const survey = await getSurvey(tx, actor.organizationId, scope, id);
      if (!survey) return null;

      return {
        survey,
        answers: await listAnswers(tx, actor.organizationId, survey.id),
        locations: await listLocationsForActor(tx, actor),
        campaigns: await listReviewCampaigns(tx, actor.organizationId, scope),
      };
    },
  );

  // One 404 for "no such survey", "not yours to see" and "not on your plan" —
  // distinguishing them leaks whatever each was withholding.
  if (!data) notFound();

  const { survey, answers, locations, campaigns } = data;
  const canManage = roleAtLeast(actor.role, "admin");

  const score = scoreSurvey(
    survey.type,
    answers.map((answer) => answer.score),
  );
  const figure = headline(score);
  const thin = score.responses > 0 && score.responses < MIN_MEANINGFUL_RESPONSES;
  const publicUrl = buildSurveyUrl(publicBaseUrl(), survey.slug);
  const qrCode = await qrSvg(publicUrl);

  const bandLabel = {
    promoter: t("bandPromoter"),
    passive: t("bandPassive"),
    detractor: t("bandDetractor"),
  } as const;

  return (
    <>
      <PageHeader
        title={survey.name}
        subtitle={survey.locationName}
        back={{ href: "/surveys", label: t("title") }}
      />

      {/*
        Two columns for *running* the survey, and the settings form below them
        at full width.

        The form was in the left column — the narrow one — while the answers
        card had the wider track and, on a survey nobody has answered yet, one
        short sentence in it. So the longest thing on the page was squeezed into
        480px with seven hundred pixels of white beside it, and `SurveyForm`
        lays its fields out two across, which needs room it did not have.

        Answers stays beside the score because that is the pairing somebody
        reads: the number, and the words behind it. Settings is a different
        errand, done once.
      */}
      <div className="flex flex-col gap-(--grid-gap)">
        <div className="grid gap-(--grid-gap) lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start">
          <div className="flex flex-col gap-(--grid-gap)">
            <SectionCard title={t("results")} icon={ClipboardList}>
              <div className="flex flex-col gap-3 pb-(--card-py)">
                <div className="flex flex-wrap items-end gap-6">
                  <div className="flex flex-col gap-0.5">
                    <Eyebrow>{survey.type === "nps" ? t("typeNps") : t("typeCsat")}</Eyebrow>
                    {/*
                    A sentence, not an em-dash — the W3.3 correction, which this
                    screen never got. At 28px, "—" beside "ANSWERS 0" reads as a
                    rendering failure to anybody who has not read the scoring
                    module, and an NPS of 0 is a real result, so it is the one
                    place absence must not look like a value.
                  */}
                    {figure.value === null ? (
                      <p className="pt-1 text-copy text-ink-400">{t("noScoreYet")}</p>
                    ) : (
                      <Metric>
                        {format.number(figure.value, {
                          minimumFractionDigits: figure.digits,
                          maximumFractionDigits: figure.digits,
                        })}
                      </Metric>
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <Eyebrow>{t("responses")}</Eyebrow>
                    <Metric>{score.responses}</Metric>
                  </div>
                </div>

                {thin ? (
                  <p className="text-meta text-state-rating-text">
                    {t("thinSample", { min: MIN_MEANINGFUL_RESPONSES })}
                  </p>
                ) : null}

                {score.responses > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="positive">
                      {bandLabel.promoter} · {score.counts.promoter}
                    </Badge>
                    <Badge variant="secondary">
                      {bandLabel.passive} · {score.counts.passive}
                    </Badge>
                    <Badge variant="destructive">
                      {bandLabel.detractor} · {score.counts.detractor}
                    </Badge>
                  </div>
                ) : null}
              </div>
            </SectionCard>

            {/*
            The card is called "Link and QR" and had no QR in it — while its own
            hint says "print it, or put it on a receipt", which is not something
            anybody does with a URL. A survey on a table or a receipt is
            answered by pointing a phone at it; without the code the card
            described a feature it did not have.

            Server-rendered SVG, like the campaign card's: a QR is static
            markup, not a component with behaviour.
          */}
            <SectionCard title={t("shareLink")} icon={Link2}>
              <div className="flex gap-4 pb-(--card-py)">
                <div
                  aria-label={t("qrAlt")}
                  role="img"
                  className="size-24 shrink-0 [&>svg]:size-full"
                  dangerouslySetInnerHTML={{ __html: qrCode }}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <p className="text-body text-ink-400">{t("shareLinkHint")}</p>
                  <code className="rounded-md border border-line bg-surface-sunken px-2.5 py-2 font-mono text-meta break-all text-ink-600">
                    {publicUrl}
                  </code>
                </div>
              </div>
            </SectionCard>

            {canManage ? (
              <SectionCard title={t("sendTitle")} icon={Send}>
                <SurveySend surveyId={survey.id} />
              </SectionCard>
            ) : null}
          </div>

          <SectionCard title={t("answers")} icon={MessageSquare}>
            {answers.length === 0 ? (
              <p className="pb-(--card-py) text-body text-ink-400">{t("noAnswers")}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line-soft pb-(--card-py)">
                {answers.map((answer) => {
                  const band = bandFor(survey.type, answer.score);

                  return (
                    <li key={answer.id} className="flex flex-col gap-1.5 py-3 first:pt-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={
                            band === "promoter"
                              ? "positive"
                              : band === "detractor"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {answer.score}
                        </Badge>
                        <span className="text-copy font-medium text-foreground">
                          {answer.contactName ?? t("anonymous")}
                        </span>
                        <time
                          dateTime={answer.answeredAt.toISOString()}
                          className="text-meta text-faint"
                        >
                          {format.relativeTime(answer.answeredAt, new Date())}
                        </time>
                      </div>

                      {answer.comment ? (
                        <p className="text-body text-pretty text-ink-400">{answer.comment}</p>
                      ) : null}

                      {/*
                      Marked private, always. It was given under a different
                      promise from the comment above it, and somebody deciding
                      what to quote on a website needs to be able to tell.
                    */}
                      {answer.followUpComment ? (
                        <div className="rounded-md border border-line bg-surface-sunken px-3 py-2">
                          <p className="text-eyebrow text-faint uppercase">
                            {t("privateFollowUp")}
                          </p>
                          <p className="mt-0.5 text-body text-pretty text-ink-400">
                            {answer.followUpComment}
                          </p>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>
        </div>

        {canManage ? (
          <SectionCard title={t("settings")} icon={ClipboardList}>
            <SurveyForm
              initial={{
                id: survey.id,
                name: survey.name,
                type: survey.type,
                locationId: survey.locationId,
                locale: survey.locale,
                question: survey.question,
                followUpEnabled: survey.followUpEnabled,
                followUpPrompt: survey.followUpPrompt,
                reviewCampaignId: survey.reviewCampaignId,
                status: survey.status,
              }}
              locations={locations}
              campaigns={campaigns}
            />
          </SectionCard>
        ) : null}
      </div>
    </>
  );
}
