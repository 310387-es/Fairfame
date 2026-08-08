import { Filter } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { ChartFallback } from "@/components/dashboard/chart-fallback";
import { SectionCard } from "@/components/ds/section-card";
import { Eyebrow } from "@/components/ds/eyebrow";
import { funnelStages, type CollectionFunnel } from "@/collect/funnel";
import { FUNNEL_DAYS } from "@/collect/funnel";
import { cn } from "@/lib/utils";

/**
 * The collection funnel, across the top (W4.5).
 *
 * ## Three stages, and the two that are missing say why
 *
 * `docs/remediation-plan.md` asks for five. `src/collect/funnel.ts` records why
 * Delivered and Clicked are not among them — neither is measurable without a
 * transport receipt or a tracking pixel, and a column that is permanently empty
 * teaches the reader that the columns are decoration.
 *
 * ## Two percentages per stage, not one
 *
 * "Half the people who opened it left a review" is about the page. "One in six
 * of everyone we asked left a review" is about the campaign. A funnel showing
 * only step-to-step rates lets a business feel excellent about a 90% conversion
 * on the four people who opened it, which is the most common way a funnel
 * flatters.
 *
 * ## Walk-ins are beside the funnel, not in it
 *
 * A QR code on a table is not a send. Nobody was asked, so there is no `sent`
 * to convert from — and on a Turkish café the scans are frequently the largest
 * number on this screen, which is exactly why they must not be filed under a
 * column reading 0%.
 */
export async function FunnelStrip({ funnel }: { funnel: CollectionFunnel }) {
  const [t, format] = await Promise.all([getTranslations("requests.funnel"), getFormatter()]);

  const stages = funnelStages(funnel.total);
  const percent = (value: number | null) =>
    value === null
      ? null
      : format.number(value / 100, { style: "percent", maximumFractionDigits: 0 });

  const channelRows = funnel.byChannel.map((row) => ({
    key: row.channel,
    label: t(`channel.${row.channel}`),
    stages: funnelStages(row),
  }));

  return (
    <SectionCard title={t("title")} icon={Filter} meta={t("meta", { days: FUNNEL_DAYS })}>
      {funnel.total.sent === 0 && funnel.walkIn === 0 ? (
        <p className="pb-(--card-py) text-body text-ink-400">{t("empty")}</p>
      ) : (
        <div className="flex flex-col gap-5 pb-(--card-py)">
          <ol className="grid gap-2 sm:grid-cols-3">
            {stages.map((stage, index) => (
              <li
                key={stage.key}
                className="rounded-md border border-line-soft bg-surface-sunken/40 px-3 py-2.5"
              >
                {/*
                  `text-subtitle` was here and **is not a token** — it resolves
                  to nothing, so this number rendered at the card's inherited
                  13px while the campaign card's identical statistic sat at a
                  hardcoded 17px, two hundred pixels away on the same screen.
                  Two treatments of one thing, and neither was the scale.
                */}
                <Eyebrow>{t(`stage.${stage.key}`)}</Eyebrow>
                <p className="mt-1 text-lead font-semibold text-foreground tabular-nums">
                  {format.number(stage.count)}
                </p>

                {/*
                  The first stage has nothing above it, so it carries no rate —
                  "100% of the people we asked were asked" is a sentence, and a
                  meaningless one.
                */}
                {index === 0 ? null : (
                  <p className="mt-1 text-meta text-ink-500">
                    {percent(stage.ofPrevious) ?? "—"}{" "}
                    <span className="text-faint">
                      {t(`ofPrevious.${stage.key}`)}
                      {stage.key === "submitted" && stage.ofSent !== null
                        ? ` · ${percent(stage.ofSent)} ${t("ofSent")}`
                        : null}
                    </span>
                  </p>
                )}
              </li>
            ))}
          </ol>

          {channelRows.length > 1 ? (
            <div>
              <p className="mb-2 text-meta text-faint">{t("byChannel")}</p>

              <ul className="flex flex-col gap-1.5">
                {channelRows.map((row) => {
                  const done = row.stages[2]!;

                  return (
                    <li key={row.key} className="flex items-center gap-3">
                      <span className="w-[92px] shrink-0 truncate text-copy text-ink-600">
                        {row.label}
                      </span>

                      <span
                        role="img"
                        aria-label={t("channelSr", {
                          channel: row.label,
                          sent: row.stages[0]!.count,
                          submitted: done.count,
                          rate: percent(done.ofSent) ?? "—",
                        })}
                        className="h-[9px] flex-1 overflow-hidden rounded-[5px] bg-surface-sunken"
                      >
                        {/*
                          The bar is the **conversion**, not the volume: a
                          channel comparison exists to answer "which one works",
                          and drawing volume would answer "which one we used
                          most", which the counts beside it already say.
                        */}
                        <span
                          aria-hidden
                          className={cn(
                            "block h-full rounded-[5px]",
                            (done.ofSent ?? 0) > 0 ? "bg-primary" : "bg-graphic-faint",
                          )}
                          style={{ width: `${Math.min(100, done.ofSent ?? 0)}%` }}
                        />
                      </span>

                      <span className="w-24 shrink-0 text-right font-mono text-meta text-ink-500 tabular-nums">
                        {percent(done.ofSent) ?? "—"}
                        <span className="text-faint"> · {row.stages[0]!.count}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {funnel.walkIn > 0 ? (
            <p className="text-body text-ink-500">
              {t("walkIn", { count: funnel.walkIn })}{" "}
              <span className="text-faint">{t("walkInNote")}</span>
            </p>
          ) : null}

          <ChartFallback
            caption={t("title")}
            columns={[t("column.stage"), t("column.count")]}
            rows={stages.map((stage) => ({
              key: stage.key,
              cells: [t(`stage.${stage.key}`), String(stage.count)],
            }))}
          />
        </div>
      )}
    </SectionCard>
  );
}
