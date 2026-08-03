import { PieChart } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { ChartFallback } from "@/components/home/chart-fallback";
import { DonutChart, type DonutDatum } from "@/components/home/donut-chart";
import { WidgetCard } from "@/components/home/widget-card";
import type { SentimentBreakdown } from "@/dashboard/metrics";

/** Sentiment as an interactive ring (widget 5). */
export async function SentimentDonut({ breakdown }: { breakdown: SentimentBreakdown }) {
  const [t, format] = await Promise.all([getTranslations("home.sentiment"), getFormatter()]);

  const { positive, neutral, negative, analysed, pending } = breakdown;
  const percent = (value: number) =>
    format.number(analysed === 0 ? 0 : value / analysed, {
      style: "percent",
      maximumFractionDigits: 0,
    });

  const data: DonutDatum[] = [
    {
      key: "positive",
      label: t("positiveShort"),
      value: positive,
      fill: "fill-sentiment-positive",
    },
    { key: "neutral", label: t("neutralShort"), value: neutral, fill: "fill-sentiment-neutral" },
    {
      key: "negative",
      label: t("negativeShort"),
      value: negative,
      fill: "fill-sentiment-negative",
    },
  ].filter((datum) => datum.value > 0);

  return (
    <WidgetCard title={t("title")} icon={PieChart}>
      {analysed === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <DonutChart
            data={data}
            centerValue={percent(positive)}
            centerLabel={t("positiveShort")}
            countLabel={t("count")}
          />

          <ul className="flex flex-wrap justify-center gap-3 text-[11px] text-muted-foreground">
            {[
              { key: "positive", value: positive, dot: "bg-sentiment-positive" },
              { key: "neutral", value: neutral, dot: "bg-sentiment-neutral" },
              { key: "negative", value: negative, dot: "bg-sentiment-negative" },
            ].map((entry) => (
              <li key={entry.key} className="flex items-center gap-1.5">
                <span className={`size-2 rounded-[3px] ${entry.dot}`} aria-hidden />
                {t(entry.key, { percent: percent(entry.value) })}
              </li>
            ))}
          </ul>

          {pending > 0 ? (
            // Said out loud rather than folded into "neutral": an unanalysed
            // review is not a lukewarm one, and the shares would be wrong.
            <p className="text-center text-[11px] text-muted-foreground">
              {t("pending", { count: pending })}
            </p>
          ) : null}

          <ChartFallback
            caption={t("title")}
            columns={[t("title"), t("count"), "%"]}
            rows={[
              { key: "positive", cells: [t("positiveShort"), positive, percent(positive)] },
              { key: "neutral", cells: [t("neutralShort"), neutral, percent(neutral)] },
              { key: "negative", cells: [t("negativeShort"), negative, percent(negative)] },
            ]}
          />
        </>
      )}
    </WidgetCard>
  );
}
