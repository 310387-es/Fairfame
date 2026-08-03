"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Rating and volume over the range (widget 3).
 *
 * The two belong on one chart because neither means much alone: 4.2 stars from
 * three reviews and 4.2 from ninety are different facts about a business, and
 * a rating that rises as volume collapses is usually a sign that only regulars
 * are still writing.
 *
 * Colours come from the token classes, never from hex. Recharts writes `fill`
 * and `stroke` as presentation attributes, and an attribute cannot resolve a
 * CSS variable — so the palette is applied through `className` instead, where
 * a real CSS declaration wins over the attribute.
 *
 * `<Line>` is the exception: it does not forward `className` to the `<path>` it
 * draws, so a class set there silently does nothing and the curve keeps
 * Recharts' own `#3182bd` — which is why this chart used to draw a stock blue
 * line under an indigo legend swatch. The line and the reference line are
 * therefore coloured from the wrapper with descendant variants, which produce a
 * real rule against the rendered path.
 */

export type ChartPoint = {
  /** Preformatted server-side: the client has no business re-deriving a locale. */
  label: string;
  tooltipLabel: string;
  rating: number | null;
  volume: number;
};

export function ReputationChart({
  points,
  average,
  ratingLabel,
  volumeLabel,
}: {
  points: ChartPoint[];
  /** The whole range's average rating — the same number the KPI card shows. */
  average: number | null;
  ratingLabel: string;
  volumeLabel: string;
}) {
  return (
    // The card's data table carries the same series for screen readers.
    <div
      aria-hidden
      className="[&_*]:outline-none [&_.recharts-line-curve]:stroke-chart-1 [&_.recharts-reference-line-line]:stroke-graphic-faint"
    >
      <ResponsiveContainer width="100%" height={340}>
        <ComposedChart
          accessibilityLayer={false}
          data={points}
          // No negative left margin. It used to be -20 against a 34px axis to
          // claw back the gap Recharts reserves, which left 14px for the rating
          // labels and clipped them in half at the SVG's left edge. The axis is
          // narrowed instead — same recovered space, and the digits survive.
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <CartesianGrid vertical={false} className="stroke-line-inner" strokeDasharray="0" />

          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            // `--graphic-faint`, not a text token: axis ticks are non-text
            // graphics and sit one step below the AA text floor by design.
            className="fill-graphic-faint font-mono text-[10px]"
            // Never every day on a 90-day range: overlapping labels are worse
            // than fewer of them.
            interval="preserveStartEnd"
            minTickGap={28}
          />

          {/* Stars are a fixed 1-5 scale, so the axis is fixed too. Letting it
            auto-fit would make a 4.4 → 4.5 wobble look like a cliff. */}
          <YAxis
            yAxisId="rating"
            domain={[1, 5]}
            ticks={[1, 2, 3, 4, 5]}
            tickLine={false}
            axisLine={false}
            // One mono digit plus breathing room to the first gridline. The
            // scale is fixed at 1–5, so this never has to fit a wider label.
            width={22}
            tickMargin={6}
            // `--graphic-faint`, not a text token: axis ticks are non-text
            // graphics and sit one step below the AA text floor by design.
            className="fill-graphic-faint font-mono text-[10px]"
          />

          {/* Volume rides its own hidden scale: the bars are context for the
            line, and a second visible axis would imply they share units. */}
          <YAxis yAxisId="volume" hide domain={[0, "dataMax"]} />

          <Tooltip
            wrapperStyle={{ zIndex: 10 }}
            cursor={{ className: "fill-muted/60" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0]?.payload as ChartPoint | undefined;
              if (!point) return null;

              return (
                <div className="rounded-md border border-line bg-popover px-3 py-2 text-meta shadow-md">
                  <p className="mb-1 text-copy font-semibold">{point.tooltipLabel}</p>
                  <p className="text-ink-400">
                    {volumeLabel}:{" "}
                    <span className="font-mono text-foreground tabular-nums">{point.volume}</span>
                  </p>
                  {point.rating !== null ? (
                    <p className="text-ink-400">
                      {ratingLabel}:{" "}
                      <span className="font-mono text-foreground tabular-nums">{point.rating}</span>
                    </p>
                  ) : null}
                </div>
              );
            }}
          />

          {/* The range's own average, so "how is it moving" and "where does it
            sit" are both answerable without doing arithmetic on a line. It is
            the same figure as the KPI card above, passed down rather than
            recomputed, because two averages that disagree is worse than one. */}
          {average !== null ? (
            <ReferenceLine yAxisId="rating" y={average} strokeDasharray="5 5" />
          ) : null}

          <Bar
            yAxisId="volume"
            dataKey="volume"
            // The same token as the legend swatch, so the two cannot drift.
            className="fill-indigo-100"
            radius={[4, 4, 0, 0]}
            // Wide enough to read on the 7-day view, where seven categories share
            // the full width and a 22px bar looks like a stray tick.
            maxBarSize={48}
            isAnimationActive={false}
          />

          <Line
            yAxisId="rating"
            type="monotone"
            dataKey="rating"
            className="stroke-chart-1"
            strokeWidth={2.5}
            dot={false}
            // A quiet bucket has no rating, and joining across it would invent
            // one. The line breaks instead.
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
