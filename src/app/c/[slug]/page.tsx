import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveCampaignBySlug } from "@/collect/public";
import { resolveDestination } from "@/collect/routing";
import { SubmissionForm, type SubmissionLabels } from "@/components/collect/submission-form";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import { publicBaseUrl } from "@/lib/urls";

/**
 * The hosted review page: /c/{slug}.
 *
 * Public, unauthenticated, and rendered in the campaign's language rather than
 * the visitor's cookie — a Turkish café's customers should not get an English
 * page because they once looked at the dashboard in English.
 *
 * The page has no idea what rating the visitor will give, and neither does the
 * destination it may redirect to: `resolveDestination` is computed from the
 * campaign before any input exists.
 */

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ rt?: string }>;
};

function localeOf(value: string | null): Locale {
  return isLocale(value ?? undefined) ? (value as Locale) : DEFAULT_LOCALE;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const campaign = await resolveCampaignBySlug(slug);
  if (!campaign) return { title: "Revira" };

  const t = await getTranslations({ locale: localeOf(campaign.locale), namespace: "collect" });

  return {
    title: t("metaTitle", { location: campaign.locationName }),
    // A review page has no business in a search index: it is a private link
    // handed to one customer, or printed on one counter.
    robots: { index: false, follow: false },
  };
}

export default async function CollectPage({ params, searchParams }: PageProps) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);

  const campaign = await resolveCampaignBySlug(slug);
  if (!campaign) notFound();

  const locale = localeOf(campaign.locale);
  const t = await getTranslations({ locale, namespace: "collect" });
  const route = resolveDestination(campaign, publicBaseUrl());

  const shell = (children: React.ReactNode) => (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-4 py-10">
      <div className="mb-6 text-center">
        <p className="text-sm text-muted-foreground">{campaign.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold text-balance">{campaign.locationName}</h1>
      </div>

      {children}

      <p className="mt-8 text-center text-xs text-muted-foreground">{t("kvkkNotice")}</p>
      <div className="mt-4 flex justify-center opacity-60">
        <Logo className="text-muted-foreground" markClassName="size-4" />
      </div>
    </main>
  );

  if (campaign.status !== "active") {
    return shell(
      <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
        {t("closed")}
      </div>,
    );
  }

  // An external campaign hands everyone — every rating, no exceptions — the
  // same outbound link.
  if (route.kind === "external") {
    return shell(
      <div className="rounded-xl border bg-card p-8 text-center">
        <p className="text-sm text-pretty text-muted-foreground">{t("externalBody")}</p>
        <Button asChild size="lg" className="mt-5 w-full">
          <a href={route.url} rel="noreferrer nofollow">
            {t("externalCta")}
          </a>
        </Button>
      </div>,
    );
  }

  const labels: SubmissionLabels = {
    ratingLabel: t("ratingLabel"),
    ratingHint: t("ratingHint"),
    starLabels: [1, 2, 3, 4, 5].map((rating) => t("starLabel", { rating })),
    comment: t("comment"),
    commentPlaceholder: t("commentPlaceholder"),
    name: t("name"),
    namePlaceholder: t("namePlaceholder"),
    email: t("email"),
    emailPlaceholder: t("emailPlaceholder"),
    emailHint: t("emailHint"),
    kvkkLabel: t("kvkkLabel"),
    submit: t("submit"),
    submitting: t("submitting"),
    thanksTitle: t("thanksTitle"),
    thanksBody: t("thanksBody"),
    errorRating: t("errorRating"),
    errorKvkk: t("errorKvkk"),
    errorGeneric: t("errorGeneric"),
    errorRateLimited: t("errorRateLimited"),
    errorAlreadySubmitted: t("errorAlreadySubmitted"),
    errorClosed: t("errorClosed"),
  };

  return shell(
    <div className="rounded-xl border bg-card p-6 sm:p-8">
      <SubmissionForm slug={campaign.slug} requestToken={query.rt ?? null} labels={labels} />
    </div>,
  );
}
