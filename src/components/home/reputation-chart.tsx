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
 * a real CSS declaration wins over the attribute. That is why these are
 * `fill-chart-2` and `stroke-chart-1` rather than props.
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
    <div aria-hidden className="[&_*]:outline-none">
      <ResponsiveContainer width="100%" height={340}>
        <ComposedChart
          accessibilityLayer={false}
          data={points}
          margin={{ top: 8, right: 8, bottom: 0, left: -20 }}
        >
          <CartesianGrid vertical={false} className="stroke-border" strokeDasharray="0" />

          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            className="fill-muted-foreground text-[10px]"
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
            width={34}
            className="fill-muted-foreground text-[10px]"
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
                <div className="rounded-lg bg-popover px-3 py-2 text-xs shadow-md ring-1 ring-foreground/10">
                  <p className="mb-1 font-medium">{point.tooltipLabel}</p>
                  <p className="text-muted-foreground">
                    {volumeLabel}: <span className="text-foreground">{point.volume}</span>
                  </p>
                  {point.rating !== null ? (
                    <p className="text-muted-foreground">
                      {ratingLabel}: <span className="text-foreground">{point.rating}</span>
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
            <ReferenceLine
              yAxisId="rating"
              y={average}
              strokeDasharray="5 5"
              className="stroke-muted-foreground/60"
            />
          ) : null}

          <Bar
            yAxisId="volume"
            dataKey="volume"
            className="fill-chart-1/15"
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
