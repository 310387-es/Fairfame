import { Clock } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Delta, Metric } from "@/components/ds/metric";
import { SectionCard } from "@/components/ds/section-card";
import { ChartFallback } from "@/components/dashboard/chart-fallback";
import type { ResponseBucket, ResponseTimes } from "@/dashboard/metrics";
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
 *
 * The radial dial that used to sit on the left is gone. It was a 120px ring
 * drawn by a client-side chart library to encode a single percentage, which a
 * straight bar does at a tenth of the height and with no JavaScript — and the
 * ring's own label had to repeat the number anyway, because nobody reads an
 * arc to two significant figures.
 */

function formatWait(
  hours: number,
  t: (key: string, values?: Record<string, string | number | Date>) => string,
) {
  if (hours < 1) return t("minutes", { count: Math.max(1, Math.round(hours * 60)) });
  if (hours < 48) return t("hours", { count: Math.round(hours * 10) / 10 });
  return t("days", { count: Math.round(hours / 24) });
}

export async function ResponseTime({
  times,
  distribution,
}: {
  times: ResponseTimes;
  distribution: ResponseBucket[];
}) {
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
    <SectionCard
      title={t("title")}
      icon={Clock}
      action={
        faster === null ? <span className="text-meta text-faint">{t("noComparison")}</span> : null
      }
      // This card carries the least content in its row, so the grid stretches it
      // to match its neighbour. Centring the body puts the slack above and below
      // rather than all of it underneath, where it read as a card that had
      // failed to load the rest of itself.
      bodyClassName="flex flex-col justify-center"
    >
      {medianHours === null ? (
        // Nothing has been answered, so there is no wait to report. Saying so
        // beats a confident "0h" that would read as instant service.
        <p className="py-10 text-center text-copy text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <div className="flex items-center gap-5">
            <div className="shrink-0">
              <Metric>{formatWait(medianHours, t)}</Metric>
              <p className="mt-1.5 text-meta text-ink-400">{t("median")}</p>

              {faster === null ? null : (
                <Delta
                  direction={faster}
                  label={faster ? t("faster", { change: "" }) : t("slower", { change: "" })}
                  className="mt-2 block"
                >
                  {changeShare === null
                    ? t(faster ? "faster" : "slower", { change: "" })
                    : t(faster ? "faster" : "slower", {
                        change: format.number(changeShare, {
                          style: "percent",
                          maximumFractionDigits: 0,
                        }),
                      })}
                </Delta>
              )}
            </div>

            {/*
              The distribution, which is what the median cannot say (W4.3).

              A 4-hour median with a fifth of the queue sitting for a week is a
              real problem the median hides *by construction* — it is exactly
              the statistic a tail cannot move. So the buckets sit beside it,
              and the unanswered are in them: a queue that never got a reply is
              the worst response time there is, and drawing this over answered
              reviews only would be the same flattery as measuring satisfaction
              among the people who did not leave.
            */}
            <div className="min-w-0 flex-1">
              <ul className="flex flex-col gap-1.5">
                {distribution.map((bucket) => (
                  <li key={bucket.key} className="flex items-center gap-2.5">
                    <span className="w-[86px] shrink-0 text-meta text-ink-500">
                      {t(`bucket.${bucket.key}`)}
                    </span>

                    <span
                      role="img"
                      aria-label={t("bucketSr", {
                        bucket: t(`bucket.${bucket.key}`),
                        count: bucket.count,
                        share: format.number(bucket.share / 100, {
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
                          // The terminal bucket is the only one drawn as a
                          // problem. Amber for "slower", because late is not
                          // the same failure as never.
                          bucket.key === "unanswered"
                            ? "bg-sentiment-negative"
                            : bucket.key === "slower"
                              ? "bg-sentiment-neutral"
                              : "bg-primary",
                        )}
                        style={{ width: `${Math.min(100, bucket.share)}%` }}
                      />
                    </span>

                    <span className="w-7 shrink-0 text-right font-mono text-meta text-ink-800 tabular-nums">
                      {bucket.count}
                    </span>
                  </li>
                ))}
              </ul>

              <p className="mt-2.5 text-meta text-faint">
                {t("withinDay")} · <strong className="font-mono tabular-nums">{share}</strong> ·{" "}
                {t("replied", { count: replied })}
              </p>
            </div>
          </div>

          <ChartFallback
            caption={t("title")}
            columns={[tHome("metric"), tHome("value")]}
            rows={[
              { key: "median", cells: [t("median"), formatWait(medianHours, t)] },
              { key: "within", cells: [t("withinDay"), share] },
              // The distribution belongs in the text alternative too: it is the
              // half of this card that a bar chart is the only rendering of.
              ...distribution.map((bucket) => ({
                key: bucket.key,
                cells: [t(`bucket.${bucket.key}`), String(bucket.count)],
              })),
            ]}
          />
        </>
      )}
    </SectionCard>
  );
}
