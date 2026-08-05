import { SectionCard } from "@/components/ds/section-card";
import type { LucideIcon } from "lucide-react";
import type { GroupComparison } from "@/insights/trends";

/**
 * One row per branch, or per source (P3-T4).
 *
 * A table rather than a chart, because the question is "which of these is
 * worse" and the answer is read by comparing four numbers across a row — which
 * a bar chart makes harder, not easier. It is also the only shape that carries
 * a null honestly: a branch with nothing in the window shows a dash, where a
 * bar would show a zero-height bar sitting on the axis.
 *
 * A server component: nothing here is interactive, and the formatting is done
 * by the caller so a locale is never re-derived on the client.
 */

export type ComparisonRow = {
  key: string;
  /** Already resolved — a branch's name, or a source's label. */
  label: string;
  cells: {
    /** Preformatted, or null for "nothing to measure". */
    value: string | null;
    /** Preformatted delta, and which way it went. */
    delta: string | null;
    direction: "up" | "down" | "flat" | null;
  }[];
};

export function toComparisonRow(
  group: GroupComparison,
  label: string,
  format: {
    rating: (value: number) => string;
    sentiment: (value: number) => string;
    volume: (value: number) => string;
    percent: (value: number) => string;
    delta: (value: number, unit: "rating" | "sentiment" | "count" | "percent") => string;
  },
): ComparisonRow {
  const cell = (
    comparison: GroupComparison["rating"],
    unit: "rating" | "sentiment" | "count" | "percent",
    render: (value: number) => string,
  ) => ({
    value: comparison.value === null ? null : render(comparison.value),
    delta: comparison.delta === null ? null : format.delta(comparison.delta, unit),
    direction:
      comparison.delta === null
        ? null
        : comparison.delta > 0
          ? ("up" as const)
          : comparison.delta < 0
            ? ("down" as const)
            : ("flat" as const),
  });

  return {
    key: group.key,
    label,
    cells: [
      cell(group.rating, "rating", format.rating),
      cell(group.sentiment, "sentiment", format.sentiment),
      cell(group.volume, "count", format.volume),
      cell(group.responseRate, "percent", (value) => format.percent(value)),
    ],
  };
}

export function ComparisonTable({
  title,
  icon,
  columns,
  rows,
  empty,
  meta,
}: {
  title: string;
  icon: LucideIcon;
  /** The first is the row label's column; the rest are the measures. */
  columns: string[];
  rows: ComparisonRow[];
  empty: string;
  meta?: string;
}) {
  return (
    <SectionCard title={title} icon={icon} meta={meta} flush>
      {rows.length === 0 ? (
        <p className="px-(--card-px) pb-(--card-py) text-body text-ink-400">{empty}</p>
      ) : (
        // Scrolls inside its own container rather than pushing the page
        // sideways — four measures plus a name does not fit a phone.
        <div className="overflow-x-auto border-t border-line-soft">
          <table className="w-full min-w-[34rem] text-left text-copy">
            <thead className="text-meta text-faint">
              <tr>
                {columns.map((column, index) => (
                  <th
                    key={column}
                    scope="col"
                    className={`px-(--card-px) py-2 font-medium ${index === 0 ? "" : "text-right"}`}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-line-soft">
                  <th scope="row" className="text-ink px-(--card-px) py-2.5 font-medium">
                    {row.label}
                  </th>
                  {row.cells.map((cell, index) => (
                    <td
                      key={index}
                      className="px-(--card-px) py-2.5 text-right text-ink-400 tabular-nums"
                    >
                      {/* A dash, not a zero: nothing to measure is not a
                          measurement of nothing. */}
                      {cell.value ?? "—"}
                      {cell.delta ? (
                        <span
                          className={
                            cell.direction === "up"
                              ? "ml-1.5 text-primary"
                              : cell.direction === "down"
                                ? "ml-1.5 text-destructive"
                                : "ml-1.5 text-faint"
                          }
                        >
                          {cell.delta}
                        </span>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
