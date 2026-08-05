"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * One measure over time (P3-T4).
 *
 * Deliberately not the Home chart. That one composes rating against volume on
 * two axes to answer "is this branch healthy"; this draws a single series so
 * three of them can be read side by side to answer "which of these moved".
 * Merging the two would mean a chart component with a mode flag.
 *
 * **A gap in the line is the point.** `connectNulls` is off, so a period with
 * nothing to measure leaves a break rather than a straight line drawn between
 * two real measurements weeks apart — which would invent a trend through a
 * stretch where nobody said anything.
 *
 * **Every string arrives preformatted.** Not a stylistic choice: a formatter
 * function cannot cross the server/client boundary at all — passing one throws
 * "Functions cannot be passed directly to Client Components", which is how this
 * component was first written and what running it caught. Formatting a number
 * needs a locale, the server has one, and re-deriving it here would be a second
 * source of truth for how a Turkish decimal comma is written.
 *
 * Colours come from token classes, never hex, and `<Line>` is coloured from the
 * wrapper with a descendant variant: Recharts does not forward `className` to
 * the path it draws, so a class set on the element silently does nothing and
 * the curve keeps Recharts' own stock blue. Same trap as the Home chart.
 */

export type TrendChartPoint = {
  /** The bucket, formatted server-side. */
  label: string;
  /** The raw number, which is what positions the point. */
  value: number | null;
  /** The same number as text, or null where there was nothing to measure. */
  display: string | null;
  count: number;
};

export function TrendChart({
  points,
  domain,
  ticks,
  tickLabels,
  tooltipLabel,
}: {
  points: TrendChartPoint[];
  /** Fixed where the scale has meaning (1–5 stars), auto where it does not. */
  domain?: [number, number];
  /** Explicit axis ticks, so their labels can be prepared server-side. */
  ticks?: number[];
  /** Tick value → its formatted label. Keyed by `String(value)`. */
  tickLabels?: Record<string, string>;
  tooltipLabel: string;
}) {
  return (
    // The card's data table carries the same series for screen readers.
    <div aria-hidden className="[&_*]:outline-none [&_.recharts-line-curve]:stroke-chart-1">
      <ResponsiveContainer width="100%" height={180}>
        <LineChart
          accessibilityLayer={false}
          data={points}
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
            interval="preserveStartEnd"
            minTickGap={24}
          />

          <YAxis
            // Wide enough for "-1,0" plus its minus sign. At 34 the sentiment
            // axis clipped every label to ".0" — measured in the browser.
            width={42}
            tickLine={false}
            axisLine={false}
            className="fill-graphic-faint font-mono text-[10px]"
            domain={domain ?? ["auto", "auto"]}
            {...(ticks ? { ticks } : {})}
            // Defined here, closing over a plain object that did cross the
            // boundary. Recharts needs a function; the server cannot send one.
            tickFormatter={(value: number) => tickLabels?.[String(value)] ?? String(value)}
          />

          <Tooltip
            cursor={{ className: "stroke-line-inner" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0]!.payload as TrendChartPoint;

              return (
                <div className="rounded-md border border-line bg-card px-2.5 py-1.5 text-copy shadow-sm">
                  <p className="font-medium">{point.label}</p>
                  <p className="text-muted-foreground">
                    {/* A dash, not a zero — the same rule the series follows. */}
                    {point.display === null ? "—" : `${tooltipLabel}: ${point.display}`}
                  </p>
                </div>
              );
            }}
          />

          <Line
            type="monotone"
            dataKey="value"
            strokeWidth={2}
            dot={false}
            // A break, not a bridge. See the header.
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
