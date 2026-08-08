import { Th, Thead } from "@/components/ds/table";
import { SectionCard } from "@/components/ds/section-card";
import { SentimentBar } from "@/components/ds/meter";
import type { LucideIcon } from "lucide-react";
import type { GroupComparison, SentimentMix } from "@/analytics/trends";

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
    /**
     * A sentiment split to draw instead of a number (W3.3).
     *
     * The column used to print the signed average — "−0,27" — which is a figure
     * on a scale nobody outside this codebase knows: a reader cannot tell
     * whether it is bad, how bad, or what would change it. The same bar the
     * dashboard uses says "two thirds positive, a fifth negative" at a glance,
     * in a vocabulary somebody already has.
     */
    mix?: { positive: number; neutral: number; negative: number; srLabel: string } | null;
  }[];
};

export function toComparisonRow(
  group: GroupComparison,
  label: string,
  format: {
    rating: (value: number) => string;
    /** The split to draw, and how to say it for a screen reader. */
    sentiment: (mix: SentimentMix) => {
      positive: number;
      neutral: number;
      negative: number;
      srLabel: string;
    } | null;
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
      {
        // No number at all: the bar *is* the value. The delta stays, because
        // "sentiment fell" is worth reporting and a mix has no single figure.
        value: null,
        delta:
          group.sentiment.delta === null ? null : format.delta(group.sentiment.delta, "sentiment"),
        direction:
          group.sentiment.delta === null
            ? null
            : group.sentiment.delta > 0
              ? ("up" as const)
              : group.sentiment.delta < 0
                ? ("down" as const)
                : ("flat" as const),
        mix: format.sentiment(group.mix),
      },
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
            <Thead>
              <tr>
                {columns.map((column, index) => (
                  // The first column names the row; the rest are quantities.
                  <Th key={column} numeric={index !== 0}>
                    {column}
                  </Th>
                ))}
              </tr>
            </Thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-line-soft">
                  <th scope="row" className="px-(--card-px) py-2.5 font-medium text-foreground">
                    {row.label}
                  </th>
                  {row.cells.map((cell, index) => (
                    <td
                      key={index}
                      className="px-(--card-px) py-2.5 text-right text-ink-400 tabular-nums"
                    >
                      {/* The bar replaces the number where there is one — a
                          split says more than a signed average and needs no
                          scale to be explained first (W3.3). */}
                      {cell.mix ? (
                        // `w-full` on the bar itself, not only on the wrapper:
                        // its segments are `flex-basis: 0`, so without a width
                        // of its own the bar collapses to nothing and the cell
                        // renders empty — which is what happened first.
                        <span className="ml-auto inline-flex w-24 align-middle">
                          <SentimentBar
                            className="w-full"
                            positive={cell.mix.positive}
                            neutral={cell.mix.neutral}
                            negative={cell.mix.negative}
                            srLabel={cell.mix.srLabel}
                          />
                        </span>
                      ) : (
                        // A dash, not a zero: nothing to measure is not a
                        // measurement of nothing.
                        (cell.value ?? "—")
                      )}
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
