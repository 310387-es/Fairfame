import { Clock, Star } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { ChartFallback } from "@/components/dashboard/chart-fallback";
import { SectionCard } from "@/components/ds/section-card";
import { Metric } from "@/components/ds/metric";
import { Stars } from "@/components/ds/stars";
import type { RatingBar, ResponsePercentiles } from "@/analytics/trends";
import { cn } from "@/lib/utils";

/**
 * The rating histogram (W4.4).
 *
 * **What the average cannot say.** 3.9 is produced by two very different
 * businesses: one where everybody is mildly pleased, and one where most people
 * love it and a tenth are furious. Only the second has a problem worth chasing,
 * and the mean cannot tell them apart — which is the entire reason a histogram
 * belongs beside it.
 *
 * Five bars, always, including the empty ones. A histogram missing its zeroes
 * is a different shape, and the shape is the whole content.
 */
export async function RatingHistogram({ bars }: { bars: RatingBar[] }) {
  const [t, format] = await Promise.all([getTranslations("insights.histogram"), getFormatter()]);

  const total = bars.reduce((sum, bar) => sum + bar.count, 0);
  // Scaled to the tallest bar, not to the total: at 60% five-star every other
  // bar would be a stub, and the shape of the tail is what this is for.
  const peak = Math.max(...bars.map((bar) => bar.count), 0);

  return (
    <SectionCard title={t("title")} icon={Star} meta={t("meta", { count: total })}>
      {total === 0 ? (
        <p className="pb-(--card-py) text-body text-ink-400">{t("empty")}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5">
            {bars.map((bar) => (
              <li key={bar.rating} className="flex items-center gap-3">
                <span className="w-[74px] shrink-0">
                  <Stars
                    rating={bar.rating}
                    srLabel={t("stars", { count: bar.rating })}
                    className="text-state-rating-text"
                  />
                </span>

                <span
                  role="img"
                  aria-label={t("bar", {
                    count: bar.rating,
                    reviews: bar.count,
                    share: format.number(bar.share / 100, {
                      style: "percent",
                      maximumFractionDigits: 0,
                    }),
                  })}
                  className="h-[9px] flex-1 overflow-hidden rounded-[5px] bg-surface-sunken"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "block h-full rounded-[5px]",
                      // One and two stars are the tail this card exists to
                      // expose. Colouring them is not decoration: on a chart
                      // whose whole point is the shape of the bottom, a
                      // uniform palette hides it.
                      bar.rating <= 2 ? "bg-sentiment-negative" : "bg-amber-500",
                    )}
                    style={{ width: `${peak === 0 ? 0 : (bar.count / peak) * 100}%` }}
                  />
                </span>

                <span className="w-14 shrink-0 text-right font-mono text-meta text-ink-600 tabular-nums">
                  {bar.count}
                </span>
              </li>
            ))}
          </ul>

          <ChartFallback
            caption={t("title")}
            columns={[t("rating"), t("reviews")]}
            rows={bars.map((bar) => ({
              key: String(bar.rating),
              cells: [String(bar.rating), String(bar.count)],
            }))}
          />
        </>
      )}
    </SectionCard>
  );
}

/**
 * Response time at p50, p75 and p90 (W4.4).
 *
 * The median is on Home and it is the right headline; it is also the one number
 * a tail cannot move. **p90 is the promise a business can actually check** —
 * "nine in ten customers heard back within X" — and it is the figure that
 * changes when one complaint sits for a fortnight.
 *
 * The unanswered are stated **beside** the percentiles rather than folded into
 * them, which is the opposite of what Home's distribution does and is right for
 * this shape: a percentile over a set containing "never" is not a duration, it
 * is undefined past whatever share never got a reply.
 */
export async function ResponsePercentilesCard({ times }: { times: ResponsePercentiles }) {
  const t = await getTranslations("insights.percentiles");

  const wait = (hours: number | null) => {
    if (hours === null) return t("noData");
    if (hours < 1) return t("minutes", { count: Math.max(1, Math.round(hours * 60)) });
    if (hours < 48) return t("hours", { count: Math.round(hours * 10) / 10 });
    return t("days", { count: Math.round(hours / 24) });
  };

  const rows = [
    { key: "p50", label: t("p50"), value: times.p50 },
    { key: "p75", label: t("p75"), value: times.p75 },
    { key: "p90", label: t("p90"), value: times.p90 },
  ] as const;

  return (
    <SectionCard title={t("title")} icon={Clock} meta={t("meta", { answered: times.answered })}>
      {times.answered === 0 ? (
        <p className="pb-(--card-py) text-body text-ink-400">{t("empty")}</p>
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-3">
            {rows.map((row) => (
              <div key={row.key}>
                <dt className="text-meta text-faint">{row.label}</dt>
                <dd>
                  <Metric>{wait(row.value)}</Metric>
                </dd>
              </div>
            ))}
          </dl>

          {/*
            Stated, not folded in. A business reading "p90: 6 hours" while
            eleven reviews were never answered at all has been told something
            true and deeply misleading, and the second half of the sentence is
            the half that needs doing something about.
          */}
          {times.unanswered > 0 ? (
            <p className="mt-3 text-meta text-state-negative-text">
              {t("unanswered", { count: times.unanswered })}
            </p>
          ) : null}

          <ChartFallback
            caption={t("title")}
            columns={[t("percentile"), t("wait")]}
            rows={rows.map((row) => ({ key: row.key, cells: [row.label, wait(row.value)] }))}
          />
        </>
      )}
    </SectionCard>
  );
}
