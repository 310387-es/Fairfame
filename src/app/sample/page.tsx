import { themeLabel } from "@/reviews/taxonomy";
import { ArrowRight, Info, Minus, Quote, TrendingDown, TrendingUp } from "lucide-react";
import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
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
  const [t, tc, tThemes, format, digest] = await Promise.all([
    getTranslations({ locale, namespace: "sample" }),
    // The change sentences live in the `digest` namespace and are shared with
    // the real digest, so the two screens cannot describe the same data
    // differently.
    getTranslations({ locale, namespace: "digest" }),
    getTranslations({ locale, namespace: "themes" }),
    getFormatter({ locale }),
    getSampleDigest({ locale }),
  ]);

  /*
    Locale-formatted, never `toFixed` — the rule `PulseTile` states and this
    page broke, on the one surface a prospect sees before they trust anything.

    `toFixed(1)` did two things wrong at once. It forced a decimal onto a
    whole-number score, so a nine-point fall read "down 9.0" beside a tile
    showing "65" — a precision the number does not have. And `toFixed` writes a
    **dot**, always: in Turkish the rest of the product prints "9,2" and this
    line printed "9.2", which is the punctuation mismatch `PulseTile`'s comment
    warns about, sitting on the marketing page rather than one screen away.
  */
  // A canonical key becomes a word; a free tag is shown as written.
  const label = (key: string) => themeLabel(key, tThemes);

  const points = (value: number) => format.number(value, { maximumFractionDigits: 1 });

  const deltaLabel =
    digest.delta === null
      ? null
      : digest.delta === 0
        ? t("deltaFlat")
        : digest.delta > 0
          ? t("deltaUp", { value: points(digest.delta) })
          : t("deltaDown", { value: points(Math.abs(digest.delta)) });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 md:py-16">
      <header className="flex flex-col gap-4">
        <Link href="/" className="self-start">
          <Logo className="h-8" />
        </Link>

        <div>
          <Badge variant="secondary" className="mb-3">
            {t("eyebrow")}
          </Badge>
          {/* `hero`, not `display`: the digest's own headline below is at
              `display`, and two headings the same size read as one. This page
              is the only place in the product that earns a second heading —
              the promise and the artefact are both the point. */}
          <h1 className="text-hero text-balance">{t("title")}</h1>
          {/* `text-faint` (--ink-350), not `--ink-400`: this sits on `--canvas`,
          where docs/15 §Colour puts ink-400 at 4.37:1 — under AA. The token is
          legal on a white card and this page is not one. Found by
          `e2e/contrast.spec.ts`, which measures the rendered pixel. */}
          <p className="mt-3 text-body text-pretty text-faint">{t("intro")}</p>
        </div>

        {/*
          Stated plainly and above the content, not in small print underneath.
          A prospect who mistakes invented reviews for a real business's has
          been misled, however impressive the page looked.
        */}
        <p className="flex items-start gap-2 rounded-lg border border-dashed bg-muted/40 p-3 text-copy text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("demoNotice", { business: digest.business })}
        </p>
      </header>

      <Card>
        <CardContent className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center">
          <div className="flex-1">
            <p className="text-copy text-muted-foreground">
              {digest.business} · {digest.location} ·{" "}
              {t("periodLabel", { days: digest.periodDays })}
            </p>
            <h2 className="mt-1 text-display text-balance">{digest.headline}</h2>
            <p className="mt-3 text-body leading-relaxed text-pretty">{digest.summary}</p>

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

          <div className="flex shrink-0 flex-col items-center rounded-lg border border-line p-5 sm:w-44">
            {/*
              Ink, and the same shape the dashboard uses for the same number.

              This tile used to band the score by threshold — indigo at 70+,
              amber from 45, red below — which breaks two of the palette's rules
              at once. Indigo means "this is interactive" and never "this is
              good" (docs/15 §2); amber means "this is a rating", and a composed
              0-100 score is not one. It also disagreed with the product it is
              advertising: `/dashboard` draws this figure in ink and lets the
              delta underneath carry the judgement, which is what the line below
              already does here.

              `/100` for the reason W4.3 added it in the app — this is the one
              figure on the page that names no unit, and somebody reading it as
              a percentage or as 65 reviews has misread the number a prospect is
              being shown first. `sr-only` for the reading, `aria-hidden` for
              the mark, so it announces as "65 out of 100".

              The hand-typed arbitrary size went with it: `text-metric` is the
              token, and typing a font size is what the design system exists to
              stop. The old value is described rather than quoted, because a
              scanner reading this file cannot tell a comment from a class and
              reported the sentence as the very drift it records fixing.
            */}
            <span className="flex items-baseline gap-1">
              <span className="text-metric">
                {digest.pulse === null ? "—" : Math.round(digest.pulse)}
              </span>
              {digest.pulse === null ? null : (
                <span className="text-copy text-faint">
                  <span aria-hidden>/100</span>
                  <span className="sr-only">{tc("outOf", { max: 100 })}</span>
                </span>
              )}
            </span>
            <span className="mt-1 text-copy font-medium">{t("pulse")}</span>
            <span className="mt-1 text-center text-meta text-muted-foreground">
              {deltaLabel ?? t("reviewCount", { count: digest.reviewCount })}
            </span>
          </div>
        </CardContent>
      </Card>

      <section>
        <h3 className="text-title">{t("actionsTitle")}</h3>
        <p className="mb-3 text-body text-muted-foreground">{t("actionsHint")}</p>

        <ul className="flex flex-col gap-3">
          {digest.actions.map((action) => (
            <li
              key={action.position}
              className="flex gap-4 rounded-lg border border-line bg-card p-5"
            >
              <span
                aria-hidden
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-state-accent-bg font-mono text-copy font-semibold text-state-accent-text tabular-nums"
              >
                {action.position}
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-body leading-relaxed text-pretty">{action.text}</p>
                {/*
                  A label, not a link: there is no Inbox to send an anonymous
                  visitor to, and a dead link is worse than no link.
                */}
                <span className="text-copy text-muted-foreground">{label(action.theme)}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {digest.changes.length > 0 ? (
        <Card>
          <CardContent className="py-5">
            <h3 className="mb-3 text-title">{t("changesTitle")}</h3>
            <ul className="flex flex-col gap-2">
              {digest.changes.map((change) => (
                <li
                  key={`${change.kind}-${JSON.stringify(change.detail)}`}
                  className="flex gap-2 text-body leading-relaxed"
                >
                  <ChangeIcon direction={change.direction} />
                  <span className="text-pretty">
                    {formatChange(change, (key, values) => tc(key, values), label)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <section>
        <h3 className="mb-3 text-title">{t("themesTitle")}</h3>

        <div className="grid gap-3 md:grid-cols-2">
          {digest.themes.map((theme) => (
            <Card key={theme.label}>
              <CardContent className="py-5">
                <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-medium">{label(theme.label)}</span>
                  <span className="text-copy text-muted-foreground">
                    {t("themeCount", { count: theme.count })}
                  </span>

                  <span className="ml-auto flex gap-1.5 text-meta">
                    {theme.positive > 0 ? (
                      <span className="rounded-sm bg-state-positive-bg px-1.5 py-0.5 font-semibold text-state-positive-text">
                        {t("themePositive", { count: theme.positive })}
                      </span>
                    ) : null}
                    {theme.negative > 0 ? (
                      <span className="rounded-sm bg-state-negative-bg px-1.5 py-0.5 font-semibold text-state-negative-text">
                        {t("themeNegative", { count: theme.negative })}
                      </span>
                    ) : null}
                  </span>
                </div>

                {theme.quotes.map((quote) => (
                  <p
                    key={quote.text}
                    className="mt-2 flex gap-1.5 text-body leading-relaxed text-pretty text-muted-foreground"
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
          <h3 className="text-title">{t("ctaTitle")}</h3>
          <p className="text-body text-pretty text-muted-foreground">{t("ctaBody")}</p>

          <div className="mt-1 flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link href="/sign-up">
                {t("ctaButton")}
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </Button>
            <Link
              href="/sign-in"
              className="tap text-body text-muted-foreground underline-offset-4 hover:underline"
            >
              {t("ctaSignIn")}
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
