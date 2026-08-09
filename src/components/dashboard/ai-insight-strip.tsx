import { ArrowRight, Sparkles } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { IconTile } from "@/components/ds/icon-tile";
import { Button } from "@/components/ui/button";
import type { Insight } from "@/dashboard/insight";
import type { Range } from "@/dashboard/range";

/**
 * The one line that says what to do about right now.
 *
 * Three clauses, each dropped when it has nothing to say, so the strip is never
 * padded into sounding informative: who is waiting, what they are unhappy
 * about, and whether the rating is holding. A quiet week says so in one clause
 * and offers no call to action, because there is no action.
 *
 * The sentence is assembled from counts rather than generated — see
 * `dashboard/insight.ts` for why that is a feature and not a shortcut.
 *
 * **Both counts say what they count** (A22-A3). The first clause is *negative*
 * reviews needing a reply, not every unanswered item, and the copy says
 * "negative" — the Inbox's own "Needs a reply" is a wider number, and two
 * different figures under the same words is what made the cafe-owner test
 * distrust every number on the product. The second is a subset of the first, so
 * it can never exceed it; it used to be counted independently, and printed "7
 * of 6" on a real account. And "nothing is waiting" now says *negative*
 * nothing, because a business with thirty unanswered five-star reviews was
 * being told its queue was clear.
 */
export async function AiInsightStrip({ insight, range }: { insight: Insight; range: Range }) {
  const [t, tHome, tThemes, format] = await Promise.all([
    getTranslations("home.insight"),
    getTranslations("home"),
    // Canonical theme names, the same catalogue the attention queue and the
    // heatmap read — so one theme is one word wherever it appears.
    getTranslations("themes"),
    getFormatter(),
  ]);

  const clauses: string[] = [];

  /**
   * The window, in the sentence (A22-A3).
   *
   * The strip sits under a 7/30/90 selector and said only "6 waiting", while
   * the Inbox queue it links to counts everything ever received. Clicking
   * through from six to nine looks like a product that cannot count; it is two
   * honest answers to two different questions, and the only fix is for the
   * sentence to say which question it answered.
   */
  const rangeLabel = tHome(`range.${range}.long`);

  clauses.push(
    insight.waiting > 0
      ? t("waiting", { count: insight.waiting, range: rangeLabel })
      : t("clear", { range: rangeLabel }),
  );

  if (insight.theme && insight.themeNegatives > 0) {
    clauses.push(
      t("theme", {
        count: insight.themeNegatives,
        theme: tThemes(insight.theme.slug),
      }),
    );
  }

  if (insight.rating !== null) {
    const rating = format.number(insight.rating, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });

    clauses.push(
      insight.ratingDelta === null || insight.ratingDelta === 0
        ? t("ratingHolding", { rating })
        : insight.ratingDelta > 0
          ? t("ratingUp", { rating })
          : t("ratingDown", { rating }),
    );
  }

  return (
    // Ink, not a tinted indigo wash. This is the page's one voice and it has to
    // outrank four KPI cells and a chart directly beneath it; a 6% wash of the
    // brand colour lost that contest and read as one more widget. Together with
    // the rail it is the only full-bleed colour on the screen.
    <div className="flex flex-col gap-3.5 rounded-lg bg-brief px-[22px] py-[18px] text-on-ink sm:flex-row sm:items-center sm:gap-[18px]">
      <IconTile icon={Sparkles} tone="solid" size="lg" />

      <p className="max-w-[780px] text-base leading-normal text-pretty">{clauses.join(" ")}</p>

      {insight.waiting > 0 ? (
        <Button asChild variant="brief" className="shrink-0 sm:ml-auto">
          {/* Straight to the filtered Inbox rather than a vague "open Inbox":
              the strip named a number, and the link has to show that number. */}
          <Link href="/reviews?sentiment=negative&reply=unanswered">
            {t("replyNow")}
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      ) : (
        // Only when there is nothing waiting. The strip gets one call to
        // action, and "reply to these four people" outranks "read last week"
        // every time; offering both would make the urgent one optional.
        <Button asChild variant="brief" className="shrink-0 sm:ml-auto">
          <Link href="/weekly-plan">
            {t("viewDigest")}
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      )}
    </div>
  );
}
