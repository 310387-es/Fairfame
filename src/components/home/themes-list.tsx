import { Tags } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { HorizontalBarChart, type BarDatum } from "@/components/home/bar-chart";
import { ChartFallback } from "@/components/home/chart-fallback";
import { WidgetCard } from "@/components/home/widget-card";
import type { ThemeRow } from "@/dashboard/metrics";

/**
 * What people talked about (widget 7).
 *
 * The bar's colour is the dominant sentiment, not the count: "cleanliness, 22
 * mentions" means opposite things depending on whether those were compliments
 * or complaints, and a uniformly blue chart hides the difference.
 *
 * The header link goes to the Inbox; the bars themselves do not navigate, so a
 * stray click while reading the chart cannot take the page out from under you.
 */
export async function ThemesList({ rows }: { rows: ThemeRow[] }) {
  const t = await getTranslations("home.themes");

  const mood = (row: ThemeRow) =>
    row.dominant === "negative"
      ? t("mostlyNegative", { count: row.negative })
      : row.dominant === "positive"
        ? t("mostlyPositive", { count: row.positive })
        : t("mixed");

  const data: BarDatum[] = rows.map((row) => ({
    key: row.slug,
    label: row.slug,
    value: row.count,
    fill:
      row.dominant === "negative"
        ? "fill-sentiment-negative"
        : row.dominant === "positive"
          ? "fill-sentiment-positive"
          : "fill-sentiment-neutral",
    detail: mood(row),
  }));

  return (
    <WidgetCard title={t("title")} icon={Tags} link={{ href: "/inbox", label: t("all") }}>
      {rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <HorizontalBarChart
            data={data}
            valueLabel={t("count")}
            height={Math.max(160, rows.length * 40)}
          />
          <ChartFallback
            caption={t("title")}
            columns={[t("title"), t("count"), t("mood")]}
            rows={data.map((datum, index) => ({
              key: datum.key,
              cells: [datum.label, datum.value, mood(rows[index]!)],
            }))}
          />
        </>
      )}
    </WidgetCard>
  );
}
