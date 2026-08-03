import type { ReactNode } from "react";

/**
 * A chart's data as text.
 *
 * A chart is an image to a screen reader, and WCAG 2.1 AA wants the same
 * information available as text — so every chart on a data surface ships this
 * table beside it. It is also the honest fallback when scripts are off, since
 * Recharts measures its container before drawing and renders nothing until
 * hydration.
 *
 * One table serves both. It is visually hidden by `.chart-fallback` and the
 * `<noscript>` stylesheet in `app/layout.tsx` reveals it when scripts are off.
 *
 * It used to be rendered twice, the second copy inside a `<noscript>`, which
 * crashed React's streaming renderer — see the `.chart-fallback` comment in
 * `globals.css` for why. Do not put markup back inside a `<noscript>`.
 */
export function ChartFallback({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: { key: string; cells: ReactNode[] }[];
}) {
  return (
    // The class goes on this wrapper, not the table — see `globals.css`.
    <div className="chart-fallback">
      <table className="w-full text-left text-copy">
        <caption className="pb-2 text-muted-foreground">{caption}</caption>
        <thead className="text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className="py-1 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-line-soft">
              {row.cells.map((cell, index) =>
                index === 0 ? (
                  <th key={index} scope="row" className="py-1 font-normal">
                    {cell}
                  </th>
                ) : (
                  <td key={index} className="py-1">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
