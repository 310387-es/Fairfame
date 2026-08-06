import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";
import { REPORT_FONT, registerReportFonts } from "../reports/fonts.ts";

/**
 * The weekly briefing, as a PDF (W2.1).
 *
 * A digest is the one thing in this product a person wants to take somewhere
 * else — into a Monday staff meeting, onto a noticeboard, to a branch manager
 * who has no login. Until now the only way to do that was a screenshot.
 *
 * **`createElement`, not JSX, and that is a constraint rather than a
 * preference** — the same one `src/reports/document.ts` carries and for the
 * same reason: `.tsx` compiles under Next's bundler and dies under the worker's
 * plain `node`. This one is only reached from a route today, but a file whose
 * safety depends on never being imported by a job is a trap set for later.
 *
 * Everything arrives **preformatted**. The caller has `next-intl`, a locale and
 * a Turkish decimal comma; this has none of them, and a second place deciding
 * how a number is written is a second place for it to be wrong.
 *
 * The palette is literal hex, restating `src/reports/document.ts` rather than
 * importing its private constants — a PDF has no stylesheet and no tokens, and
 * exporting them from there to here would make two documents that must be
 * allowed to diverge look like one that must not.
 */

const INK = "#10193a";
const INK_MUTED = "#5a6180";
const LINE = "#e5e8f2";
const ACCENT = "#3d5af1";
const NEGATIVE = "#b4232c";
const POSITIVE = "#0f7b5f";
const SURFACE = "#f6f7fb";

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
  // Explicit line height, as in the report: the page's 1.5 at 20pt leaves a
  // line box shorter than the glyphs, and the subtitle draws through the
  // title's descenders. Found in the rendered file, not in the styles.
  eyebrow: { fontSize: 8, letterSpacing: 1, color: INK_MUTED, marginBottom: 6 },
  title: { fontSize: 19, fontWeight: 600, lineHeight: 1.3, marginBottom: 6 },
  summary: { fontSize: 10, lineHeight: 1.55, color: INK_MUTED, marginBottom: 18 },

  pulseRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: SURFACE,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 22,
  },
  pulseLabel: { fontSize: 8, letterSpacing: 0.6, color: INK_MUTED },
  pulseMeta: { fontSize: 9, color: INK_MUTED, marginTop: 2 },
  pulseValue: { fontSize: 24, fontWeight: 700, lineHeight: 1.15, textAlign: "right" },
  pulseDelta: { fontSize: 9, marginTop: 2, textAlign: "right" },

  sectionTitle: { fontSize: 12, fontWeight: 600, marginBottom: 8 },

  action: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  actionNumber: { width: 18, fontSize: 11, fontWeight: 700, color: ACCENT },
  actionBody: { flex: 1 },
  actionText: { fontSize: 10.5, fontWeight: 600, lineHeight: 1.45 },
  quote: {
    fontSize: 9,
    lineHeight: 1.5,
    color: INK_MUTED,
    marginTop: 6,
    paddingLeft: 8,
    borderLeftWidth: 2,
    borderLeftColor: LINE,
  },
  actionMeta: { fontSize: 8, color: INK_MUTED, marginTop: 6 },

  line: { flexDirection: "row", gap: 6, marginBottom: 4 },
  lineText: { fontSize: 9.5, lineHeight: 1.45, flex: 1 },

  themeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: LINE,
    paddingVertical: 5,
  },
  themeLabel: { fontSize: 9.5, flex: 3 },
  themeCount: { fontSize: 9, color: INK_MUTED, flex: 1, textAlign: "right" },

  section: { marginBottom: 20 },
  empty: { fontSize: 9, color: INK_MUTED },

  /**
   * In normal flow, **not** `position: absolute; bottom` + `fixed`.
   *
   * That is the pattern `src/reports/document.ts` uses and it renders nothing —
   * verified by rendering both documents and looking at them, not inferred:
   * under `@react-pdf/layout` 4.6.1 the absolutely-positioned footer is absent
   * from the output entirely. The scheduled report has therefore been mailing
   * PDFs with no footer and no page number since P3-T5 shipped, which is
   * reported rather than fixed here — it is a different document and changing
   * what it prints is not this task.
   *
   * `marginTop: "auto"` pushes it to the foot of the content, which is what the
   * position was for.
   *
   * **There is no page number**, for the same reason: a `<Text render={…}>`
   * emits nothing here either, with or without `fixed`. Rather than ship a
   * callback that silently produces an empty column, the footer carries only
   * what it can actually print. A briefing is one page in practice, so the loss
   * is pagination on a document that does not paginate.
   */
  footer: {
    marginTop: "auto",
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: LINE,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: INK_MUTED,
  },
});

