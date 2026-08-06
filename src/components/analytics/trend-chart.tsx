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
  /**
   * The y-axis gutter, derived from the labels rather than pinned to a number.
   *
   * It was `width={42}`, sized by hand for `-1,0` — the old signed sentiment
   * scale. W3.3 replaced that scale with positive share, whose top tick is
   * `100%`: 40px of Geist Mono at 10px, plus Recharts' 5px `tickMargin`, is
   * 45px in a 42px gutter. Recharts right-aligns the tick text against the axis
   * line, so the overflow goes *left*, past the SVG's own viewport — and an SVG
   * clips its own overflow however permissive the HTML around it is. The label
   * rendered as **`00%`**: not a formatting bug, a clipped `1`.
   *
   * Nothing failed. The DOM text is correct, the tests pass, and the only
   * evidence is six pixels of a digit missing on a screen — which is why this
   * is derived now. A hand-tuned constant is only ever right for the labels it
   * was measured against, and the labels changed once already.
   *
   * 6.2px per glyph is Geist Mono's advance at 10px (0.6em plus the tracking),
   * measured rather than assumed; +10 covers `tickMargin` and a pixel of slack.
   * Floored at 42 so no existing chart's gutter narrows.
   */
  const longestTick = tickLabels
    ? Math.max(...Object.values(tickLabels).map((label) => label.length))
    : 4;
  const axisWidth = Math.max(42, Math.ceil(longestTick * 6.2) + 10);

  /**
   * Tick styling, applied to the `<text>` and not to the axis around it.
   *
   * Both axes carried `className="fill-graphic-faint font-mono text-[10px]"`,
   * and it never reached the labels: Recharts puts a `className` on the axis
   * *layer*, then renders each tick through its own `<Text>` which sets its own
   * classes. `fill` is an inherited SVG property so the grey arrived and the
   * styling looked applied — but `font-size` and `font-family` were the browser
   * defaults, so every tick on this page was rendering at **16px in Geist
   * sans** rather than 10px in Geist Mono.
   *
   * That is what clipped `100%` down to `00%`: 16px text needs about 40px for
   * four glyphs, and the y-axis gutter is 42 with a 5px tick margin, so it
   * overflowed to the left of the SVG's own viewport — which an SVG clips
   * regardless of the overflow rules on the HTML around it.
   *
   * `tick` is the prop Recharts spreads onto the text element, so this is the
   * only place the styling can actually land.
   */
  const tickStyle = { className: "fill-graphic-faint font-mono text-[10px]" };

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
            tick={tickStyle}
            interval="preserveStartEnd"
            minTickGap={24}
          />

          <YAxis
            // Derived from the labels — see `axisWidth` above. Two separate
            // clippings have now been fixed by widening this by hand; the
            // second one ("100%" → "00%") is what made it a computation.
            width={axisWidth}
            tickLine={false}
            axisLine={false}
            tick={tickStyle}
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
