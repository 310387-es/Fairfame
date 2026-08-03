import QRCode from "qrcode";

/**
 * QR codes for campaign short links.
 *
 * Two forms, for two jobs: an inline SVG for the dashboard (scales crisply,
 * costs no extra request) and a PNG for download, which is what actually gets
 * dropped into a poster, a receipt template, or a table tent.
 *
 * Error-correction level M — roughly 15% of the code can be obscured and still
 * scan. That is the right trade for something printed and then handled: L is
 * fragile on a smudged receipt, and H would inflate a code that already has to
 * stay readable at table-tent size.
 */

const OPTIONS = {
  errorCorrectionLevel: "M",
  // Quiet-zone width in modules. The spec asks for 4; 2 keeps the code compact
  // while leaving enough margin for reliable detection against a light page.
  margin: 2,
} as const;

export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { ...OPTIONS, type: "svg" });
}

/** 1024px: large enough to print at poster size without visible stair-stepping. */
export async function qrPng(text: string, width = 1024): Promise<Buffer> {
  return QRCode.toBuffer(text, { ...OPTIONS, type: "png", width });
}
