import { getFormatter, getTranslations } from "next-intl/server";
import { RATING_WEIGHT, SENTIMENT_WEIGHT } from "@/digest/metrics";
import { Eyebrow } from "@/components/ds/eyebrow";
import { Delta, Metric } from "@/components/ds/metric";
import { TrendSparkline } from "@/components/dashboard/sparkline";
import { isImprovement, type Kpi } from "@/dashboard/metrics";
import { cn } from "@/lib/utils";

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

/**
 * How the score is made, in the reader's language.
 *
 * The percentages come from the weights the maths actually uses, so the
 * sentence cannot drift from the formula — a hint claiming 65/35 beside a score
 * computed 50/50 would be worse than none, because it would be believed.
 *
 * Exported because it renders in two places and must be one sentence: inside
 * the tile from `lg` up, and under the whole strip below it, where `KpiRow` puts
 * it so four lines of text cannot unbalance a two-across grid.
 */
export function reputationHint(t: (key: string, values: Record<string, number>) => string): string {
  return t("reputation.hint", {
    rating: Math.round(RATING_WEIGHT * 100),
    sentiment: Math.round(SENTIMENT_WEIGHT * 100),
  });
}

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

  /**
   * How the score is made, in the reader's language.
   *
   * The percentages come from the weights the maths actually uses, so the
   * sentence cannot drift from the formula — a tooltip claiming 65/35 beside a
   * score computed 50/50 would be worse than no tooltip, because it would be
   * believed.
   */
  const explanation = kpi.key === "reputation" ? reputationHint(t) : null;

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
        ? format.number(Math.abs(kpi.delta) / 100, {
            style: "percent",
            /*
              No decimal past 100%.

              A count's delta is a percentage change, and off a small base it
              gets large fast: seven reviews to fifty printed "614.3%", where
              the tenth of a percent is noise dressed as precision — nobody
              acts differently at 614.3 than at 614. Below 100 the decimal
              still earns its place, because 4.2% and 4.9% are different weeks.
            */
            maximumFractionDigits: Math.abs(kpi.delta) >= 100 ? 0 : 1,
          })
        : kpi.unit === "rating"
          ? format.number(Math.abs(kpi.delta), { maximumFractionDigits: 1 })
          : /**
             * **Points and percentage points are not the same unit** (W3.3).
             *
             * The reputation score is 0–100, so a change in it is *points*. The
             * response rate is already a percentage, so a change in it is
             * *percentage points* — "39% up 4 pts" reads as "up to 43% of the
             * previous 39%", which is a different and much larger claim than
             * the one the arithmetic makes. Both said "pts" until now, and
             * Turkish "puan" hides the difference in the launch locale, which
             * is why it survived.
             */
            t(kpi.unit === "percent" ? "percentagePoints" : "points", {
              value: format.number(Math.abs(kpi.delta), { maximumFractionDigits: 1 }),
            });

  return (
    <div className="px-[18px] py-4">
      {/*
        The reputation score is the only figure here that is *composed* rather
        than counted, so it is the only one somebody can misread without
        knowing how (W3.3). "70" says nothing about whether it is out of five,
        out of ten, or how stars and words were weighed.

        A native `title` rather than a tooltip component: the design system has
        none, and adding a dependency for one line of explanation is not a
        trade worth making. The same sentence is repeated `sr-only` because a
        `title` on a non-interactive span is not reliably announced, and the
        explanation is exactly the sort of thing a screen-reader user needs
        most.
      */}
      <Eyebrow className="mb-2">{t(`${kpi.key}.label`)}</Eyebrow>

      {/* `flex-wrap` so a delta that cannot fit beside the number drops under
          it whole, rather than the delta itself breaking mid-unit — see the
          `whitespace-nowrap` on `Delta`. Turkish is what forces this: "yüzde
          puan" where English says "pp". */}
      <div className="flex flex-wrap items-end gap-x-2 gap-y-1">
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

        {/*
          The scale, stated (W4.3).

          "73" is the one figure in this strip that names no unit — a rating is
          obviously out of five, a count is a count, a percentage carries its
          own sign, and a composed 0–100 score carries nothing. Somebody
          reading it as a percentage, or as 73 reviews, has misread the most
          prominent number on the page, and there was nothing on screen to
          correct them. `sr-only` for the reading, `aria-hidden` for the mark,
          so it is announced as "73 out of 100" rather than "73 slash 100".
        */}
        {kpi.unit === "score" && kpi.value !== null ? (
          <span className="pb-[5px] text-copy text-faint">
            <span aria-hidden>/100</span>
            <span className="sr-only">{t("outOf", { max: 100 })}</span>
          </span>
        ) : null}

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
        /*
          **The transition, when a percentage would be theatre** (A22-C5).

          One review last month and seven this month is not "+600%" — that is
          the same headline two-to-fourteen would produce, and one more review
          would move it another hundred points. `percentChange` withholds it
          below `MIN_PERCENT_BASE`, and what a café owner can actually use is
          the pair: **1 → 7**. Small numbers are their own best description.

          Only for counts, and only when both sides exist. A first period has
          nothing to compare against and says so instead.
        */
        kpi.unit === "count" && kpi.value !== null && kpi.previous !== null ? (
          <p className="mt-2 text-meta text-faint tabular-nums">
            {t("fromTo", {
              from: format.number(kpi.previous),
              to: format.number(kpi.value),
            })}
          </p>
        ) : (
          // No comparison rather than a fabricated one: a first period, or a
          // previous period with nothing in it, has no honest delta.
          <p className="mt-2 text-meta text-faint">{t("noComparison")}</p>
        )
      ) : null}

      <TrendSparkline
        points={kpi.spark}
        /*
          The same three-way encoding as the `Delta` directly above it.

          It was `better === false ? destructive : primary`, which disagreed
          with the pill six pixels away on two counts. An *improving* KPI got
          indigo where the pill got green, so a rise and a flat line were drawn
          identically — and indigo means "interactive, or chosen" everywhere else
          in this system (docs/21 §2), which is not something a decorative line
          should be claiming. Four tiles came out as three red alarms and one
          stray blue link.

          `--destructive`, not `--sentiment-negative`: a falling KPI is a number
          going the wrong way, not a customer feeling bad. Keeping the sentiment
          tokens for sentiment is the whole point of naming them separately.
        */
        className={cn(
          "mt-2.5",
          better === true && "text-positive-ink",
          better === false && "text-destructive",
          better === null && "text-graphic-faint",
        )}
      />

      {/*
        And what it is *made of*, visibly.

        This was a `title` attribute and an `sr-only` copy of it, which is
        exactly nothing on a phone: there is no hover, and the one number on
        this page that cannot be guessed from its label was the one whose
        explanation needed a mouse. It is one line of muted text now — the same
        sentence, from the same weights, on screen.

        **Below the sparkline, not above it.** Four cells sit on one row and
        only this one has an explanation; putting it in the middle pushed this
        cell's sparkline 60px below the other three and made the strip read as
        broken rather than as annotated.
      */}
      {explanation ? (
        /*
          `hidden lg:block`: the strip is two across below `lg`, and at ~180px
          this sentence runs to four lines — so the score tile came out twice
          the height of the one beside it and left a hundred-odd pixels of dead
          space in the cell next door. The sentence is not dropped on a phone,
          which is the whole reason W4.3 added it; `KpiRow` renders it once
          under the strip instead, where it has the full width and costs the
          grid nothing.
        */
        <p className="mt-2.5 hidden text-meta text-pretty text-faint lg:block">{explanation}</p>
      ) : null}
    </div>
  );
}
