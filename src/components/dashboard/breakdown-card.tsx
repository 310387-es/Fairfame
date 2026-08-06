import { getFormatter, getTranslations } from "next-intl/server";
import { LegendItem, SentimentBar } from "@/components/ds/meter";
import { BreakdownTabs } from "@/components/dashboard/breakdown-tabs";
import { RatingDistribution } from "@/components/dashboard/rating-distribution";
import { SourceBreakdown } from "@/components/dashboard/source-breakdown";
import { ThemesList } from "@/components/dashboard/themes-list";
import type { RatingBucket, SentimentBreakdown, SourceRow, ThemeRow } from "@/dashboard/metrics";

/**
 * What customers said — the mood of the period, then three ways of asking why.
 *
 * Four widgets became one card. The sentiment donut spent 170px of height on
 * three percentages and is now the 10px ribbon at the top; themes, ratings and
 * sources each had their own card competing for the same glance, when they are
 * alternatives rather than companions.
 *
 * This is the server half: it does the formatting and renders all three panels
 * from facts that are already in memory, then hands them to the client strip.
 * Rendering all three costs nothing measurable — they are `div`s with widths —
 * and it is what lets switching tabs avoid a round trip entirely.
 */
export async function BreakdownCard({
  themes,
  sentiment,
  buckets,
  sources,
}: {
  themes: ThemeRow[];
  sentiment: SentimentBreakdown;
  buckets: RatingBucket[];
  sources: SourceRow[];
}) {
  const [t, tSentiment, format] = await Promise.all([
    getTranslations("home.breakdown"),
    getTranslations("home.sentiment"),
    getFormatter(),
  ]);

  const share = (count: number) =>
    format.number(sentiment.analysed === 0 ? 0 : count / sentiment.analysed, {
      style: "percent",
      maximumFractionDigits: 0,
    });

  const ribbon =
    sentiment.analysed > 0 ? (
      <>
        <SentimentBar
          positive={sentiment.positive}
          neutral={sentiment.neutral}
          negative={sentiment.negative}
          srLabel={[
            tSentiment("positive", { percent: share(sentiment.positive) }),
            tSentiment("neutral", { percent: share(sentiment.neutral) }),
            tSentiment("negative", { percent: share(sentiment.negative) }),
          ].join(", ")}
        />

        {/* The figure is printed beside every colour. The ribbon is a picture,
            and WCAG forbids colour as the only carrier of meaning — a reader
            who cannot separate the green from the red still gets all three
            numbers. */}
        <div className="mt-2 flex flex-wrap gap-4">
          <LegendItem tone="positive" value={share(sentiment.positive)}>
            {tSentiment("positiveShort")}
          </LegendItem>
          <LegendItem tone="neutral" value={share(sentiment.neutral)}>
            {tSentiment("neutralShort")}
          </LegendItem>
          <LegendItem tone="negative" value={share(sentiment.negative)}>
            {tSentiment("negativeShort")}
          </LegendItem>
        </div>

        {/* Stated separately, never folded into "neutral". An unanalysed review
            has no sentiment, and calling it neutral would invent one. */}
        {sentiment.pending > 0 ? (
          <p className="mt-2 text-meta text-faint">
            {tSentiment("pending", { count: sentiment.pending })}
          </p>
        ) : null}
      </>
    ) : null;

  return (
    <BreakdownTabs
      title={t("title")}
      stripLabel={t("label")}
      ribbon={ribbon}
      tabs={[
        { value: "themes", label: t("themes"), panel: <ThemesList rows={themes} /> },
        {
          value: "ratings",
          label: t("ratings"),
          panel: <RatingDistribution buckets={buckets} bare />,
        },
        { value: "sources", label: t("sources"), panel: <SourceBreakdown rows={sources} bare /> },
      ]}
    />
  );
}
