import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicMark } from "@/components/brand/public-mark";
import { resolveBrand } from "@/agency/branding";
import { SurveyAnswerForm, type AnswerLabels } from "@/components/surveys/answer-form";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import { publicBaseUrl } from "@/lib/urls";
import { resolveSurveyOutcome } from "@/surveys/outcome";
import {
  markSurveyOpened,
  resolveSurveyBySlug,
  resolveSurveyByToken,
  type PublicSurvey,
} from "@/surveys/public";
import { SCALE, scalePoints } from "@/surveys/scoring";

/**
 * The hosted survey page: /s/{code} (P4-T2).
 *
 * **One route for two arrivals.** `code` is either a 22-character token
 * addressed to one person or a survey's public slug printed on a card, and the
 * two cannot be confused: the token alphabet has no hyphen and a slug is never
 * 22 characters of it. A second path segment would be one more thing to get
 * wrong when somebody reads a URL off a table.
 *
 * Rendered in the survey's language rather than the visitor's cookie, exactly
 * as `/c/{slug}` is: a Turkish café's customers should not get an English page
 * because somebody once looked at the dashboard in English.
 *
 * The open is recorded while rendering rather than in a redirect handler the
 * way `/r/{token}` does it. That is safe here because the write is idempotent —
 * `coalesce` keeps the first timestamp and the status only moves forwards — and
 * because this page *is* the destination, so there is no redirect to repeat.
 */

type PageProps = { params: Promise<{ code: string }> };

/** Nothing here belongs in a search index: it is a link handed to one person. */
const PRIVATE: Metadata["robots"] = { index: false, follow: false };

function localeOf(value: string | null): Locale {
  return isLocale(value ?? undefined) ? (value as Locale) : DEFAULT_LOCALE;
}

/** Token first, then slug. One lookup each, and never both twice. */
async function resolve(code: string): Promise<{
  survey: PublicSurvey;
  token: string | null;
  /** The invitation row, when this arrival was invited by name. */
  responseId: string | null;
  answered: { score: number; token: string } | null;
} | null> {
  const invite = await resolveSurveyByToken(code);
  if (invite) {
    return {
      survey: invite.survey,
      token: code,
      responseId: invite.responseId,
      answered:
        invite.answeredAt && invite.score !== null ? { score: invite.score, token: code } : null,
    };
  }

  const survey = await resolveSurveyBySlug(code);
  return survey ? { survey, token: null, responseId: null, answered: null } : null;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { code } = await params;
  const resolved = await resolve(code);
  if (!resolved) return { title: "Revira", robots: PRIVATE };

  const t = await getTranslations({
    locale: localeOf(resolved.survey.locale),
    namespace: "survey",
  });

  return {
    title: t("metaTitle", { location: resolved.survey.locationName }),
    robots: PRIVATE,
  };
}

export default async function SurveyPage({ params }: PageProps) {
  const { code } = await params;
  const resolved = await resolve(code);
  if (!resolved) notFound();

  const { survey, token, responseId, answered } = resolved;
  const locale = localeOf(survey.locale);
  const t = await getTranslations({ locale, namespace: "survey" });
  const brand = await resolveBrand(survey.organizationId);

  // Tracking, and only for somebody we actually invited — a walk-in has no row
  // to open. Failures are swallowed inside; analytics never blocks the page.
  if (responseId) await markSurveyOpened(survey.organizationId, responseId);

  const shell = (children: React.ReactNode) => (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-4 py-10">
      <div className="mb-6 text-center">
        <p className="text-body text-muted-foreground">{survey.organizationName}</p>
        <h1 className="mt-1 text-display text-balance">
          {survey.question ??
            t(survey.type === "nps" ? "defaultQuestionNps" : "defaultQuestionCsat", {
              business: survey.organizationName,
              location: survey.locationName,
            })}
        </h1>
      </div>

      {children}

      <p className="mt-8 text-center text-copy text-muted-foreground">{t("kvkkNotice")}</p>
      <div className="mt-4 flex justify-center opacity-60">
        <PublicMark brand={brand} />
      </div>
    </main>
  );

  if (survey.status !== "active") {
    return shell(
      <div className="rounded-lg border border-line bg-card p-8 text-center text-body text-ink-400">
        {t("closed")}
      </div>,
    );
  }

  /**
   * The outcome, resolved on the server with **no score**.
   *
   * `resolveSurveyOutcome(survey, null, …)` is called deliberately: the only
   * field this page needs from it is `reviewInvite`, which is computed from the
   * survey alone and is therefore already final before anybody answers. Passing
   * a score would produce the same invitation and would suggest, to whoever
   * reads this next, that it might not have.
   */
  const outcome = resolveSurveyOutcome(
    {
      type: survey.type,
      followUpEnabled: survey.followUpEnabled,
      reviewCampaign: survey.reviewCampaign,
    },
    null,
    publicBaseUrl(),
  );

  const labels: AnswerLabels = {
    low: t(survey.type === "nps" ? "npsLow" : "csatLow"),
    high: t(survey.type === "nps" ? "npsHigh" : "csatHigh"),
    comment: t("comment"),
    commentPlaceholder: t("commentPlaceholder"),
    submit: t("submit"),
    submitting: t("submitting"),
    thanksTitle: t("thanksTitle"),
    thanksBody: t("thanksBody"),
    followUpTitle: t("followUpTitle"),
    followUpBody: t("followUpBody"),
    followUpPlaceholder: t("followUpPlaceholder"),
    followUpSubmit: t("followUpSubmit"),
    followUpThanks: t("followUpThanks"),
    reviewInviteBody: t("reviewInviteBody"),
    reviewInviteCta: t("reviewInviteCta"),
    errorScore: t("errorScore"),
    errorGeneric: t("errorGeneric"),
    errorClosed: t("errorClosed"),
    errorAlreadyAnswered: t("errorAlreadyAnswered"),
    errorRateLimited: t("errorRateLimited"),
    // Formatted server-side, as data. A function cannot cross the RSC
    // boundary — P3-T4 shipped that exact bug — so every point on the scale is
    // named here, in `scalePoints` order.
    scoreLabels: scalePoints(survey.type).map((score) =>
      t("scoreLabel", { score, max: SCALE[survey.type].max }),
    ),
    scaleLegend: t("scaleLegend", { max: SCALE[survey.type].max }),
  };

  return shell(
    <SurveyAnswerForm
      type={survey.type}
      token={token}
      slug={token ? null : survey.slug}
      followUpEnabled={survey.followUpEnabled}
      followUpPrompt={survey.followUpPrompt}
      reviewInvite={
        outcome.reviewInvite
          ? { url: outcome.reviewInvite.url, external: outcome.reviewInvite.kind === "external" }
          : null
      }
      answered={answered}
      labels={labels}
    />,
  );
}
