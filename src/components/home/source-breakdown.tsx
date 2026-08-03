import { Layers } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { HorizontalBarChart, type BarDatum } from "@/components/home/bar-chart";
import { ChartFallback } from "@/components/home/chart-fallback";
import { WidgetCard } from "@/components/home/widget-card";
import { describeProvider } from "@/connectors/capability-view";
import type { SourceRow } from "@/dashboard/metrics";

/**
 * Where the reviews came from (widget 6).
 *
 * Only sources that actually produced something appear — a permanent
 * "Trustpilot 0" row is a product brochure, not a breakdown of this week.
 */
export async function SourceBreakdown({ rows }: { rows: SourceRow[] }) {
  const [t, format] = await Promise.all([getTranslations("home.sources"), getFormatter()]);

  const rating = (value: number | null) =>
    value === null
      ? // Instagram comments carry no stars; claiming an average would invent one.
        t("noRating")
      : t("average", {
          rating: format.number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
        });

  const data: BarDatum[] = rows.map((row) => ({
    key: row.source,
    label: describeProvider(row.source)?.label ?? row.source,
    value: row.count,
    fill: "fill-chart-1",
    detail: rating(row.rating),
  }));

  return (
    <WidgetCard title={t("title")} icon={Layers}>
      {rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <HorizontalBarChart
            data={data}
            valueLabel={t("count")}
            height={Math.max(160, rows.length * 44)}
          />
          <ChartFallback
            caption={t("title")}
            columns={[t("title"), t("count"), t("rating")]}
            rows={data.map((datum, index) => ({
              key: datum.key,
              cells: [datum.label, datum.value, rating(rows[index]?.rating ?? null)],
            }))}
          />
        </>
      )}
    </WidgetCard>
  );
}
