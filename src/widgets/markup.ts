import { sourceShortLabel } from "../connectors/source-label.ts";
import type { Locale } from "../i18n/config.ts";
import { SIZE_MESSAGE_TYPE, isBadgeLayout, type WidgetStyle } from "./config.ts";
import type { PublicReview, WidgetContent } from "./public.ts";
import { widgetStylesheet } from "./theme.ts";

/**
 * The widget, rendered to HTML — and the only renderer there is.
 *
 * Written as a string builder rather than a React component on purpose. The
 * same markup has to be servable from a route handler as a standalone document
 * (the iframe the embed script mounts), and nothing about it needs React: it is
 * static output from a JSON payload, with no state and no interactivity beyond
 * a link. One renderer means the embed and the in-app preview cannot drift.
 *
 * **Everything interpolated here is untrusted.** Review text, author names and
 * source keys come from third-party platforms or from a public form, and this
 * output goes onto the open internet inside somebody else's page. `escape()` is
 * applied at every boundary without exception, and no path constructs an
 * attribute from unvalidated input — the only URL that reaches an `href` is the
 * provider's own review link, and it is scheme-checked first.
 */

export type WidgetLabels = {
  /**
   * The text equivalent of the star row, one entry per rating: index 0 reads
   * "1 out of 5". Pre-formatted rather than a template with a placeholder,
   * following the collection form — interpolation is `next-intl`'s job, and a
   * `replace()` in here would quietly bypass its plural and number rules.
   */
  ratingLabels: string[];
  /** Shown when nothing is approved yet. */
  empty: string;
  /**
   * "842 reviews" — a function, not a formatted string, because English
   * pluralises on the number and Turkish does not. `next-intl` owns that rule.
   */
  badgeCount: (count: number) => string;
  /** A badge with nothing rated yet. Never a zero. */
  badgeNoRatings: string;
  /** The badge's link to the hosted review page — an accessible name, not text. */
  badgeLink: string;
  /** Link to the review where it was originally published. */
  viewOriginal: string;
  poweredBy: string;
};

/** The five characters that can change the meaning of HTML. */
export function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A provider URL we are willing to put in an `href`.
 *
 * `javascript:` and `data:` URLs are the reason this exists. The link comes from
 * a connector's payload, which is upstream data — and a widget is rendered on a
 * customer's domain, so a scripted URL here would run in *their* origin.
 */
function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Star row: filled to the rating, hollow to five.
 *
 * `aria-hidden` on the graphic and the value in visually-hidden text beside it,
 * because "★★★★☆" announced glyph by glyph is noise. One SVG path, repeated —
 * an icon font or a sprite would be a network request on someone else's page.
 */
function stars(rating: number, label: string): string {
  const star = (filled: boolean) =>
    `<svg class="rvw-star${filled ? "" : " rvw-star--empty"}" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L1.6 7.7l5.8-.8z"/></svg>`;

  const glyphs = Array.from({ length: 5 }, (_, index) => star(index < rating)).join("");
  return `<div class="rvw-stars">${glyphs}<span class="rvw-sr">${escape(label)}</span></div>`;
}

function formatDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
}

function renderCard(
  review: PublicReview,
  style: WidgetStyle,
  locale: Locale,
  labels: WidgetLabels,
): string {
  const parts: string[] = [];

  if (review.rating !== null) {
    parts.push(stars(review.rating, labels.ratingLabels[review.rating - 1] ?? ""));
  }

  if (review.text) {
    parts.push(`<p class="rvw-text">${escape(review.text)}</p>`);
  }

  const meta: string[] = [];
  if (style.showAuthor && review.authorName) {
    meta.push(`<span class="rvw-author">${escape(review.authorName)}</span>`);
  }
  if (style.showSource) {
    meta.push(`<span>${escape(sourceShortLabel(review.source))}</span>`);
  }
  if (style.showDate && review.postedAt) {
    meta.push(`<span>${escape(formatDate(review.postedAt, locale))}</span>`);
  }

  const href = safeHref(review.url);
  if (href) {
    // `nofollow ugc` because these are third-party links a business placed on
    // its own site — exactly what the attribute is for, and leaving it off is
    // the kind of thing that costs a customer search ranking.
    meta.push(
      `<a class="rvw-link" href="${escape(href)}" target="_blank" rel="noopener noreferrer nofollow ugc">${escape(labels.viewOriginal)}</a>`,
    );
  }

  if (meta.length > 0) {
    parts.push(
      `<p class="rvw-meta">${meta.join('<span class="rvw-sep" aria-hidden="true">·</span>')}</p>`,
    );
  }

  return `<li class="rvw-card">${parts.join("")}</li>`;
}

