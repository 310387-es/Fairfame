import { Grid3x3 } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { ChartFallback } from "@/components/dashboard/chart-fallback";
import { SectionCard } from "@/components/ds/section-card";
import type { ThemeHeatmap } from "@/analytics/trends";
import { cn } from "@/lib/utils";

/**
 * Theme × time, coloured by sentiment (W4.4).
 *
 * ## What the colours mean, and why not a gradient
 *
 * Three tones — positive, neutral, negative — at four opacities, rather than a
 * continuous red-to-green ramp. A ramp looks more sophisticated and is worse
 * here for two reasons. It puts the mid-point at a colour nobody can name, so
 * "is this cell slightly bad or slightly good" becomes a question about
 * rendering; and green-to-red is the single worst axis to hand somebody with
 * deuteranopia, which is about one man in twelve. Banded tones from the
 * product's own sentiment palette are legible at a glance and survive being
 * printed, screenshotted, or looked at by a colourblind manager.
 *
 * **Opacity is volume, colour is sentiment**, in that order. A dark red cell is
 * many unhappy mentions; a faint red one is a couple of grumbles. Reversing
 * them would make the loudest cell on screen whichever theme is merely most
 * common.
 *
 * ## Empty is empty
 *
 * A week where nobody mentioned a theme renders as an **empty cell**, not as
 * neutral. Zero is the middle of this scale, so drawing absence as neutral
 * would fill the grid with grey claiming customers said something unremarkable
 * — a different and much more comfortable statement than "nobody mentioned it".
 *
 * ## It is a table, not a picture
 *
 * Built as a real `<table>` with row and column headers, so a screen reader
 * walks it as a grid and each cell carries its own sentence. A grid rendered as
 * a pile of divs is the most common way a "signature view" turns out to be
 * unreadable to a third of the people who need it — and `ChartFallback` is
 * beneath it as well, because a heatmap has no useful linear reading.
 */

/** Four bands rather than a continuous scale — see above. */
function intensity(mentions: number, peak: number): number {
  if (mentions === 0 || peak === 0) return 0;
  const share = mentions / peak;
  if (share > 0.66) return 3;
  if (share > 0.33) return 2;
  return 1;
}

const TONES = {
  positive: [
    "",
    "bg-sentiment-positive/20",
    "bg-sentiment-positive/45",
    "bg-sentiment-positive/75",
  ],
  neutral: ["", "bg-sentiment-neutral/20", "bg-sentiment-neutral/45", "bg-sentiment-neutral/75"],
  negative: [
    "",
    "bg-sentiment-negative/20",
    "bg-sentiment-negative/45",
    "bg-sentiment-negative/75",
  ],
} as const;

/**
 * The cuts. Deliberately the same ones `src/ai/*` uses to label a review
 * positive or negative, so a cell called negative here is a review called
 * negative in the queue — two thresholds for one word is how a business ends up
 * distrusting both screens.
 */
function toneOf(sentiment: number): keyof typeof TONES {
  if (sentiment > 0.2) return "positive";
  if (sentiment < -0.2) return "negative";
  return "neutral";
}

