import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCheck,
  MessageSquare,
  Star,
  TrendingUp,
} from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import type { ComponentType } from "react";
import { Sparkline } from "@/components/home/sparkline";
import { Card, CardContent } from "@/components/ui/card";
import { isImprovement, type Kpi, type KpiKey } from "@/dashboard/metrics";
import { cn } from "@/lib/utils";

/**
 * One headline number, its change, and the shape of how it got there.
 *
 * The three answer different questions and all three are needed: 4.6 stars is
 * meaningless without knowing it was 4.4 last month, and "up 0.2" is meaningless
 * without knowing whether it climbed steadily or fell and recovered.
 */

const ICONS: Record<KpiKey, ComponentType<{ className?: string }>> = {
  reputation: TrendingUp,
  rating: Star,
  volume: MessageSquare,
  responseRate: CheckCheck,
};

/** Amber is the rating colour throughout the product; the rest are brand. */
const ACCENT: Record<KpiKey, string> = {
  reputation: "bg-primary/10 text-primary",
  rating: "bg-rating/15 text-rating-ink",
  volume: "bg-primary/10 text-primary",
  responseRate: "bg-primary/10 text-primary",
};

export async function KpiCard({ kpi }: { kpi: Kpi }) {
  const [t, format] = await Promise.all([getTranslations("home.kpi"), getFormatter()]);

  const Icon = ICONS[kpi.key];
  const better = isImprovement(kpi);

  const value =
    kpi.value === null
      ? t("noValue")
      : kpi.unit === "rating"
        ? format.number(kpi.value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        : kpi.unit === "percent"
          ? format.number(kpi.value / 100, { style: "percent", maximumFractionDigits: 0 })
          : format.number(kpi.value, { maximumFractionDigits: 1 });

  // The sign lives in the arrow, so the number itself is always positive —
  // "−3.1% down" reads as a double negative.
  //
  // Point scales carry their unit. A response rate moving 75% → 50% fell 25
  // *points*, and a bare "25" beside a down arrow invites reading it as 25%,
  // which is the same lie the maths already refuses to tell.
  const magnitude =
    kpi.delta === null
      ? null
      : kpi.unit === "count"
        ? format.number(Math.abs(kpi.delta) / 100, { style: "percent", maximumFractionDigits: 1 })
        : kpi.unit === "rating"
          ? format.number(Math.abs(kpi.delta), { maximumFractionDigits: 1 })
          : t("points", {
              value: format.number(Math.abs(kpi.delta), { maximumFractionDigits: 1 }),
            });

  return (
    <Card className="rounded-2xl">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className={cn("grid size-7 place-items-center rounded-lg", ACCENT[kpi.key])}>
            <Icon className="size-4" />
          </span>
          {t(`${kpi.key}.label`)}
        </div>

        <div className="flex items-end justify-between gap-2">
          <p className="font-heading text-3xl leading-none font-bold tracking-tight">
            {kpi.value === null ? (
              <>
                <span aria-hidden>{value}</span>
                <span className="sr-only">{t("noData")}</span>
              </>
            ) : (
              value
            )}
          </p>

          <Sparkline
            points={kpi.spark}
            // `--destructive`, not `--sentiment-negative`: a falling KPI is a
            // number going the wrong way, not a customer feeling bad. Keeping
            // the sentiment tokens for sentiment is the whole point of naming
            // them separately.
            className={better === false ? "text-destructive" : "text-primary"}
          />
        </div>

        <div>
          {magnitude === null ? (
            // No comparison rather than a fabricated one: a first period, or a
            // previous period with nothing in it, has no honest delta.
            <span className="text-[11px] text-muted-foreground">{t("noComparison")}</span>
          ) : (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
                better === null && "bg-muted text-muted-foreground",
                better === true && "bg-positive/12 text-positive-ink",
                better === false && "bg-destructive/12 text-destructive-ink",
              )}
            >
              {better === true ? (
                <ArrowUpRight className="size-3" aria-hidden />
              ) : better === false ? (
                <ArrowDownRight className="size-3" aria-hidden />
              ) : null}
              {/* Direction is stated in words as well as colour and arrow: AA
                  forbids colour as the only carrier of meaning. */}
              <span className="sr-only">
                {better === true ? t("up") : better === false ? t("down") : t("flat")}
              </span>
              {magnitude}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