/**
 * The rating badge: one number, what it is out of, and how many it came from.
 *
 * **The number is not curated, and that is the whole point.** It is the average
 * of every rated review in the widget's scope — approved or not, above the
 * widget's minimum rating or not. A business may choose which reviews it
 * *quotes*; it may not choose the score, because "4.8 · 320 reviews" is a claim
 * about what customers said, and an average taken over a hand-picked subset is
 * a claim about what the business picked. See `PublicAggregate` for the same
 * reasoning at the query.
 *
 * It carries **no JSON-LD**, deliberately. Google's review-snippet policy makes
 * a business's own reviews on its own site ineligible for the star feature, so
 * markup here would be a claim we are not entitled to make — see the P3-T3
 * amendment in `docs/19`. The badge is a picture of a number, not an assertion
 * to a search engine.
 */
function renderBadge(content: WidgetContent, labels: WidgetLabels): string {
  const { aggregate, widget } = content;

  // No rating is a state, not a zero. `docs/15` §Content: "no rating", never an
  // invented average.
  if (aggregate.average === null || aggregate.count === 0) {
    return [
      `<div class="rvw rvw--badge">`,
      `<div class="rvw-badge rvw-badge--empty">`,
      `<span class="rvw-badge-meta">${escape(labels.badgeNoRatings)}</span>`,
      `</div>`,
      `</div>`,
    ].join("");
  }

  // Rounded to the nearest star for the glyphs; the exact figure is beside them
  // as text, so nothing is lost to the rounding.
  const rounded = Math.round(aggregate.average);
  const score = formatScore(aggregate.average, widget.locale);

  /**
   * The link `docs/19` asks for, finally pointing somewhere (P3-T2 → P3-T3).
   *
   * It was left off when the badge shipped because the hosted review page did
   * not exist yet, and a badge on a customer's homepage linking to a 404 is
   * worse than one that links nowhere. `pageUrl` is null unless the widget names
   * a location whose page is actually published, so that stays true.
   *
   * `target="_blank"` because this frame is sandboxed on somebody else's site
   * and navigating it in place would replace the badge with a full page inside
   * a 150-pixel box. `nofollow` for the same reason the review links carry it,
   * and an accessible name because "3,8 · 43 reviews" as link text does not say
   * where it goes.
   */
  const href = safeHref(widget.pageUrl);
  const open = href
    ? `<a class="rvw-badge-link" href="${escape(href)}" target="_blank" rel="noopener noreferrer nofollow" aria-label="${escape(labels.badgeLink)}">`
    : "";
  const close = href ? `</a>` : "";

  return [
    /**
     * `rvw--badge` on the **root**, not just on the box.
     *
     * It is what makes the root inline-sized, and the root's box is what the
     * frame is sized from — so this class is the difference between a badge
     * that hugs its own content and a 44-pixel badge marooned in a full-bleed
     * rectangle. `src/widgets/theme.ts` carries the rule and the reason the
     * document's `color-scheme` goes with it.
     */
    `<div class="rvw rvw--badge">`,
    open,
    `<div class="rvw-badge">`,
    `<span class="rvw-badge-score">${escape(score)}</span>`,
    `<span class="rvw-badge-lines">`,
    `<span class="rvw-badge-row">`,
    stars(rounded, labels.ratingLabels[rounded - 1] ?? ""),
    `</span>`,
    `<span class="rvw-badge-meta">${escape(labels.badgeCount(aggregate.count))}</span>`,
    `</span>`,
    `</div>`,
    close,
    `</div>`,
  ].join("");
}

/** Locale-formatted, so Turkish gets its decimal comma (`docs/15` §Content). */
function formatScore(average: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(average);
}

