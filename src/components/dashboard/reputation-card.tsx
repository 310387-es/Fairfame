import { getFormatter, getTranslations } from "next-intl/server";
import { KpiRow, KpiRowSkeleton } from "@/components/dashboard/kpi-row";
import { ratingScale } from "@/components/ds/chart-scale";
import { ReputationChart, type ChartPoint } from "@/components/dashboard/reputation-chart";
import { Card } from "@/components/ui/card";
import type { DashboardKpis, SeriesPoint } from "@/dashboard/metrics";
import { TRAILING_DAYS, type Range } from "@/dashboard/range";

/**
 * The chart's frame: title, legend, formatting, and the text equivalent.
 *
 * A server component wrapping a client one, so only the drawing crosses the
 * boundary. Labels are formatted here because the locale lives on the server —
 * shipping raw dates and a formatter to the browser would be a second place for
 * TR and EN to diverge.
 *
 * The table underneath is not decoration. A chart is an image to a screen
 * reader; WCAG 2.1 AA wants the same information available as text, and a
 * visually-hidden table gives every bucket its exact numbers rather than a
 * summary that rounds the interesting parts away.
 */
export async function ReputationCard({
  series,
  range,
  average,
  kpis,
}: {
  series: SeriesPoint[];
  range: Range;
  /** The range-wide average rating, straight from the KPI it is shown beside. */
  average: number | null;
  /**
   * The four headline numbers, rendered as a divided strip along the top of
   * this card. They live here rather than in their own row because the chart
   * *is* the explanation of them — "3.7 stars, up 0.5" and the line that shows
   * where the 0.5 came from are one thought, and a 14px gap between two cards
   * asked the reader to reassemble it.
   */
  kpis: DashboardKpis;
}) {
  const [t, format] = await Promise.all([getTranslations("home.chart"), getFormatter()]);

  const weekly = range === "90d";

  // The legend says "Average rating" and stops there. Smoothing is how the line
  // is drawn, not what it means — naming the mechanism on the chart made a
  // reader think the chart covered a week rather than the range. The table
  // caption, which is where someone goes for precision, still states it.
  const ratingLabel = t("rating");

  const points: ChartPoint[] = series.map((point) => ({
    label: format.dateTime(point.start, { day: "numeric", month: "short" }),
    tooltipLabel: weekly
      ? // A weekly bucket is a span, and labelling it with one date would
        // attribute seven days of reviews to a Monday.
        t("weekOf", {
          start: format.dateTime(point.start, { day: "numeric", month: "short" }),
          end: format.dateTime(new Date(point.end.getTime() - 1), {
            day: "numeric",
            month: "short",
          }),
        })
      : format.dateTime(point.start, { day: "numeric", month: "long" }),
    rating: point.rating,
    volume: point.volume,
  }));

  const total = series.reduce((sum, point) => sum + point.volume, 0);

  /**
   * The rating axis, fitted to the data with padding (W4 fold-in).
   *
   * The tick *labels* are prepared here rather than in the chart for the reason
   * every other label on this card is: the locale lives on the server, and a
   * half-star tick is `4,5` in Turkish. Recharts would have written `4.5`, and
   * nobody would have filed it.
   */
  const scale = ratingScale(series.map((point) => point.rating));
  const ratingTickLabels = Object.fromEntries(
    scale.ticks.map((tick) => [
      String(tick),
      format.number(tick, {
        minimumFractionDigits: scale.decimals,
        maximumFractionDigits: scale.decimals,
      }),
    ]),
  );

  return (
    <Card className="gap-0 py-0">
      <KpiRow kpis={kpis} />

      <div className="flex flex-1 flex-col gap-3 border-t border-line-inner px-(--card-px) pt-4 pb-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-title">{t("title")}</h2>
          <p className="text-meta text-faint">{t(`subtitle.${range}`)}</p>

          {/* The legend rides in the header rather than under the chart. Below
              the plot it was the last thing read, by which point the reader had
              already guessed what the blue line was; beside the title it is
              read before the chart it explains. */}
          {total === 0 ? null : (
            <div className="ml-auto flex gap-3.5 text-meta text-ink-400">
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-3.5 rounded-sm bg-chart-1" aria-hidden />
                {ratingLabel}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-[2px] bg-indigo-100" aria-hidden />
                {t("volume")}
              </span>
              {average !== null ? (
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-0 w-3 border-t border-dashed border-graphic-faint"
                    aria-hidden
                  />
                  {t("average", {
                    range: t(`rangeName.${range}`),
                    value: format.number(average, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    }),
                  })}
                </span>
              ) : null}
            </div>
          )}
        </div>

        {total === 0 ? (
          // Nothing to plot. An empty grid with axes looks like a broken chart;
          // one sentence is honest and takes less room.
          <p className="py-16 text-center text-copy text-muted-foreground">{t("empty")}</p>
        ) : (
          <>
            <ReputationChart
              points={points}
              ratingDomain={scale.domain}
              ratingTicks={scale.ticks}
              ratingTickLabels={ratingTickLabels}
              average={average}
              ratingLabel={ratingLabel}
              volumeLabel={t("volume")}
            />

            {/* One table, hidden from sight and read by assistive technology —
                and revealed by the `<noscript>` stylesheet when scripts are
                off, because Recharts measures its container before it draws and
                that 340px box would otherwise stay empty forever. It is the
                whole dataset, not an apology. */}
            <DataTable
              points={points}
              labels={{
                caption: t("tableCaption", { days: TRAILING_DAYS }),
                period: t("period"),
                volume: t("volume"),
                rating: ratingLabel,
                noRating: t("noRating"),
              }}
            />
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * The chart as text.
 *
 * Rendered once, hidden by `.chart-fallback`, and revealed by the `<noscript>`
 * stylesheet in `app/layout.tsx` when scripts are off — so screen readers meet
 * exactly one copy and a no-JS browser still gets the whole series.
 *
 * The `visible` prop and the second `<noscript>` copy it served are gone: a
 * `<table>` inside a `<noscript>` breaks React's streaming renderer, because a
 * scripted browser parses that content as text and the segment placeholders
 * React streams into it never become nodes. See `globals.css`.
 */
function DataTable({
  points,
  labels,
}: {
  points: ChartPoint[];
  labels: { caption: string; period: string; volume: string; rating: string; noRating: string };
}) {
  return (
    // The class goes on this wrapper, not the table — see `globals.css`.
    <div className="chart-fallback">
      <table className="w-full text-left text-copy">
        <caption className="pb-2 text-muted-foreground">{labels.caption}</caption>
        <thead className="text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 font-medium">
              {labels.period}
            </th>
            <th scope="col" className="py-1 font-medium">
              {labels.volume}
            </th>
            <th scope="col" className="py-1 font-medium">
              {labels.rating}
            </th>
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => (
            // The label is not a key: two buckets can format identically when a
            // range rounds to the same day, and a collapsed row would silently
            // drop a period from the table.
            <tr key={index} className="border-t border-line-soft">
              <th scope="row" className="py-1 font-normal">
                {point.tooltipLabel}
              </th>
              <td className="py-1">{point.volume}</td>
              <td className="py-1">{point.rating ?? labels.noRating}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReputationCardSkeleton() {
  return (
    <Card className="gap-0 py-0" aria-hidden>
      <KpiRowSkeleton />
      <div className="border-t border-line-inner px-(--card-px) pt-4 pb-3">
        <span className="block h-4 w-40 animate-pulse rounded bg-muted" />
        <span className="mt-3 block h-[300px] animate-pulse rounded-md bg-muted" />
      </div>
    </Card>
  );
}