export async function ThemeHeatmapCard({
  heatmap,
  themeLabel,
}: {
  heatmap: ThemeHeatmap;
  /** A canonical theme key in the reader's language (W3.2), resolved by the caller. */
  themeLabel: (theme: string) => string;
}) {
  const [t, format] = await Promise.all([getTranslations("insights.heatmap"), getFormatter()]);

  if (heatmap.rows.length === 0) {
    return (
      <SectionCard title={t("title")} icon={Grid3x3} meta={t("meta")}>
        <p className="pb-(--card-py) text-body text-ink-400">{t("empty")}</p>
      </SectionCard>
    );
  }

  // The busiest single cell sets the scale, so intensity is comparable across
  // the whole grid rather than per row — a quiet theme should look quiet.
  const peak = Math.max(
    ...heatmap.rows.flatMap((row) => row.cells.map((cell) => cell.mentions)),
    0,
  );

  const shortDate = (date: Date) => format.dateTime(date, { day: "numeric", month: "short" });

  return (
    <SectionCard title={t("title")} icon={Grid3x3} meta={t("meta")} flush>
      <div className="relative w-full overflow-x-auto border-t border-line-soft">
        <table className="w-full min-w-[36rem] border-separate border-spacing-0 text-copy">
          <caption className="sr-only">{t("caption")}</caption>

          <thead>
            <tr>
              <th
                scope="col"
                className="px-(--card-px) py-2 text-left text-meta font-medium text-faint"
              >
                {t("theme")}
              </th>
              {heatmap.buckets.map((bucket, index) => (
                <th
                  key={bucket.start.toISOString()}
                  scope="col"
                  className="px-0.5 pt-2 pb-1 text-center text-meta font-medium text-faint"
                >
                  {/*
                    Every other label past eight columns. `heatmapBuckets` keeps
                    the count sane — thirteen weeks at most on a 90-day range —
                    but thirteen dates at 11px still collide, and a grid's
                    columns are read by position anyway: the header anchors the
                    eye rather than being counted. The label stays in the
                    accessibility tree either way, so the column header a screen
                    reader announces is never blank.
                  */}
                  <span className={cn(heatmap.buckets.length > 8 && index % 2 === 1 && "sr-only")}>
                    {shortDate(bucket.start)}
                  </span>
                </th>
              ))}
              <th
                scope="col"
                className="px-(--card-px) py-2 text-right text-meta font-medium text-faint"
              >
                {t("total")}
              </th>
            </tr>
          </thead>

          <tbody>
            {heatmap.rows.map((row) => (
              <tr key={row.theme}>
                <th
                  scope="row"
                  className="max-w-[10rem] truncate px-(--card-px) py-0.5 text-left font-normal text-ink-600"
                >
                  {themeLabel(row.theme)}
                </th>

                {row.cells.map((cell, index) => {
                  const bucket = heatmap.buckets[index];
                  const band = intensity(cell.mentions, peak);
                  const tone = cell.sentiment === null ? null : toneOf(cell.sentiment);

                  return (
                    <td key={bucket?.start.toISOString() ?? index} className="p-0.5">
                      <span
                        // Every cell carries its own sentence: a screen reader
                        // walking this grid gets "Service, week of 3 Aug, 4
                        // mentions, mostly negative" rather than a blank.
                        title={
                          cell.mentions === 0
                            ? t("cellEmpty", { theme: themeLabel(row.theme) })
                            : t("cell", {
                                theme: themeLabel(row.theme),
                                mentions: cell.mentions,
                                mood: t(`mood.${tone ?? "unknown"}`),
                              })
                        }
                        className={cn(
                          "block h-6 rounded-[3px]",
                          tone === null || band === 0
                            ? // Not neutral — see the module comment. A hairline
                              // so the grid keeps its shape without claiming
                              // anything happened.
                              "border border-line-soft"
                            : TONES[tone][band],
                        )}
                      >
                        <span className="sr-only">
                          {cell.mentions === 0
                            ? t("cellEmpty", { theme: themeLabel(row.theme) })
                            : t("cell", {
                                theme: themeLabel(row.theme),
                                mentions: cell.mentions,
                                mood: t(`mood.${tone ?? "unknown"}`),
                              })}
                        </span>
                      </span>
                    </td>
                  );
                })}

                <td className="px-(--card-px) py-0.5 text-right font-mono text-meta text-ink-500 tabular-nums">
                  {row.total}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 px-(--card-px) py-3 text-meta text-faint">
        {(["positive", "neutral", "negative"] as const).map((tone) => (
          <span key={tone} className="flex items-center gap-1.5">
            <span className={cn("size-3 rounded-[3px]", TONES[tone][3])} aria-hidden />
            {t(`mood.${tone}`)}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-[3px] border border-line-soft" aria-hidden />
          {t("noMentions")}
        </span>
      </div>

      <ChartFallback
        caption={t("title")}
        columns={[t("theme"), t("total")]}
        rows={heatmap.rows.map((row) => ({
          key: row.theme,
          cells: [themeLabel(row.theme), String(row.total)],
        }))}
      />
    </SectionCard>
  );
}
