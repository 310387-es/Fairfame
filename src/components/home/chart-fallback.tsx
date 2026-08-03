import type { ReactNode } from "react";

/**
 * A chart's data as text.
 *
 * Rendered twice: once `sr-only` — a chart is an image to a screen reader, and
 * WCAG 2.1 AA wants the same information available as text — and once inside
 * `<noscript>`, because Recharts measures its container before drawing and so
 * renders nothing at all until hydration. A browser that runs scripts never
 * parses the second copy, so assistive tech never meets a duplicate.
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
  const table = (visible: boolean) => (
    <table className={visible ? "w-full text-left text-xs" : "sr-only"}>
      <caption className={visible ? "pb-2 text-muted-foreground" : undefined}>{caption}</caption>
      <thead className={visible ? "text-muted-foreground" : undefined}>
        <tr>
          {columns.map((column) => (
            <th key={column} scope="col" className={visible ? "py-1 font-medium" : undefined}>
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className={visible ? "border-t border-border/60" : undefined}>
            {row.cells.map((cell, index) =>
              index === 0 ? (
                <th key={index} scope="row" className={visible ? "py-1 font-normal" : undefined}>
                  {cell}
                </th>
              ) : (
                <td key={index} className={visible ? "py-1" : undefined}>
                  {cell}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      {table(false)}
      <noscript>{table(true)}</noscript>
    </>
  );
}
