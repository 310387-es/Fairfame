import { ArrowRight, Sparkles } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
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
    <div className="flex flex-col gap-3 rounded-2xl bg-primary/6 px-5 py-4 ring-1 ring-primary/15 sm:flex-row sm:items-center sm:gap-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
        <Sparkles className="size-4.5" aria-hidden />
      </span>

      <p className="text-sm leading-relaxed text-pretty">{clauses.join(" ")}</p>

      {insight.waiting > 0 ? (
        <Button asChild size="sm" className="shrink-0 sm:ml-auto">
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
