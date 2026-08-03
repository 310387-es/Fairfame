"use client";

import type { ReactNode } from "react";

/**
 * The tooltip every widget chart shares.
 *
 * Recharts ships no styled tooltip, and five copies of one would drift apart
 * within a month — the lower row only reads as a row because they match.
 */

export function ChartTooltip({
  title,
  rows,
}: {
  title: ReactNode;
  rows: { label: string; value: ReactNode }[];
}) {
  return (
    <div className="rounded-lg bg-popover px-3 py-2 text-xs shadow-md ring-1 ring-foreground/10">
      <p className="mb-1 font-medium">{title}</p>
      {rows.map((row) => (
        <p key={row.label} className="text-muted-foreground">
          {row.label}: <span className="text-foreground">{row.value}</span>
        </p>
      ))}
    </div>
  );
}
