import { LineChart } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { ReputationChart, type ChartPoint } from "@/components/home/reputation-chart";
import { Card, CardContent } from "@/components/ui/card";
import type { SeriesPoint } from "@/dashboard/metrics";
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
}: {
  series: SeriesPoint[];
  range: Range;
  /** The range-wide average rating, straight from the KPI it is shown beside. */
  average: number | null;
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

  return (
    <Card className="rounded-2xl">
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="grid size-6.5 place-items-center rounded-lg bg-muted text-muted-foreground">
            <LineChart className="size-3.5" aria-hidden />
          </span>
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <p className="ml-auto text-xs text-muted-foreground">{t(`subtitle.${range}`)}</p>
        </div>

        {total === 0 ? (
          // Nothing to plot. An empty grid with axes looks like a broken chart;
          // one sentence is honest and takes less room.
          <p className="py-16 text-center text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <>
            <ReputationChart
              points={points}
              average={average}
              ratingLabel={ratingLabel}
              volumeLabel={t("volume")}
            />

            <div className="flex justify-center gap-4 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-[3px] bg-chart-1" aria-hidden />
                {ratingLabel}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-[3px] bg-chart-1/15" aria-hidden />
                {t("volume")}
              </span>
              {average !== null ? (
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-0 w-3 border-t border-dashed border-muted-foreground"
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

            {/* Recharts measures its container before it draws, so the chart
                exists only after hydration — with scripts off, that 260px box
                stays empty forever. The same table, made visible, is the
                honest fallback: it is the whole dataset, not an apology. */}
            <noscript>
              <DataTable
                visible
                points={points}
                labels={{
                  caption: t("tableCaption", { days: TRAILING_DAYS }),
                  period: t("period"),
                  volume: t("volume"),
                  rating: ratingLabel,
                  noRating: t("noRating"),
                }}
              />
            </noscript>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The chart as text.
 *
 * Rendered twice on purpose: once for screen readers, once inside `<noscript>`
 * for anyone without JavaScript. A browser that runs scripts never parses the
 * second copy, so there is no duplicate for assistive tech to stumble over.
 */
function DataTable({
  points,
  labels,
  visible = false,
}: {
  points: ChartPoint[];
  labels: { caption: string; period: string; volume: string; rating: string; noRating: string };
  visible?: boolean;
}) {
  return (
    <table className={visible ? "w-full text-left text-xs" : "sr-only"}>
      <caption className={visible ? "pb-2 text-muted-foreground" : undefined}>
        {labels.caption}
      </caption>
      <thead className={visible ? "text-muted-foreground" : undefined}>
        <tr>
          <th scope="col" className={visible ? "py-1 font-medium" : undefined}>
            {labels.period}
          </th>
          <th scope="col" className={visible ? "py-1 font-medium" : undefined}>
            {labels.volume}
          </th>
          <th scope="col" className={visible ? "py-1 font-medium" : undefined}>
            {labels.rating}
          </th>
        </tr>
      </thead>
      <tbody>
        {points.map((point, index) => (
          // The label is not a key: two buckets can format identically when a
          // range rounds to the same day, and a collapsed row would silently
          // drop a period from the table.
          <tr key={index} className={visible ? "border-t border-border/60" : undefined}>
            <th scope="row" className={visible ? "py-1 font-normal" : undefined}>
              {point.tooltipLabel}
            </th>
            <td className={visible ? "py-1" : undefined}>{point.volume}</td>
            <td className={visible ? "py-1" : undefined}>{point.rating ?? labels.noRating}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReputationCardSkeleton() {
  return (
    <Card className="rounded-2xl" aria-hidden>
      <CardContent className="flex flex-col gap-3">
        <span className="h-4 w-40 animate-pulse rounded bg-muted" />
        <span className="h-[340px] animate-pulse rounded-lg bg-muted" />
      </CardContent>
    </Card>
  );
}
