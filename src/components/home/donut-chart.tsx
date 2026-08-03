"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartTooltip } from "@/components/home/chart-kit";

/** Sentiment as an interactive ring: hover a slice for its count and share. */

export type DonutDatum = {
  key: string;
  label: string;
  value: number;
  fill: string;
};

export function DonutChart({
  data,
  centerValue,
  centerLabel,
  countLabel,
}: {
  data: DonutDatum[];
  centerValue: string;
  centerLabel: string;
  countLabel: string;
}) {
  const total = data.reduce((sum, datum) => sum + datum.value, 0);

  return (
    // The `ChartFallback` table beside this is what assistive tech reads. Left
    // visible to a screen reader, Recharts' SVG announces dozens of unlabelled
    // paths and then the same numbers again.
    <div className="relative [&_*]:outline-none" aria-hidden>
      <ResponsiveContainer width="100%" height={215}>
        <PieChart accessibilityLayer={false}>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius={68}
            outerRadius={96}
            paddingAngle={2}
            stroke="none"
            isAnimationActive={false}
          >
            {data.map((datum) => (
              <Cell key={datum.key} className={datum.fill} />
            ))}
          </Pie>

          <Tooltip
            // Recharts renders its tooltip inside the chart container, and the
            // centred figure on the donut and the gauge is a later sibling of
            // that container — so without a stacking order the number sat on top
            // of the tooltip it was meant to be explained by.
            wrapperStyle={{ zIndex: 10 }}
            content={({ active, payload }) => {
              const datum = payload?.[0]?.payload as DonutDatum | undefined;
              if (!active || !datum) return null;

              return (
                <ChartTooltip
                  title={datum.label}
                  rows={[
                    { label: countLabel, value: datum.value },
                    {
                      label: "%",
                      value: total === 0 ? 0 : Math.round((datum.value / total) * 100),
                    },
                  ]}
                />
              );
            }}
          />
        </PieChart>
      </ResponsiveContainer>

      {/* Centred over the ring rather than drawn inside it: Recharts would
          re-measure the text on every resize, and this stays put. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-heading text-3xl font-bold tracking-tight">{centerValue}</span>
        <span className="text-[11px] text-muted-foreground">{centerLabel}</span>
      </div>
    </div>
  );
}
