import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { qrPng } from "../lib/qr.ts";
import { REPORT_FONT, registerReportFonts } from "../reports/fonts.ts";

/**
 * The QR poster and table tent (W4.5).
 *
 * `docs/remediation-plan.md` calls this the highest ROI-to-effort item in the
 * whole audit, and the reasoning is worth restating because it decides the
 * design: a Turkish café does not collect reviews by emailing people. It
 * collects them from a card on the table, and the gap between "here is a PNG of
 * a QR code, good luck" and "here is an A4 you can print right now" is the
 * entire feature.
 *
 * ## Two layouts, one document
 *
 * **Poster** — one A4, code at 260pt, meant for a wall, a window or a till.
 * **Table tent** — the same A4 with *two* halves printed head-to-head and a
 * fold line between them, so one sheet folded down the middle stands up on a
 * table showing the code on both sides. That is the shape a café actually
 * wants, and it is why this is a document generator rather than an image
 * download: a PNG cannot be folded into a tent.
 *
 * ## Why `createElement` and not JSX
 *
 * The same constraint `src/reports/document.ts` records. That file is imported
 * by the BullMQ worker, which runs `.ts` through Node's own type stripping —
 * types are removed, JSX is not transformed. This module is only reached from a
 * route today, but it shares `registerReportFonts` with that one and there is
 * no version of "half the PDF code may use JSX" that survives somebody moving a
 * function. One rule for both files.
 *
 * ## The fonts are the reason this is not trivial
 *
 * `@react-pdf` falls back to Helvetica, which has no Turkish glyphs — a poster
 * for `Kadıköy Şubesi` would print `Kad1köy ^ubesi` on a wall, in public, at
 * A4. `registerReportFonts` loads the two committed Inter faces, which is the
 * whole reason P3-T5 committed them. See `docs/13`.
 */

export type PosterLayout = "poster" | "tent";

export type PosterInput = {
  layout: PosterLayout;
  /** The business, as it should read on the wall. */
  businessName: string;
  /** The branch, or null on a single-location account where it adds nothing. */
  branchName: string | null;
  /** The campaign's public URL — what the code encodes and what is printed. */
  url: string;
  /** Preformatted, translated by the caller. The renderer has no locale. */
  headline: string;
  subhead: string;
  /** "Or visit" — the line above the printed URL, for a code that will not scan. */
  urlLabel: string;
  foldLabel: string;
};

const INK = "#10193a";
const INK_MUTED = "#5a6180";
const LINE = "#e5e8f2";

const styles = StyleSheet.create({
  page: {
    fontFamily: REPORT_FONT,
    color: INK,
    paddingVertical: 36,
    paddingHorizontal: 44,
  },
  /**
   * A tent half is exactly half the printable page, so the fold lands in the
   * middle of the sheet. `flexGrow: 1` on two of them rather than a fixed
   * height, because A4 minus padding is not a number worth hard-coding twice.
   */
  half: { flexGrow: 1, flexBasis: 0, alignItems: "center", justifyContent: "center" },
  business: { fontSize: 15, fontWeight: 600, textAlign: "center" },
  branch: { fontSize: 11, color: INK_MUTED, textAlign: "center", marginTop: 2 },
  headline: { fontSize: 24, fontWeight: 600, textAlign: "center", lineHeight: 1.3, marginTop: 16 },
  subhead: {
    fontSize: 12,
    color: INK_MUTED,
    textAlign: "center",
    lineHeight: 1.4,
    marginTop: 6,
    maxWidth: 360,
  },
  urlLabel: { fontSize: 9, color: INK_MUTED, textAlign: "center", marginTop: 14 },
  url: { fontSize: 10, textAlign: "center", marginTop: 2 },
  fold: {
    borderTopWidth: 1,
    borderTopStyle: "dashed",
    borderTopColor: LINE,
    paddingTop: 4,
  },
  foldLabel: { fontSize: 7, color: INK_MUTED, textAlign: "center" },
});

/**
 * One face of the poster.
 *
 * `flipped` rotates the top half of a tent 180°, which is what "head-to-head"
 * means: fold the sheet across the middle and both faces read the right way up.
 * Printing two identical halves would give a tent that is upside down on one
 * side, which is the mistake that makes somebody print it twice.
 */
function face(input: PosterInput, qr: string, options: { size: number; flipped?: boolean }) {
  const children = [
    createElement(Text, { key: "business", style: styles.business }, input.businessName),
    input.branchName
      ? createElement(Text, { key: "branch", style: styles.branch }, input.branchName)
      : null,
    createElement(Text, { key: "headline", style: styles.headline }, input.headline),
    createElement(Text, { key: "subhead", style: styles.subhead }, input.subhead),
    createElement(Image, {
      key: "qr",
      src: qr,
      style: { width: options.size, height: options.size, marginTop: 18 },
    }),
    createElement(Text, { key: "urlLabel", style: styles.urlLabel }, input.urlLabel),
    createElement(Text, { key: "url", style: styles.url }, input.url),
  ].filter(Boolean);

  return createElement(
    View,
    {
      style: [
        styles.half,
        // `transform` on a View is supported by @react-pdf's layout engine; a
        // CSS `rotate` shorthand is not.
        ...(options.flipped ? [{ transform: "rotate(180deg)" }] : []),
      ],
    },
    ...children,
  );
}

function document(input: PosterInput, qr: string) {
  const faces =
    input.layout === "tent"
      ? [
          face(input, qr, { size: 150, flipped: true }),
          createElement(
            View,
            { key: "fold", style: styles.fold },
            createElement(Text, { style: styles.foldLabel }, input.foldLabel),
          ),
          face(input, qr, { size: 150 }),
        ]
      : [face(input, qr, { size: 260 })];

  return createElement(
    Document,
    { title: `${input.businessName} — ${input.headline}` },
    createElement(Page, { size: "A4", style: styles.page }, ...faces),
  );
}

export async function renderPoster(input: PosterInput): Promise<Buffer> {
  registerReportFonts();

  /**
   * A data URI rather than the Buffer.
   *
   * `@react-pdf`'s `Image` accepts both, and a Buffer round-trips through its
   * own resolver differently between versions. A base64 `image/png` URI is the
   * form it has always understood, and a poster is generated once per press of
   * a button — the extra third of a kilobyte is not worth a version-dependent
   * source.
   */
  const png = await qrPng(input.url, 1024);
  const qr = `data:image/png;base64,${png.toString("base64")}`;

  return renderToBuffer(document(input, qr));
}
