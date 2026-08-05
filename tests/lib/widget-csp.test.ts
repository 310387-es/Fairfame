import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_WIDGET_FILTERS, DEFAULT_WIDGET_STYLE } from "@/widgets/config";
import { widgetContentSecurityPolicy } from "@/widgets/csp";
import { renderWidgetDocument } from "@/widgets/markup";
import type { PublicWidget, WidgetContent } from "@/widgets/public";

/**
 * The embed document's CSP must match the embed document (P3-T0).
 *
 * This is the test for a bug that had not happened yet. The policy pins the
 * inline script and stylesheet by hash, and a hash has to cover the element's
 * text content byte for byte — so a stray newline added around a `<script>` tag
 * in the renderer blocks the script, the widget silently stops resizing on
 * every customer's site, and nothing goes red. The first version of the route
 * hashed the same constants the renderer interpolated, which meant it was
 * asserting a value against itself.
 *
 * The policy is now computed from the finished document, so the failure mode is
 * structurally gone. These assertions are what keep it gone: they check the
 * hashes against the document independently, and they check that tampering with
 * the document changes them.
 */

const widget: PublicWidget = {
  widgetId: "w1",
  organizationId: "o1",
  organizationName: "Kadıköy Kahve",
  locationId: null,
  locationName: null,
  name: "Müşteri yorumları",
  published: true,
  filters: DEFAULT_WIDGET_FILTERS,
  style: DEFAULT_WIDGET_STYLE,
  locale: "tr",
  pageUrl: null,
};

const content: WidgetContent = {
  widget,
  reviews: [
    {
      id: "r1",
      rating: 5,
      text: "Kahvesi çok güzeldi.",
      authorName: "Ayşe",
      source: "google",
      itemType: "review",
      postedAt: "2026-07-20T10:00:00.000Z",
      url: null,
    },
  ],
  aggregate: { basis: "all_reviews_in_scope", average: 4.6, count: 12 },
};

const labels = {
  ratingLabels: ["1/5", "2/5", "3/5", "4/5", "5/5"],
  empty: "Henüz yorum yok.",
  badgeCount: (count: number) => `${count} yorum`,
  badgeNoRatings: "Henüz puan yok",
  badgeLink: "Tüm yorumları gör",
  viewOriginal: "Kaynağında oku",
  poweredBy: "Revira",
};

/** The hash a browser computes for an inline block, derived independently. */
function expectedHash(source: string): string {
  return `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
}

function inlineBody(document: string, tag: "style" | "script"): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(document);
  if (!match) throw new Error(`The document has no inline <${tag}>.`);
  return match[1]!;
}

describe("the embed document's policy", () => {
  const document = renderWidgetDocument(content, labels);
  const policy = widgetContentSecurityPolicy(document);

  it("pins the exact script the document carries", () => {
    // Computed here from the document's own bytes, the way a browser does it.
    // If the renderer changes how it emits the script, this moves with it — and
    // the route, which derives from the same document, moves too.
    expect(policy).toContain(`script-src ${expectedHash(inlineBody(document, "script"))}`);
  });

  it("pins the exact stylesheet the document carries", () => {
    expect(policy).toContain(`style-src ${expectedHash(inlineBody(document, "style"))}`);
  });

  it("tracks the document rather than a constant", () => {
    // The regression itself: whitespace that changes nothing visible, and used
    // to change everything. A policy that does not move here is a policy pinned
    // to something other than what is served.
    const tampered = document.replace("<script>", "<script>\n");

    expect(widgetContentSecurityPolicy(tampered)).not.toBe(policy);
    expect(widgetContentSecurityPolicy(tampered)).toContain(
      expectedHash(inlineBody(tampered, "script")),
    );
  });

  it("moves with the widget's own styling", () => {
    // Two widgets with different themes have different stylesheets, so they
    // cannot share a policy. A cached header would break one of them.
    const dark = renderWidgetDocument(
      { ...content, widget: { ...widget, style: { ...DEFAULT_WIDGET_STYLE, theme: "dark" } } },
      labels,
    );

    expect(widgetContentSecurityPolicy(dark)).not.toBe(policy);
  });

  it("forbids everything the widget does not need", () => {
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
  });

  it("stays framable by any customer site", () => {
    // The one open directive, and the reason the widget works at all.
    expect(policy).toContain("frame-ancestors *");
  });

  it("refuses rather than falls open when a document has no inline block", () => {
    // A renderer that stopped emitting a script must not produce a policy that
    // permits any script.
    const policy = widgetContentSecurityPolicy("<!doctype html><html><body></body></html>");

    expect(policy).toContain("script-src 'none'");
    expect(policy).toContain("style-src 'none'");
  });
});
