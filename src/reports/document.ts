import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";
import { REPORT_FONT, registerReportFonts } from "./fonts.ts";

/**
 * The report, as a PDF (P3-T5).
 *
 * **Written with `createElement`, not JSX, and that is a constraint rather than
 * a preference.** This module is imported by the BullMQ worker, which runs
 * `.ts` through Node's own type stripping (`scripts/worker.mts` → plain
 * `node`). Node strips *types*; it does not transform JSX. A `.tsx` file here
 * would work under Next's bundler in the app and fail at startup in the
 * process that actually sends the reports — the one place nobody is watching.
 * `CLAUDE.md` records the same trap for parameter properties.
 *
 * Everything arrives preformatted. The renderer takes strings, not numbers and
 * not a locale: the caller has `next-intl` and a language, this has neither,
 * and a second place that decides how a Turkish decimal comma is written is a
 * second place for it to be wrong.
 *
 * Colours are literal hex for the same reason `src/widgets/theme.ts` is: a PDF
 * has no stylesheet, no tokens and no `globals.css`.
 *
 * This said "these are the same brand values, restated" — and two of the five
 * are (`INK`, `ACCENT`). The other three are the *print* palette the widget
 * uses, which is a shade stronger than the app's on purpose: `INK_MUTED` is
 * 6.1:1 where `--ink-400` is 4.68:1, because a PDF is read at whatever size a
 * printer produces and there is no zoom. Restating a claim of exact fidelity
 * that was never true is how somebody later "corrects" these to the app's
 * tokens and quietly lowers the contrast of a document sent to a customer.
 *
 * `tests/lib/report-contrast.test.ts` asserts the floors these have to clear,
 * which is the property that actually matters — not which token they equal.
 */

const INK = "#10193a";
const INK_MUTED = "#5a6180";
const LINE = "#e5e8f2";
const ACCENT = "#3d5af1";
const NEGATIVE = "#b4232c";

const styles = StyleSheet.create({
  page: {
    fontFamily: REPORT_FONT,
    fontSize: 10,
    color: INK,
    paddingTop: 44,
    paddingBottom: 56,
    paddingHorizontal: 44,
    lineHeight: 1.5,
  },
  // Explicit line heights on both. The page sets 1.5, which at 20pt leaves a
  // line box shorter than the glyphs it holds, and the subtitle was drawn
  // through the title's descenders — seen in the rendered file, not inferable
  // from the styles.
  title: { fontSize: 20, fontWeight: 600, lineHeight: 1.3, marginBottom: 4 },
  subtitle: { fontSize: 10, lineHeight: 1.4, color: INK_MUTED, marginBottom: 20 },
  sectionTitle: { fontSize: 12, fontWeight: 600, marginTop: 20, marginBottom: 8 },
  summaryRow: { flexDirection: "row", gap: 10, marginBottom: 4 },
  summaryCell: {
    flex: 1,
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  summaryLabel: { fontSize: 8, color: INK_MUTED, marginBottom: 3 },
  summaryValue: { fontSize: 16, fontWeight: 600 },
  summaryDelta: { fontSize: 8, marginTop: 2 },
  row: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: LINE,
    paddingVertical: 5,
  },
  headerRow: { flexDirection: "row", paddingVertical: 5 },
  headerCell: { fontSize: 8, color: INK_MUTED },
  cell: { fontSize: 9 },
  first: { flex: 3 },
  measure: { flex: 1, textAlign: "right" },
  empty: { fontSize: 9, color: INK_MUTED, paddingVertical: 6 },
  footer: {
    position: "absolute",
    bottom: 28,
    left: 44,
    right: 44,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: INK_MUTED,
  },
});

/** A measure and how it moved, both already rendered as text. */
export type ReportMetric = {
  label: string;
  /** Null renders as a dash — nothing to measure is not a measurement of nothing. */
  value: string | null;
  delta: string | null;
  direction: "up" | "down" | "flat" | null;
};

export type ReportTable = {
  title: string;
  /** The first is the row-label column; the rest are right-aligned measures. */
  columns: string[];
  rows: { key: string; label: string; cells: (string | null)[] }[];
  empty: string;
};

export type ReportContent = {
  /** "Kadıköy Kahve — Kadıköy Şubesi", or the organization for an org-wide one. */
  title: string;
  /** "1–7 August 2026 · weekly", already formatted and localised. */
  subtitle: string;
  metrics: ReportMetric[];
  tables: ReportTable[];
  /** Rendered at the foot of every page, beside the page number. */
  footer: string;
  /** "Page {n} of {m}" is composed by the caller's language, not by this file. */
  pageLabel: (page: number, total: number) => string;
};

function metricCell(metric: ReportMetric): ReactElement {
  const colour =
    metric.direction === "up" ? ACCENT : metric.direction === "down" ? NEGATIVE : INK_MUTED;

  return createElement(
    View,
    { key: metric.label, style: styles.summaryCell },
    createElement(Text, { style: styles.summaryLabel }, metric.label),
    // A dash, not a zero: a branch nobody rated does not have a rating of nought.
    createElement(Text, { style: styles.summaryValue }, metric.value ?? "—"),
    metric.delta
      ? createElement(Text, { style: [styles.summaryDelta, { color: colour }] }, metric.delta)
      : null,
  );
}

function table(spec: ReportTable): ReactElement {
  return createElement(
    View,
    { key: spec.title },
    createElement(Text, { style: styles.sectionTitle }, spec.title),
    spec.rows.length === 0
      ? createElement(Text, { style: styles.empty }, spec.empty)
      : createElement(
          View,
          null,
          createElement(
            View,
            { style: styles.headerRow },
            ...spec.columns.map((column, index) =>
              createElement(
                Text,
                {
                  key: column,
                  style: [styles.headerCell, index === 0 ? styles.first : styles.measure],
                },
                column,
              ),
            ),
          ),
          ...spec.rows.map((row) =>
            createElement(
              View,
              { key: row.key, style: styles.row, wrap: false },
              createElement(Text, { style: [styles.cell, styles.first] }, row.label),
              ...row.cells.map((cell, index) =>
                createElement(
                  Text,
                  { key: index, style: [styles.cell, styles.measure] },
                  cell ?? "—",
                ),
              ),
            ),
          ),
        ),
  );
}

/** The document tree. Exported for tests, which assert on structure not bytes. */
export function reportDocument(content: ReportContent): ReactElement {
  return createElement(
    Document,
    { title: content.title, author: "Revira" },
    createElement(
      Page,
      { size: "A4", style: styles.page },
      createElement(Text, { style: styles.title }, content.title),
      createElement(Text, { style: styles.subtitle }, content.subtitle),

      createElement(View, { style: styles.summaryRow }, ...content.metrics.map(metricCell)),

      ...content.tables.map(table),

      createElement(
        View,
        { style: styles.footer, fixed: true },
        createElement(Text, null, content.footer),
        createElement(Text, {
          // `render` runs per page, which is the only way to number pages.
          render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
            content.pageLabel(pageNumber, totalPages),
        }),
      ),
    ),
  );
}

/** The finished file. Fonts are registered here so no caller has to remember. */
export async function renderReportPdf(content: ReportContent): Promise<Buffer> {
  registerReportFonts();
  // The cast is the library's own types being stricter about `Document` than
  // `createElement` can express; the tree above is exactly what it documents.
  return renderToBuffer(reportDocument(content) as never);
}
