import { ArrowRight, Info, Minus, Quote, TrendingDown, TrendingUp } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatChange } from "@/digest/change-text";
import { getSampleDigest } from "@/digest/sample";
import { getLocale } from "@/i18n/locale";
import { cn } from "@/lib/utils";

/**
 * The public sample digest: /sample (P1a-T10).
 *
 * No account, no session, no database. Everything on this page is computed from
 * an invented café in `src/digest/sample-data.ts` and composed at most once an
 * hour — see `src/digest/sample.ts` for why a public page must not let a
 * visitor trigger a model call.
 *
 * Deliberately *not* the Home component. That one renders a tenant's digest and
 * takes rows with ids, statuses and actions a signed-in user can complete;
 * reusing it here would mean either faking those rows or making the real screen
 * aware of an anonymous mode. Two audiences, two pages — and this one carries a
 * demo notice the real one must never show.
 */

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: "sample" });

  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
  };
}

function ChangeIcon({ direction }: { direction: number }) {
  const Icon = direction > 0 ? TrendingUp : direction < 0 ? TrendingDown : Minus;
  return (
    <Icon
      aria-hidden
      className={cn(
        "mt-0.5 size-4 shrink-0",
        direction > 0
          ? "text-primary"
          : direction < 0
            ? "text-destructive"
            : "text-muted-foreground",
      )}
    />
  );
}

export default async function SamplePage() {
  const locale = await getLocale();
  const [t, tc, digest] = await Promise.all([
    getTranslations({ locale, namespace: "sample" }),
    // The change sentences live in the `home` namespace and are shared with the
    // real digest, so the two screens cannot describe the same data differently.
    getTranslations({ locale, namespace: "home" }),
    getSampleDigest({ locale }),
  ]);

  const deltaLabel =
    digest.delta === null
      ? null
      : digest.delta === 0
        ? t("deltaFlat")
        : digest.delta > 0
          ? t("deltaUp", { value: digest.delta.toFixed(1) })
          : t("deltaDown", { value: Math.abs(digest.delta).toFixed(1) });

  const band =
    digest.pulse === null
      ? "text-muted-foreground"
      : digest.pulse >= 70
        ? "text-primary"
        : digest.pulse >= 45
          ? "text-rating"
          : "text-destructive";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 md:py-16">
      <header className="flex flex-col gap-4">
        <Link href="/" className="self-start">
          <Logo markClassName="size-6" />
        </Link>

        <div>
          <Badge variant="secondary" className="mb-3">
            {t("eyebrow")}
          </Badge>
          <h1 className="font-heading text-3xl font-semibold text-balance">{t("title")}</h1>
          <p className="mt-3 text-pretty text-muted-foreground">{t("intro")}</p>
        </div>

        {/*
          Stated plainly and above the content, not in small print underneath.
          A prospect who mistakes invented reviews for a real business's has
          been misled, however impressive the page looked.
        */}
        <p className="flex items-start gap-2 rounded-lg border border-dashed bg-muted/40 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("demoNotice", { business: digest.business })}
        </p>
      </header>

      <Card>
        <CardContent className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center">
          <div className="flex-1">
            <p className="text-xs text-muted-foreground">
              {digest.business} · {digest.location} ·{" "}
              {t("periodLabel", { days: digest.periodDays })}
            </p>
            <h2 className="mt-1 font-heading text-2xl font-semibold text-balance">
              {digest.headline}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-pretty">{digest.summary}</p>

            {digest.callouts.length > 0 ? (
              <ul className="mt-4 flex flex-wrap gap-2">
                {digest.callouts.map((callout) => (
                  <li key={callout}>
                    <Badge variant="secondary" className="font-normal">
                      {callout}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col items-center rounded-xl border p-5 sm:w-44">
            <span className={cn("font-heading text-4xl font-semibold tabular-nums", band)}>
              {digest.pulse === null ? "—" : Math.round(digest.pulse)}
            </span>
            <span className="mt-1 text-xs font-medium">{t("pulse")}</span>
            <span className="mt-1 text-center text-[11px] text-muted-foreground">
              {deltaLabel ?? t("reviewCount", { count: digest.reviewCount })}
            </span>
          </div>
        </CardContent>
      </Card>

      <section>
        <h3 className="font-heading text-lg font-semibold">{t("actionsTitle")}</h3>
        <p className="mb-3 text-sm text-muted-foreground">{t("actionsHint")}</p>

        <ul className="flex flex-col gap-3">
          {digest.actions.map((action) => (
            <li key={action.position} className="flex gap-4 rounded-xl border bg-card p-5">
              <span
                aria-hidden
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary tabular-nums"
              >
                {action.position}
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-sm leading-relaxed text-pretty">{action.text}</p>
                {/*
                  A label, not a link: there is no Inbox to send an anonymous
                  visitor to, and a dead link is worse than no link.
                */}
                <span className="text-xs text-muted-foreground">{action.theme}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {digest.changes.length > 0 ? (
        <Card>
          <CardContent className="py-5">
            <h3 className="mb-3 text-sm font-semibold">{t("changesTitle")}</h3>
            <ul className="flex flex-col gap-2">
              {digest.changes.map((change) => (
                <li
                  key={`${change.kind}-${JSON.stringify(change.detail)}`}
                  className="flex gap-2 text-sm leading-relaxed"
                >
                  <ChangeIcon direction={change.direction} />
                  <span className="text-pretty">
                    {formatChange(change, (key, values) => tc(key, values))}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <section>
        <h3 className="mb-3 font-heading text-lg font-semibold">{t("themesTitle")}</h3>

        <div className="grid gap-3 md:grid-cols-2">
          {digest.themes.map((theme) => (
            <Card key={theme.label}>
              <CardContent className="py-5">
                <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-medium">{theme.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("themeCount", { count: theme.count })}
                  </span>

                  <span className="ml-auto flex gap-1.5 text-[11px]">
                    {theme.positive > 0 ? (
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                        {t("themePositive", { count: theme.positive })}
                      </span>
                    ) : null}
                    {theme.negative > 0 ? (
                      <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">
                        {t("themeNegative", { count: theme.negative })}
                      </span>
                    ) : null}
                  </span>
                </div>

                {theme.quotes.map((quote) => (
                  <p
                    key={quote.text}
                    className="mt-2 flex gap-1.5 text-sm leading-relaxed text-pretty text-muted-foreground"
                  >
                    <Quote className="mt-1 size-3 shrink-0 opacity-50" aria-hidden />
                    <span className="italic">{quote.text}</span>
                  </p>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="flex flex-col items-start gap-3 py-6">
          <h3 className="font-heading text-lg font-semibold">{t("ctaTitle")}</h3>
          <p className="text-sm text-pretty text-muted-foreground">{t("ctaBody")}</p>

          <div className="mt-1 flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link href="/sign-up">
                {t("ctaButton")}
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </Button>
            <Link
              href="/sign-in"
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              {t("ctaSignIn")}
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
