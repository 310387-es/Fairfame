import {
  ArrowRight,
  ArrowUpDown,
  History,
  Megaphone,
  MessageSquare,
  MessageSquareQuote,
  Minus,
  Quote,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { ActionCard } from "@/components/digest/action-card";
import { CopyButton } from "@/components/digest/copy-button";
import { PulseTile } from "@/components/digest/pulse-tile";
import { Eyebrow } from "@/components/ds/eyebrow";
import { IconTile } from "@/components/ds/icon-tile";
import { SectionCard } from "@/components/ds/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
        // Sentiment, not indigo: "this went up" is a reading, not a control.
        direction > 0
          ? "text-state-positive-text"
          : direction < 0
            ? "text-state-negative-text"
            : "text-ink-400",
      )}
    />
  );
}

export async function DigestView({ digest }: { digest: Digest }) {
  const [t, format] = await Promise.all([getTranslations("digest"), getFormatter()]);
  const payload = digest.payload;

  if (!payload) return null;

  const quiet = digest.reviewCount === 0;
  const changes = payload.changes.map((change) => ({
    direction: change.direction,
    text: formatChange(change, (key, values) => t(key, values)),
  }));

  return (
    <div className="flex flex-col gap-(--grid-gap)">
      {/* The briefing and the pulse, side by side. */}
      <section className="grid gap-(--grid-gap) lg:grid-cols-[1fr_auto]">
        {/*
          Ink, not a white card with a 25px heading. Two things drove this.

          `text-display` is the *page's one h1* and `PageHeader` owns it
          (docs/15 §3) — a second display-size line directly beneath the page
          title made the screen argue with itself about what it was about.

          And this paragraph is the same object as Home's AI strip: a sentence
          the model wrote about your week. Home gives that the ink treatment,
          so this does too, which is what makes the digest read as part of the
          product rather than a page from before the redesign. Ink and the rail
          are the only two dark surfaces, and this is the ink one.
        */}
        <div className="flex flex-col justify-center gap-3.5 rounded-lg bg-brief px-(--card-px) py-5 text-on-ink">
          <div className="flex items-center gap-2.5">
            <IconTile icon={Sparkles} tone="solid" />
            <Eyebrow className="text-on-ink-muted">{t("briefingLabel")}</Eyebrow>
          </div>

          {quiet ? (
            <>
              <h2 className="max-w-[52ch] text-title text-balance">{t("quietWeek")}</h2>
              <p className="max-w-[64ch] text-body leading-relaxed text-pretty text-on-ink-muted">
                {t("quietWeekBody")}
              </p>
            </>
          ) : (
            <>
              <h2 className="max-w-[52ch] text-title text-balance">{payload.headline}</h2>
              <p className="max-w-[64ch] text-body leading-relaxed text-pretty text-on-ink-muted">
                {payload.summary}
              </p>

              {payload.callouts.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {payload.callouts.map((callout) => (
                    <li
                      key={callout}
                      className="rounded-sm bg-white/10 px-2 py-1 text-meta text-on-ink"
                    >
                      {callout}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>

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
            <h3 className="text-title">{t("actionsTitle")}</h3>
            <p className="text-body text-muted-foreground">{t("actionsHint")}</p>
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
        <section className="grid gap-(--grid-gap) md:grid-cols-2">
          {changes.length > 0 ? (
            <SectionCard title={t("changesTitle")} icon={ArrowUpDown}>
              <ul className="flex flex-col gap-2">
                {changes.map((change) => (
                  <li key={change.text} className="flex gap-2 text-body leading-relaxed">
                    <ChangeIcon direction={change.direction} />
                    <span className="text-pretty">{change.text}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          {payload.priorActionsOutcome ? (
            <SectionCard title={t("loopTitle")} icon={History}>
              <p className="text-body">
                {t("loopSummary", {
                  done: payload.priorActionsOutcome.done,
                  total: payload.priorActionsOutcome.total,
                })}
              </p>

              {payload.priorActionsOutcome.stillOpen.length > 0 ? (
                <>
                  <p className="mt-3 text-copy text-faint">{t("loopStillOpen")}</p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {payload.priorActionsOutcome.stillOpen.map((item) => (
                      <li
                        key={item.text}
                        className="text-body leading-relaxed text-pretty text-muted-foreground"
                      >
                        · {item.text}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </SectionCard>
          ) : null}
        </section>
      ) : null}

      {/* Themes, with the customers' own words. */}
      {payload.themes.length > 0 ? (
        <section>
          <h3 className="mb-3 text-title">{t("themesTitle")}</h3>

          <div className="grid gap-(--grid-gap) md:grid-cols-2">
            {payload.themes.map((theme) => (
              <SectionCard
                key={theme.label}
                title={theme.label}
                icon={MessageSquareQuote}
                meta={t("themeCount", { count: theme.count })}
                action={
                  <span className="flex gap-1.5">
                    {/* Sentiment tokens, not indigo. Indigo means "this is
                        interactive" everywhere else in the product, and a
                        count of happy customers is neither a link nor a
                        button (docs/15 §2). */}
                    {theme.positive > 0 ? (
                      <Badge variant="positive">
                        {t("themePositive", { count: theme.positive })}
                      </Badge>
                    ) : null}
                    {theme.negative > 0 ? (
                      <Badge variant="negative">
                        {t("themeNegative", { count: theme.negative })}
                      </Badge>
                    ) : null}
                  </span>
                }
              >
                {theme.quotes.slice(0, 2).map((quote) => (
                  <p
                    key={quote.reviewId}
                    className="mt-2 flex gap-1.5 text-body leading-relaxed text-pretty text-muted-foreground first:mt-0"
                  >
                    {/* `--graphic-faint` is the token for a non-text glyph;
                        `opacity-50` was an untokened dimming that landed at an
                        unpredictable contrast over any background. */}
                    <Quote className="mt-1 size-3 shrink-0 text-graphic-faint" aria-hidden />
                    {/* The customer's actual words. A theme without them is
                        an assertion; with them it is evidence. */}
                    <span className="italic">{quote.text}</span>
                  </p>
                ))}
              </SectionCard>
            ))}
          </div>
        </section>
      ) : null}

      {/* Assets — a head start on the work, not more reading. */}
      {payload.assets.replyDrafts.length > 0 || payload.assets.socialPost ? (
        <section>
          <h3 className="mb-3 text-title">{t("assetsTitle")}</h3>

          <div className="grid gap-(--grid-gap) md:grid-cols-2">
            {payload.assets.replyDrafts.length > 0 ? (
              <SectionCard
                title={t("replyDrafts", { count: payload.assets.replyDrafts.length })}
                icon={MessageSquare}
                tone="accent"
                meta={t("replyDraftsHint")}
              >
                {/* `bg-surface-sunken`, the documented inset surface. `bg-muted`
                    is a shadcn default at a different hue, so these blocks used
                    to sit slightly warm against every other sunken panel. */}
                <p className="rounded-md bg-surface-sunken p-3 text-body leading-relaxed text-pretty">
                  {payload.assets.replyDrafts[0]?.text}
                </p>

                <Button asChild variant="outline" size="sm" className="mt-3 self-start">
                  <Link href="/inbox">
                    {t("openInbox")}
                    <ArrowRight aria-hidden />
                  </Link>
                </Button>
              </SectionCard>
            ) : null}

            {payload.assets.socialPost ? (
              <SectionCard title={t("socialPost")} icon={Megaphone} tone="accent">
                <p className="rounded-md bg-surface-sunken p-3 text-body leading-relaxed text-pretty">
                  {payload.assets.socialPost.text}
                </p>

                <div className="mt-3">
                  <CopyButton
                    text={payload.assets.socialPost.text}
                    label={t("copy")}
                    copiedLabel={t("copied")}
                  />
                </div>
              </SectionCard>
            ) : null}
          </div>
        </section>
      ) : null}

      {digest.generatedAt ? (
        <p className="text-copy text-muted-foreground">
          {t("lastGenerated", { when: format.relativeTime(digest.generatedAt, new Date()) })}
        </p>
      ) : null}
    </div>
  );
}