/** The widget's body — the part that is identical in every host. */
export function renderWidgetBody(content: WidgetContent, labels: WidgetLabels): string {
  const { widget, reviews } = content;
  const { style, locale } = widget;

  if (isBadgeLayout(style.layout)) return renderBadge(content, labels);

  if (reviews.length === 0) {
    return `<div class="rvw"><p class="rvw-empty">${escape(labels.empty)}</p></div>`;
  }

  const cards = reviews.map((review) => renderCard(review, style, locale, labels)).join("");

  return [
    `<div class="rvw">`,
    // A list, because that is what it is: assistive technology announces the
    // count, which is the single most useful thing to know before reading nine
    // testimonials.
    `<ul class="rvw-list rvw-${style.layout}" aria-label="${escape(widget.name)}">${cards}</ul>`,
    `<p class="rvw-footer">${escape(labels.poweredBy)}</p>`,
    `</div>`,
  ].join("");
}

/**
 * The standalone document the iframe loads.
 *
 * `lang` is the widget's language, not the host page's — a Turkish café's
 * reviews are Turkish however the surrounding site is marked up, and getting
 * this wrong makes a screen reader read Turkish with English phonetics.
 *
 * `noindex` because the canonical, indexable home for these reviews is the SEO
 * page (P3-T3). An iframe body competing with it in the index would split the
 * signal and put a chrome-less fragment in search results.
 */
export function renderWidgetDocument(content: WidgetContent, labels: WidgetLabels): string {
  const { widget } = content;

  return `<!doctype html>
<html lang="${escape(widget.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(widget.name)}</title>
<style>${widgetStylesheet(widget.style)}</style>
</head>
<body>
${renderWidgetBody(content, labels)}
${AUTO_SIZE_SCRIPT}
</body>
</html>`;
}

/**
 * Tells the parent page how big the widget wants to be.
 *
 * An iframe has a fixed size and its content does not; without this, a widget
 * either clips its last row or leaves a slab of empty space. The message is
 * posted to `*` — the parent is the customer's own site and we do not know its
 * origin — which is safe only because the message carries nothing but two
 * numbers and this frame accepts no messages at all. The loader ignores
 * anything that does not name its own frame.
 *
 * `ResizeObserver` rather than a poll: it fires on font loading and on the
 * reflow when the host column changes width, which are exactly the two moments
 * a fixed size goes wrong.
 *
 * **It measures the widget element, not the document**, and that is the whole
 * trick. `documentElement.scrollHeight` never reports less than the viewport,
 * and the viewport here *is* the iframe the parent is about to resize — so the
 * obvious version is a feedback loop that can only grow: taller frame, taller
 * "content", taller frame. Observed in the browser at 1119px for 160px of
 * reviews. The widget root's own box is independent of the frame's height, so
 * it converges immediately and shrinks as readily as it grows.
 *
 * **Width is reported only when the root is inline-sized**, which today means
 * the rating badge (`.rvw--badge`, see `src/widgets/theme.ts`). The same
 * feedback-loop reasoning is why it cannot simply always be sent: a review wall
 * is a block, so its width *is* the frame's width, and posting that back would
 * be a measurement of the answer rather than of the content. An inline-block
 * root is sized by `max-content`, which owes nothing to the frame — so it
 * converges for the same reason height does, and the badge stops being a
 * 44-pixel box in a full-bleed rectangle.
 */
/** The element whose box is the widget's size. */
const ROOT_SELECTOR = ".rvw";

/**
 * Exported as bare source so the route can hash it into a `script-src` CSP.
 *
 * This document renders review text written by strangers. `'unsafe-inline'`
 * would be defensible — everything is escaped — but a hash costs four lines and
 * means the escaping is no longer the only thing standing between a mistake and
 * script execution on a customer's domain.
 */
export const AUTO_SIZE_SOURCE = `
(function () {
  var root = document.querySelector(${JSON.stringify(ROOT_SELECTOR)});
  if (!root) return;
  function post() {
    var box = root.getBoundingClientRect();
    /* "inline", "inline-block", "inline-flex" — a root that is sized by its own
       content rather than by the frame, and therefore safe to measure across. */
    var inline = getComputedStyle(root).display.indexOf("inline") === 0;
    parent.postMessage({
      type: ${JSON.stringify(SIZE_MESSAGE_TYPE)},
      height: Math.ceil(box.height),
      width: inline ? Math.ceil(box.width) : null
    }, "*");
  }
  if (window.ResizeObserver) new ResizeObserver(post).observe(root);
  window.addEventListener("load", post);
  post();
})();
`;

const AUTO_SIZE_SCRIPT = `<script>${AUTO_SIZE_SOURCE}</script>`;
