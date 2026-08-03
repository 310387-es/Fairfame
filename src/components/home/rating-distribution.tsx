import { Star } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { HorizontalBarChart, type BarDatum } from "@/components/home/bar-chart";
import { ChartFallback } from "@/components/home/chart-fallback";
import { WidgetCard } from "@/components/home/widget-card";
import type { RatingBucket } from "@/dashboard/metrics";

/**
 * Five to one (widget 8).
 *
 * Always all five rungs, even the empty ones: a ladder missing its 2★ row reads
 * as "no data for that" rather than "nobody left two stars", and the shape of
 * the ladder is the whole point.
 *
 * Like the other bar charts, it is read-only: hovering names the rung and its
 * count, and nothing navigates.
 */
/**
 * One colour per rung, green at five down to red at one, with three on the
 * amber middle where an average belongs. A rating is an ordered scale, so the
 * colours are ordered too — three buckets would say four and five are the same
 * thing, and they are not.
 *
 * Written out rather than built as `fill-rating-${rating}`: Tailwind generates
 * utilities by scanning source text, so an interpolated class name is a class
 * that never gets emitted — the bars would render with no fill at all.
 */
const FILLS: Record<number, string> = {
  5: "fill-rating-5",
  4: "fill-rating-4",
  3: "fill-rating-3",
  2: "fill-rating-2",
  1: "fill-rating-1",
};

export async function RatingDistribution({ buckets }: { buckets: RatingBucket[] }) {
  const t = await getTranslations("home.distribution");
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);

  const data: BarDatum[] = buckets.map((bucket) => ({
    key: String(bucket.rating),
    label: t("stars", { count: bucket.rating }),
    value: bucket.count,
    fill: FILLS[bucket.rating] ?? "fill-rating-3",
  }));

  return (
    <WidgetCard title={t("title")} icon={Star}>
      {total === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <HorizontalBarChart data={data} valueLabel={t("count")} height={215} />
          <ChartFallback
            caption={t("title")}
            columns={[t("title"), t("count")]}
            rows={data.map((datum) => ({ key: datum.key, cells: [datum.label, datum.value] }))}
          />
        </>
      )}
    </WidgetCard>
  );
}
