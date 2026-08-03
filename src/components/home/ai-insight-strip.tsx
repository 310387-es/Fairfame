import { ArrowRight, Sparkles } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { IconTile } from "@/components/ds/icon-tile";
import { Button } from "@/components/ui/button";
import type { Insight } from "@/dashboard/insight";

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
 */
export async function AiInsightStrip({ insight }: { insight: Insight }) {
  const [t, format] = await Promise.all([getTranslations("home.insight"), getFormatter()]);

  const clauses: string[] = [];

  clauses.push(insight.waiting > 0 ? t("waiting", { count: insight.waiting }) : t("clear"));

  if (insight.theme && insight.themeNegatives > 0) {
    clauses.push(
      t("theme", {
        count: insight.themeNegatives,
        theme: insight.theme.slug,
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
          <Link href="/inbox?sentiment=negative&reply=unanswered">
            {t("replyNow")}
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
