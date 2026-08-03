import { getFormatter, getTranslations } from "next-intl/server";
import { Eyebrow } from "@/components/ds/eyebrow";
import { Delta, Metric } from "@/components/ds/metric";
import { Sparkline } from "@/components/home/sparkline";
import { isImprovement, type Kpi } from "@/dashboard/metrics";

/**
 * One headline number, its change, and the shape of how it got there.
 *
 * The three answer different questions and all three are needed: 4.6 stars is
 * meaningless without knowing it was 4.4 last month, and "up 0.2" is meaningless
 * without knowing whether it climbed steadily or fell and recovered.
 *
 * This is a *cell*, not a card. Four cards in a row put a border, a corner and a
 * shadow around each number and made the strip read as four unrelated facts;
 * they are four readings of one thing, so they now share one card and are
 * separated by a hairline. The lost chrome bought the space that the reputation
 * chart underneath them needed.
 *
 * The old icon tile went with it. A star beside "Average rating" and a message
 * bubble beside "New reviews" decorated labels that already said those words —
 * and at 28px the number should be the only thing with weight in the cell.
 */
export async function KpiCard({ kpi }: { kpi: Kpi }) {
  const [t, format] = await Promise.all([getTranslations("home.kpi"), getFormatter()]);

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
    <div className="px-[18px] py-4">
      <Eyebrow className="mb-2">{t(`${kpi.key}.label`)}</Eyebrow>

      <div className="flex items-end gap-2">
        {/* Only the rating is tinted. It is the one number here that is itself a
            judgement on the amber scale; colouring the other three would say
            everything is significant, which says nothing. */}
        <Metric tone={kpi.key === "rating" ? "rating" : "default"}>
          {kpi.value === null ? (
            <>
              <span aria-hidden>{value}</span>
              <span className="sr-only">{t("noData")}</span>
            </>
          ) : (
            value
          )}
        </Metric>

        {magnitude === null ? null : (
          <Delta
            direction={better}
            label={better === true ? t("up") : better === false ? t("down") : t("flat")}
            className="pb-[3px]"
          >
            {magnitude}
          </Delta>
        )}
      </div>

      {magnitude === null ? (
        // No comparison rather than a fabricated one: a first period, or a
        // previous period with nothing in it, has no honest delta.
        <p className="mt-2 text-meta text-faint">{t("noComparison")}</p>
      ) : null}

      <Sparkline
        points={kpi.spark}
        // `--destructive`, not `--sentiment-negative`: a falling KPI is a
        // number going the wrong way, not a customer feeling bad. Keeping
        // the sentiment tokens for sentiment is the whole point of naming
        // them separately.
        className={better === false ? "mt-2.5 text-destructive" : "mt-2.5 text-primary"}
      />
    </div>
  );
}
