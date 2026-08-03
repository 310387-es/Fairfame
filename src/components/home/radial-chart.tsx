"use client";

import { PolarAngleAxis, RadialBar, RadialBarChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartTooltip } from "@/components/home/chart-kit";

/**
 * One share, drawn as an arc — the "answered within a day" gauge.
 *
 * `PolarAngleAxis` with a fixed 0-100 domain is what makes it a gauge rather
 * than a pie: without it Recharts scales the single bar to fill the circle, so
 * 40% and 90% would look identical.
 */
export function RadialShare({
  value,
  display,
  label,
  centerLabel,
}: {
  /** 0-100, for the arc. */
  value: number;
  /** The same share, already formatted — Turkish writes %100, not 100%. */
  display: string;
  label: string;
  centerLabel: string;
}) {
  return (
    <div className="relative size-[150px] shrink-0 [&_*]:outline-none" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          accessibilityLayer={false}
          data={[{ value }]}
          innerRadius="74%"
          outerRadius="100%"
          startAngle={90}
          endAngle={-270}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar
            dataKey="value"
            cornerRadius={9}
            className="fill-positive-ink"
            background={{ className: "fill-muted" }}
            isAnimationActive={false}
          />
          <Tooltip
            // Recharts renders its tooltip inside the chart container, and the
            // centred figure on the donut and the gauge is a later sibling of
            // that container — so without a stacking order the number sat on top
            // of the tooltip it was meant to be explained by.
            wrapperStyle={{ zIndex: 10 }}
            content={({ active }) =>
              active ? <ChartTooltip title={label} rows={[{ label: "%", value: display }]} /> : null
            }
          />
        </RadialBarChart>
      </ResponsiveContainer>

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-heading text-2xl font-bold">{display}</span>
        <span className="text-[11px] text-muted-foreground">{centerLabel}</span>
      </div>
    </div>
  );
}
