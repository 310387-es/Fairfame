import { Clock } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { ChartFallback } from "@/components/home/chart-fallback";
import { RadialShare } from "@/components/home/radial-chart";
import { WidgetCard } from "@/components/home/widget-card";
import type { ResponseTimes } from "@/dashboard/metrics";
import { cn } from "@/lib/utils";

/**
 * How long people wait (widget 9).
 *
 * A median, not a mean — one review answered three weeks late would drag an
 * average past anything a customer would recognise.
 *
 * This is the one metric on the page where **down is good**, which is why the
 * trend is computed here rather than through `isImprovement`: a shared helper
 * that assumed "up is better" would paint a slower reply time green.
 */

function formatWait(
  hours: number,
  t: (key: string, values?: Record<string, string | number | Date>) => string,
) {
  if (hours < 1) return t("minutes", { count: Math.max(1, Math.round(hours * 60)) });
  if (hours < 48) return t("hours", { count: Math.round(hours * 10) / 10 });
  return t("days", { count: Math.round(hours / 24) });
}

export async function ResponseTime({ times }: { times: ResponseTimes }) {
  const [t, tHome, format] = await Promise.all([
    getTranslations("home.response"),
    getTranslations("home"),
    getFormatter(),
  ]);

  const { medianHours, previousMedianHours, withinDayShare, replied } = times;

  const faster =
    medianHours === null || previousMedianHours === null || medianHours === previousMedianHours
      ? null
      : medianHours < previousMedianHours;

  const changeShare =
    medianHours !== null && previousMedianHours !== null && previousMedianHours > 0
      ? Math.abs(medianHours - previousMedianHours) / previousMedianHours
      : null;

  const share = format.number((withinDayShare ?? 0) / 100, {
    style: "percent",
    maximumFractionDigits: 0,
  });

  return (
    <WidgetCard title={t("title")} icon={Clock}>
      {medianHours === null ? (
        // Nothing has been answered, so there is no wait to report. Saying so
        // beats a confident "0h" that would read as instant service.
        <p className="py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          {/* Dial, then figures immediately beside it, with the text block
              taking whatever width is left. `justify-between` pushed the two
              apart and opened a gap down the middle of the card; a fixed gap
              plus `flex-1` on the text keeps them reading as one unit and
              still reaches the right edge. `flex-1` on the row itself lets it
              centre vertically in a card the grid has stretched to match its
              taller neighbours. The fallback table sits outside this row: as a
              flex sibling it became a stray column with scripts off. */}
          <div className="flex w-full flex-1 items-center gap-5 py-1">
            <RadialShare
              value={withinDayShare ?? 0}
              display={share}
              label={t("withinDay")}
              centerLabel={t("withinDayShort")}
            />

            <div className="min-w-0 flex-1">
              <p className="font-heading text-3xl leading-none font-bold tracking-tight">
                {formatWait(medianHours, t)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t("median")}</p>

              {faster === null ? (
                <p className="mt-2 text-[11px] text-muted-foreground">{t("noComparison")}</p>
              ) : (
                <p
                  className={cn(
                    "mt-2 text-[11px] font-semibold",
                    faster ? "text-positive-ink" : "text-destructive-ink",
                  )}
                >
                  {faster ? "↓ " : "↑ "}
                  {changeShare === null
                    ? t(faster ? "faster" : "slower", { change: "" })
                    : t(faster ? "faster" : "slower", {
                        change: format.number(changeShare, {
                          style: "percent",
                          maximumFractionDigits: 0,
                        }),
                      })}
                </p>
              )}

              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("replied", { count: replied })}
              </p>
            </div>
          </div>

          <ChartFallback
            caption={t("title")}
            columns={[tHome("metric"), tHome("value")]}
            rows={[
              { key: "median", cells: [t("median"), formatWait(medianHours, t)] },
              {
                key: "within",
                cells: [t("withinDay"), share],
              },
            ]}
          />
        </>
      )}
    </WidgetCard>
  );
}
