"use client";

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltip } from "@/components/home/chart-kit";

/**
 * The horizontal bar chart behind sources, themes and the rating ladder.
 *
 * One component for three widgets because they are the same picture — a label,
 * a magnitude, a colour that means something — and three near-identical Recharts
 * trees would be three places to fix the next axis quirk.
 *
 * Bars carry their own colour rather than the series carrying one: a theme's
 * bar is coloured by how people felt about it, and a rating of two stars is a
 * complaint whatever the theme chart does.
 *
 * Read-only: hovering says what a bar is, and nothing navigates. A chart whose
 * segments move you somewhere makes every stray click a page change, and the
 * cards already carry a deliberate link in the header for that.
 */

export type BarDatum = {
  key: string;
  label: string;
  value: number;
  /** Tailwind fill utility, e.g. `fill-sentiment-negative`. */
  fill: string;
  /** Second line in the tooltip, when there is something worth saying. */
  detail?: string;
};

export function HorizontalBarChart({
  data,
  valueLabel,
  height,
}: {
  data: BarDatum[];
  valueLabel: string;
  height: number;
}) {
  return (
    // Hidden from assistive tech on purpose: every chart here ships a
    // `ChartFallback` table with the same numbers, and announcing both means
    // hearing the data twice, once as unlabelled SVG.
    <div aria-hidden className="[&_*]:outline-none">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          accessibilityLayer={false}
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 8, bottom: 0, left: 0 }}
          barCategoryGap="22%"
        >
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="label"
            width={96}
            tickLine={false}
            axisLine={false}
            className="fill-muted-foreground text-[11px]"
          />

          <Tooltip
            wrapperStyle={{ zIndex: 10 }}
            cursor={{ className: "fill-muted/50" }}
            content={({ active, payload }) => {
              const datum = payload?.[0]?.payload as BarDatum | undefined;
              if (!active || !datum) return null;

              return (
                <ChartTooltip
                  title={datum.label}
                  rows={[
                    { label: valueLabel, value: datum.value },
                    ...(datum.detail ? [{ label: datum.detail, value: "" }] : []),
                  ]}
                />
              );
            }}
          />

          <Bar dataKey="value" radius={[4, 4, 4, 4]} maxBarSize={18} isAnimationActive={false}>
            {data.map((datum) => (
              <Cell key={datum.key} className={datum.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
