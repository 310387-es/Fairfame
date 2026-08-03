import { ArrowRight, Minus, Quote, TrendingDown, TrendingUp } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { ActionCard } from "@/components/digest/action-card";
import { CopyButton } from "@/components/digest/copy-button";
import { PulseTile } from "@/components/digest/pulse-tile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatChange } from "@/digest/change-text";
import type { DigestView as Digest } from "@/digest/queries";
import { cn } from "@/lib/utils";

/**
 * The weekly plan (P1a-T8).
 *
 * Ordered the way the design brief asks the screen to read: the sentence first,
 * then the three things to do, then the evidence, then the assets. The pulse
 * sits beside the briefing rather than above it — a number is context for a
 * plan, not a substitute for one.
 *
 * Everything rendered here comes from the stored digest. No model runs to draw
 * this page, which is why it loads like any other list.
 */

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

export async function DigestView({ digest }: { digest: Digest }) {
  const [t, format] = await Promise.all([getTranslations("home"), getFormatter()]);
  const payload = digest.payload;

  if (!payload) return null;

  const quiet = digest.reviewCount === 0;
  const changes = payload.changes.map((change) => ({
    direction: change.direction,
    text: formatChange(change, (key, values) => t(key, values)),
  }));

  return (
    <div className="flex flex-col gap-6">
      {/* The briefing and the pulse, side by side. */}
      <section className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <Card className="flex flex-col justify-center">
          <CardContent className="py-6">
            <p className="mb-2 text-xs text-muted-foreground">
              {t("period", {
                start: format.dateTime(digest.periodStart, { day: "numeric", month: "short" }),
                end: format.dateTime(new Date(digest.periodEnd.getTime() - 1), {
                  day: "numeric",
                  month: "short",
                }),
              })}
            </p>

            {quiet ? (
              <>
                <h2 className="font-heading text-xl font-semibold text-balance">
                  {t("quietWeek")}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-pretty text-muted-foreground">
                  {t("quietWeekBody")}
                </p>
              </>
            ) : (
              <>
                <h2 className="font-heading text-2xl font-semibold text-balance">
                  {payload.headline}
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-pretty">{payload.summary}</p>

                {payload.callouts.length > 0 ? (
                  <ul className="mt-4 flex flex-wrap gap-2">
                    {payload.callouts.map((callout) => (
                      <li key={callout}>
                        <Badge variant="secondary" className="font-normal">
                          {callout}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <div className="lg:w-[17rem]">
          <PulseTile
            score={digest.pulseScore}
            delta={digest.pulseDelta}
            reviewCount={digest.reviewCount}
          />
        </div>
      </section>

      {/* The plan. */}
      {digest.actions.length > 0 ? (
        <section>
          <div className="mb-3">
            <h3 className="font-heading text-lg font-semibold">{t("actionsTitle")}</h3>
            <p className="text-sm text-muted-foreground">{t("actionsHint")}</p>
          </div>

          <ul className="flex flex-col gap-3">
            {digest.actions.map((action) => {
              const evidence = action.evidence as { themeSlug: string; reviewIds: string[] };

              return (
                <ActionCard
                  key={action.id}
                  id={action.id}
                  position={action.position}
                  text={action.text}
                  status={action.status}
                  themeSlug={evidence.themeSlug}
                  reviewCount={evidence.reviewIds.length}
                />
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* What moved, and the loop from last week. */}
      {changes.length > 0 || payload.priorActionsOutcome ? (
        <section className="grid gap-4 md:grid-cols-2">
          {changes.length > 0 ? (
            <Card>
              <CardContent className="py-5">
                <h3 className="mb-3 text-sm font-semibold">{t("changesTitle")}</h3>
                <ul className="flex flex-col gap-2">
                  {changes.map((change) => (
                    <li key={change.text} className="flex gap-2 text-sm leading-relaxed">
                      <ChangeIcon direction={change.direction} />
                      <span className="text-pretty">{change.text}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {payload.priorActionsOutcome ? (
            <Card>
              <CardContent className="py-5">
                <h3 className="mb-3 text-sm font-semibold">{t("loopTitle")}</h3>
                <p className="text-sm">
                  {t("loopSummary", {
                    done: payload.priorActionsOutcome.done,
                    total: payload.priorActionsOutcome.total,
                  })}
                </p>

                {payload.priorActionsOutcome.stillOpen.length > 0 ? (
                  <>
                    <p className="mt-3 text-xs text-muted-foreground">{t("loopStillOpen")}</p>
                    <ul className="mt-1 flex flex-col gap-1">
                      {payload.priorActionsOutcome.stillOpen.map((item) => (
                        <li
                          key={item.text}
                          className="text-sm leading-relaxed text-pretty text-muted-foreground"
                        >
                          · {item.text}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </section>
      ) : null}

      {/* Themes, with the customers' own words. */}
      {payload.themes.length > 0 ? (
        <section>
          <h3 className="mb-3 font-heading text-lg font-semibold">{t("themesTitle")}</h3>

          <div className="grid gap-3 md:grid-cols-2">
            {payload.themes.map((theme) => (
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

                  {theme.quotes.slice(0, 2).map((quote) => (
                    <p
                      key={quote.reviewId}
                      className="mt-2 flex gap-1.5 text-sm leading-relaxed text-pretty text-muted-foreground"
                    >
                      <Quote className="mt-1 size-3 shrink-0 opacity-50" aria-hidden />
                      {/* The customer's actual words. A theme without them is
                          an assertion; with them it is evidence. */}
                      <span className="italic">{quote.text}</span>
                    </p>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {/* Assets — a head start on the work, not more reading. */}
      {payload.assets.replyDrafts.length > 0 || payload.assets.socialPost ? (
        <section>
          <h3 className="mb-3 font-heading text-lg font-semibold">{t("assetsTitle")}</h3>

          <div className="grid gap-3 md:grid-cols-2">
            {payload.assets.replyDrafts.length > 0 ? (
              <Card>
                <CardContent className="flex flex-col gap-2 py-5">
                  <p className="text-sm font-medium">
                    {t("replyDrafts", { count: payload.assets.replyDrafts.length })}
                  </p>
                  <p className="text-xs text-muted-foreground">{t("replyDraftsHint")}</p>

                  <p className="rounded-lg bg-muted/60 p-3 text-sm leading-relaxed text-pretty">
                    {payload.assets.replyDrafts[0]?.text}
                  </p>

                  <Button asChild variant="outline" size="sm" className="mt-1 self-start">
                    <Link href="/inbox">
                      {t("openInbox")}
                      <ArrowRight className="size-4" aria-hidden />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            ) : null}

            {payload.assets.socialPost ? (
              <Card>
                <CardContent className="flex flex-col gap-2 py-5">
                  <p className="text-sm font-medium">{t("socialPost")}</p>

                  <p className="rounded-lg bg-muted/60 p-3 text-sm leading-relaxed text-pretty">
                    {payload.assets.socialPost.text}
                  </p>

                  <CopyButton
                    text={payload.assets.socialPost.text}
                    label={t("copy")}
                    copiedLabel={t("copied")}
                  />
                </CardContent>
              </Card>
            ) : null}
          </div>
        </section>
      ) : null}

      {digest.generatedAt ? (
        <p className="text-xs text-muted-foreground">
          {t("lastGenerated", { when: format.relativeTime(digest.generatedAt, new Date()) })}
        </p>
      ) : null}
    </div>
  );
}