export type DigestPdfContent = {
  /** "Kadıköy Kahve — Kadıköy Şubesi". */
  scopeName: string;
  /** "27 Temmuz – 2 Ağustos 2026", already formatted and localised. */
  period: string;
  eyebrow: string;
  headline: string;
  summary: string;
  pulse: {
    label: string;
    /** Null where there was not enough to measure — never rendered as zero. */
    value: string | null;
    /** "31 yorum". */
    meta: string;
    delta: string | null;
    direction: "up" | "down" | "flat" | null;
  };
  actionsTitle: string;
  actions: {
    position: number;
    text: string;
    quote: string | null;
    /** "bekleme süresi temasında 4 yorum · Yapıldı". */
    meta: string | null;
  }[];
  actionsEmpty: string;
  changesTitle: string;
  changes: { key: string; text: string; direction: "up" | "down" | "flat" }[];
  themesTitle: string;
  themes: { key: string; label: string; meta: string }[];
  footer: string;
};

function directionColour(direction: "up" | "down" | "flat" | null): string {
  if (direction === "up") return POSITIVE;
  if (direction === "down") return NEGATIVE;
  return INK_MUTED;
}

/**
 * An arrow, as a character rather than a drawing.
 *
 * `↑ ↓ → ★ ☆` are all present in the two committed Inter faces — measured with
 * fontkit against the actual files, not assumed. Worth stating because
 * `src/reports/document.ts` records the opposite about stars and writes
 * "4,3 / 5" to avoid one; that constraint was true of the *subsetted* Google
 * files and stopped being true when the unsubsetted TTFs were committed
 * (P3-T5). It has not been revisited there, deliberately — the scheduled report
 * is a different document and changing what it prints is not this task.
 *
 * The care is still warranted: `@react-pdf` renders a missing glyph as nothing
 * at all rather than as tofu, so an unchecked decorative character becomes a
 * silently empty column.
 */
function arrow(direction: "up" | "down" | "flat"): string {
  if (direction === "up") return "↑";
  if (direction === "down") return "↓";
  return "→";
}

function actionBlock(action: DigestPdfContent["actions"][number]): ReactElement {
  return createElement(
    View,
    { key: String(action.position), style: styles.action, wrap: false },
    createElement(Text, { style: styles.actionNumber }, String(action.position)),
    createElement(
      View,
      { style: styles.actionBody },
      createElement(Text, { style: styles.actionText }, action.text),
      action.quote ? createElement(Text, { style: styles.quote }, action.quote) : null,
      action.meta ? createElement(Text, { style: styles.actionMeta }, action.meta) : null,
    ),
  );
}

export function digestDocument(content: DigestPdfContent): ReactElement {
  return createElement(
    Document,
    { title: `${content.scopeName} — ${content.period}` },
    createElement(
      Page,
      { size: "A4", style: styles.page },

      // The cover: eyebrow, the model's own headline, the summary beneath it.
      createElement(Text, { style: styles.eyebrow }, content.eyebrow.toUpperCase()),
      createElement(Text, { style: styles.title }, content.headline),
      content.summary ? createElement(Text, { style: styles.summary }, content.summary) : null,

      createElement(
        View,
        { style: styles.pulseRow },
        createElement(
          View,
          {},
          createElement(Text, { style: styles.pulseLabel }, content.pulse.label.toUpperCase()),
          createElement(Text, { style: styles.pulseMeta }, content.pulse.meta),
        ),
        createElement(
          View,
          {},
          createElement(Text, { style: styles.pulseValue }, content.pulse.value ?? "—"),
          content.pulse.delta
            ? createElement(
                Text,
                {
                  style: [styles.pulseDelta, { color: directionColour(content.pulse.direction) }],
                },
                content.pulse.delta,
              )
            : null,
        ),
      ),

      createElement(
        View,
        { style: styles.section },
        createElement(Text, { style: styles.sectionTitle }, content.actionsTitle),
        content.actions.length === 0
          ? createElement(Text, { style: styles.empty }, content.actionsEmpty)
          : createElement(View, {}, ...content.actions.map(actionBlock)),
      ),

      content.changes.length > 0
        ? createElement(
            View,
            { style: styles.section },
            createElement(Text, { style: styles.sectionTitle }, content.changesTitle),
            ...content.changes.map((change) =>
              createElement(
                View,
                { key: change.key, style: styles.line },
                createElement(
                  Text,
                  { style: { color: directionColour(change.direction), fontSize: 9.5 } },
                  arrow(change.direction),
                ),
                createElement(Text, { style: styles.lineText }, change.text),
              ),
            ),
          )
        : null,

      content.themes.length > 0
        ? createElement(
            View,
            { style: styles.section },
            createElement(Text, { style: styles.sectionTitle }, content.themesTitle),
            ...content.themes.map((theme) =>
              createElement(
                View,
                { key: theme.key, style: styles.themeRow },
                createElement(Text, { style: styles.themeLabel }, theme.label),
                createElement(Text, { style: styles.themeCount }, theme.meta),
              ),
            ),
          )
        : null,

      createElement(View, { style: styles.footer }, createElement(Text, {}, content.footer)),
    ),
  );
}

export async function renderDigestPdf(content: DigestPdfContent): Promise<Buffer> {
  registerReportFonts();
  // The cast is the library's own types being stricter about `Document` than
  // `createElement` can express; the tree above is exactly what it documents.
  return renderToBuffer(digestDocument(content) as never);
}
