import { createHash } from "node:crypto";

/**
 * The Content-Security-Policy for an embed document, derived **from that
 * document**.
 *
 * The obvious way to write this is to hash the same constants the renderer
 * interpolates — `widgetStylesheet(style)` and `AUTO_HEIGHT_SOURCE` — and that
 * is what this replaced. It was wrong in a way that would not have surfaced for
 * months: the hash must cover the element's text content *exactly*, so a stray
 * newline added around a `<script>` tag in the renderer breaks the match, the
 * browser blocks the script, and the widget silently stops resizing. Everything
 * still passes, because a route asserting a hash against a constant is asserting
 * against itself.
 *
 * Reading the hashes out of the finished document removes the second source of
 * truth. Add a stylesheet, reorder the head, reformat the script — the policy
 * follows, because it is computed from what will actually be sent.
 */

/** Inline `<style>` and `<script>` bodies, in document order. */
function inlineBlocks(document: string, tag: "style" | "script"): string[] {
  // Only tags with no attributes: an inline block is ours, and anything with a
  // `src` or `href` is a subresource that `default-src 'none'` already refuses.
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  return [...document.matchAll(pattern)].map((match) => match[1] ?? "");
}

function sourceHash(source: string): string {
  return `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
}

/**
 * Everything the embed document is allowed to do, which is very little.
 *
 * It renders review text written by strangers, inside a frame on a paying
 * customer's domain. So nothing loads, nothing connects, and the only script
 * and stylesheet permitted are the ones this document actually contains.
 *
 * `frame-ancestors` is the one directive with a choice in it. The public embed
 * must stay open — being framed by any customer site is the entire point, and
 * pinning it to known origins would mean a customer who moves domains silently
 * loses their widget. The in-app preview is the opposite case: it is framed
 * only by our own builder, it is behind a session, and it should be `'self'`.
 */
export function widgetContentSecurityPolicy(
  document: string,
  options: { frameAncestors?: "*" | "'self'" } = {},
): string {
  const styles = inlineBlocks(document, "style").map(sourceHash);
  const scripts = inlineBlocks(document, "script").map(sourceHash);

  return [
    "default-src 'none'",
    // `'none'` rather than an empty list: a directive with no source keeps the
    // browser's default, which for a missing directive means `default-src` —
    // correct here by luck, and not something to rely on.
    `style-src ${styles.length > 0 ? styles.join(" ") : "'none'"}`,
    `script-src ${scripts.length > 0 ? scripts.join(" ") : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${options.frameAncestors ?? "*"}`,
  ].join("; ");
}
