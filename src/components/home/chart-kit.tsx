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
    // A tooltip is one of the two things in this system that genuinely floats,
    // so it keeps `shadow-md` — but the border is the system hairline rather
    // than a `ring-foreground/10`, which resolved to a different grey.
    <div className="rounded-md border border-line bg-popover px-3 py-2 text-meta shadow-md">
      <p className="mb-1 text-copy font-semibold">{title}</p>
      {rows.map((row) => (
        <p key={row.label} className="text-ink-400">
          {row.label}: <span className="font-mono text-foreground tabular-nums">{row.value}</span>
        </p>
      ))}
    </div>
  );
}
