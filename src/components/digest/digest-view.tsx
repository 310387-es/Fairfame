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
import { CompletionRecordCard } from "@/components/digest/completion-record";
import { CopyButton } from "@/components/digest/copy-button";
import { PulseTile } from "@/components/digest/pulse-tile";
import { Eyebrow } from "@/components/ds/eyebrow";
import { IconTile } from "@/components/ds/icon-tile";
import { SectionCard } from "@/components/ds/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatChange } from "@/digest/change-text";
import type { CompletionRecord, DigestView as Digest } from "@/digest/queries";
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

export async function DigestView({
  digest,
  record,
}: {
  digest: Digest;
  /**
   * The running completion record (W2.1), or null where the caller has not
   * read one. Optional rather than required because it is a *live* count and
   * this component otherwise renders entirely from the stored digest — a
   * surface that cannot query, such as the email, has nothing to pass.
   */
  record?: CompletionRecord | null;
}) {
  const [t, format] = await Promise.all([getTranslations("digest"), getFormatter()]);
  const payload = digest.payload;

  if (!payload) return null;

  const quiet = digest.reviewCount === 0;

  /**
   * The week we declined to write about (W1.6).
   *
   * Distinct from a quiet week: reviews *did* arrive, we have not analysed
   * enough of them to say anything true, and the honest thing is to say so and
   * point at what is waiting. The audit's alternative — three confident
   * sentences and "0 reviews on" under each action — is what this replaces.
   */
  const insufficient = payload.insufficient;

  /**
   * Every quote in the payload, by review id (W2.1).
   *
   * Built once for the whole page rather than per card: the same review can be
   * cited by two actions, and looking it up twice would be two scans of every
   * theme. `quotesFor` already ordered these worst-first, so a card showing two
   * of them shows the two that most deserve answering.
   */
  const quoteById = new Map(
    payload.themes.flatMap((theme) =>
      theme.quotes.map(
        (quote) => [quote.reviewId, { text: quote.text, rating: quote.rating }] as const,
      ),
    ),
  );
  const changes = payload.changes.map((change) => ({
    direction: change.direction,
    text: formatChange(change, (key, values) => t(key, values)),
  }));

  /** How many of the three mid-page panels will actually render. */
  const panels = [changes.length > 0, Boolean(payload.priorActionsOutcome), Boolean(record)].filter(
    Boolean,
  ).length;

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
          ) : insufficient ? (
            <>
              <h2 className="max-w-[52ch] text-title text-balance">{t("thinWeek")}</h2>
              <p className="max-w-[64ch] text-body leading-relaxed text-pretty text-on-ink-muted">
                {/* Two different problems, and only one of them fixes itself.
                    Everything read and still too few is a *volume* problem —
                    telling somebody we have not analysed their reviews when we
                    have is the sort of small lie that costs a screen its
                    credibility. */}
                {t(
                  insufficient.analysedCount >= insufficient.reviewCount
                    ? "thinWeekBodyThin"
                    : "thinWeekBodyPending",
                  {
                    reviews: insufficient.reviewCount,
                    analysed: insufficient.analysedCount,
                  },
                )}
              </p>
              {/* Somewhere to go, not just an apology: the reviews are in the
                  Inbox whether or not we managed to say anything about them. */}
              <Link
                href="/reviews"
                className="inline-flex w-fit items-center gap-1.5 rounded-sm text-body font-medium text-on-ink underline underline-offset-2"
              >
                {t("thinWeekLink")}
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
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
                  locationId={digest.locationId}
                  reviewIds={evidence.reviewIds}
                  // Two, from the quotes the payload already carries — no
                  // second read, and guaranteed to be the same text the model
                  // was shown when it wrote the recommendation above.
                  quotes={evidence.reviewIds
                    .map((id) => quoteById.get(id))
                    .filter((quote): quote is NonNullable<typeof quote> => quote !== undefined)
                    .slice(0, 2)}
                />
              );
            })}
          </ul>
        </section>
      ) : null}

      {/*
        What moved, the loop from last week, and the running record.

        Two different measurements sit side by side here on purpose, and the
        difference is worth knowing when reading them: "Since last week" is a
        *snapshot*, written into the payload when this briefing was composed and
        true as of that moment forever after. "Your record" is read live and
        moves the instant somebody ticks a box. On a fresh digest they agree; on
        a three-month-old one in the archive they will not, and both are right.
      */}
      {panels > 0 ? (
        /*
          Two columns only when there are two things to put in them.

          `md:grid-cols-2` unconditionally meant that an account with no
          week-on-week changes and no prior briefing — which is every account in
          its first fortnight — got one 548px card sitting under an 853px hero
          with the whole right-hand column empty. The card was not narrow; the
          grid was reserving a track for something that had not rendered.
        */
        <section className={cn("grid gap-(--grid-gap)", panels > 1 && "md:grid-cols-2")}>
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

          {record ? <CompletionRecordCard record={record} /> : null}
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
                  <Link href="/reviews">
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

      {/*
        Provenance, not a paragraph.

        This was a bare grey sentence hanging under the last card — the same
        orphan-prose shape `/get-reviews` had. It is a footnote about the
        document above, and on `/weekly-plan` it is also the seam between this
        briefing and the archive list that follows, so it gets a rule and the
        quietest type in the scale rather than body copy's weight. No rule of its
        own: the card above it already ends in a border, and a second hairline
        20px below it reads as a mistake rather than as a separator.
      */}
      {digest.generatedAt ? (
        <p className="text-meta text-faint">
          {t("lastGenerated", { when: format.relativeTime(digest.generatedAt, new Date()) })}
        </p>
      ) : null}
    </div>
  );
}
