import { describe, expect, it } from "vitest";
import { DEFAULT_WIDGET_FILTERS, DEFAULT_WIDGET_STYLE } from "@/widgets/config";
import { escape, renderWidgetBody, renderWidgetDocument } from "@/widgets/markup";
import type { PublicReview, PublicWidget, WidgetContent } from "@/widgets/public";

/**
 * The widget renderer (P3-T0).
 *
 * Two jobs, and the first one is the reason this file exists. The renderer
 * takes review text written by strangers on the internet and puts it inside a
 * frame on a paying customer's domain. If an author name can close a tag, the
 * product ships a stored XSS to every business that embeds a widget.
 *
 * The second is that the output stays accessible and stays offline — no
 * network, no framework, a text equivalent for every star row.
 */

const widget = (overrides: Partial<PublicWidget> = {}): PublicWidget => ({
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
  ...overrides,
});

const review = (overrides: Partial<PublicReview> = {}): PublicReview => ({
  id: "r1",
  rating: 5,
  text: "Kahvesi çok güzeldi.",
  authorName: "Ayşe",
  source: "google",
  itemType: "review",
  postedAt: "2026-07-20T10:00:00.000Z",
  url: "https://maps.google.com/review/1",
  ...overrides,
});

const content = (
  reviews: PublicReview[],
  w = widget(),
  aggregate: WidgetContent["aggregate"] = {
    basis: "all_reviews_in_scope",
    average: 4.6,
    count: 12,
  },
): WidgetContent => ({ widget: w, reviews, aggregate });

/** The same widget, drawn as a badge. */
const badge = (locale: PublicWidget["locale"] = "tr") =>
  widget({ locale, style: { ...DEFAULT_WIDGET_STYLE, layout: "badge" } });

const labels = {
  ratingLabels: ["1/5", "2/5", "3/5", "4/5", "5 üzerinden 5"],
  empty: "Henüz yorum yok.",
  badgeCount: (count: number) => `${count} yorum`,
  badgeNoRatings: "Henüz puan yok",
  badgeLink: "Tüm yorumları gör",
  viewOriginal: "Kaynağında oku",
  poweredBy: "Fairfame",
};

describe("untrusted content", () => {
  it("escapes a script tag in review text", () => {
    const html = renderWidgetBody(
      content([review({ text: "<script>alert(document.cookie)</script>" })]),
      labels,
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an author name that tries to break out of its element", () => {
    const html = renderWidgetBody(
      content([review({ authorName: '"><img src=x onerror=alert(1)>' })]),
      labels,
    );

    // The payload survives as *text* — that is the point, since it is the
    // author's name. What must not survive is its punctuation: with `<` and `"`
    // escaped there is no tag and no attribute, so `onerror` is just letters.
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes a source key, which is also upstream data", () => {
    // A connector's `source` looks like a constant we control. It is a string
    // from a row, and rows are written by ingestion.
    const html = renderWidgetBody(content([review({ source: "<b>google" })]), labels);
    expect(html).not.toContain("<b>");
  });

  it("escapes the widget's own name, which its owner typed", () => {
    const html = renderWidgetBody(
      content([review()], widget({ name: '" onload="alert(1)' })),
      labels,
    );
    expect(html).not.toContain('onload="alert');
  });

  it("drops a scripted URL rather than putting it in an href", () => {
    const scripted = ["java", "script:alert(1)"].join("");
    const html = renderWidgetBody(content([review({ url: scripted })]), labels);

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Kaynağında oku");
  });

  it("keeps an ordinary https link, with rel attributes that protect the host page", () => {
    const html = renderWidgetBody(content([review()]), labels);

    expect(html).toContain('href="https://maps.google.com/review/1"');
    expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
  });

  it("escapes every one of the five significant characters", () => {
    expect(escape(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });
});

describe("what a screen reader gets", () => {
  it("gives every star row a text equivalent", () => {
    const html = renderWidgetBody(content([review({ rating: 5 })]), labels);

    // The SVG says nothing on its own, and is hidden so it says nothing loudly.
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("5 üzerinden 5");
  });

  it("marks the reviews up as a list, so their number is announced", () => {
    const html = renderWidgetBody(content([review(), review({ id: "r2" })]), labels);
    expect(html).toContain("<ul");
    expect((html.match(/<li /g) ?? []).length).toBe(2);
  });

  it("declares the widget's language, not the host page's", () => {
    const html = renderWidgetDocument(content([review()]), labels);
    expect(html).toContain('<html lang="tr">');
  });
});

describe("the document", () => {
  it("keeps itself out of the search index, so it cannot compete with the SEO page", () => {
    expect(renderWidgetDocument(content([review()]), labels)).toContain(
      'name="robots" content="noindex, nofollow"',
    );
  });

  it("requests nothing over the network", () => {
    const html = renderWidgetDocument(content([review()]), labels);

    // One outbound link — the review itself — and no subresource of any kind.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toContain("<img");
  });

  it("says so plainly when nothing has been approved yet", () => {
    const html = renderWidgetBody(content([]), labels);

    expect(html).toContain("Henüz yorum yok.");
    expect(html).not.toContain("<ul");
  });

  it("renders each layout under its own class", () => {
    for (const layout of ["grid", "list", "carousel"] as const) {
      const html = renderWidgetBody(
        content([review()], widget({ style: { ...DEFAULT_WIDGET_STYLE, layout } })),
        labels,
      );
      expect(html).toContain(`rvw-list rvw-${layout}`);
    }
  });

  it("honours the style's field toggles", () => {
    const hidden = { ...DEFAULT_WIDGET_STYLE, showAuthor: false, showDate: false };
    const html = renderWidgetBody(content([review()], widget({ style: hidden })), labels);

    expect(html).not.toContain("Ayşe");
    expect(html).toContain("Google");
  });
});

/**
 * The rating badge (P3-T2).
 *
 * A badge is a *layout*, so most of what is above already covers it. What is
 * specific to it — and what these assertions are for — is that it draws a
 * number nobody chose, that it says "no ratings yet" rather than inventing a
 * zero, and that it prints that number in the widget's language.
 */
describe("the rating badge", () => {
  it("draws the aggregate and none of the reviews", () => {
    const html = renderWidgetBody(content([review()], badge()), labels);

    // The modifier goes on the *root*, which is the element the frame is sized
    // from — without it the badge is measured as a full-width block and the
    // embed keeps a rectangle around it.
    expect(html).toContain(`class="rvw rvw--badge"`);
    expect(html).toContain("4,6");
    expect(html).toContain("12 yorum");
    // The reviews are still in the payload — a badge and a wall share one
    // endpoint. The badge simply does not render them.
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("Kahvesi çok güzeldi.");
  });

  it("shows the number every rated review produced, not the one on display", () => {
    // The integrity rule, at the renderer: `loadWidgetContent` computes this
    // over the whole scope (see tests/db/widgets-public.test.ts), and the badge
    // prints what it is given rather than recomputing from `reviews`, which
    // holds only the approved ones.
    const oneFiveStarOnDisplay = [review({ rating: 5 })];
    const html = renderWidgetBody(
      content(oneFiveStarOnDisplay, badge(), {
        basis: "all_reviews_in_scope",
        average: 3,
        count: 2,
      }),
      labels,
    );

    expect(html).toContain("3,0");
    expect(html).not.toContain("5,0");
  });

  it("is inline-sized when it has nothing to report, too", () => {
    // The empty state is still a badge — if it went out as a block root, a
    // business with no ratings yet would get a full-width band on their page
    // saying "no ratings yet".
    const html = renderWidgetBody(
      content([], badge(), { basis: "all_reviews_in_scope", average: null, count: 0 }),
      labels,
    );

    expect(html).toContain(`class="rvw rvw--badge"`);
  });

  it("says there are no ratings rather than showing a zero", () => {
    const html = renderWidgetBody(
      content([], badge(), { basis: "all_reviews_in_scope", average: null, count: 0 }),
      labels,
    );

    expect(html).toContain("Henüz puan yok");
    expect(html).not.toContain("0,0");
    expect(html).not.toContain("rvw-badge-score");
  });

  it("does not invent an average from a count of nothing", () => {
    // The shape a `null` average cannot produce but a rounding bug could: a
    // number with no reviews behind it.
    const html = renderWidgetBody(
      content([], badge(), { basis: "all_reviews_in_scope", average: 0, count: 0 }),
      labels,
    );

    expect(html).toContain("Henüz puan yok");
  });

  it("prints the score in the widget's language, decimal separator and all", () => {
    // Turkish writes 4,6 and English 4.6. Getting this from `Intl` rather than
    // `toFixed(1)` is the whole reason the locale is threaded this far down.
    const tr = renderWidgetBody(content([], badge("tr")), labels);
    const en = renderWidgetBody(content([], badge("en")), labels);

    expect(tr).toContain("4,6");
    expect(en).toContain("4.6");
  });

  it("makes no structured-data claim about the score", () => {
    // The P3-T3 amendment in docs/19, asserted where it can regress. A
    // business's own reviews on its own site are ineligible for Google's star
    // feature, so markup here would be a claim we are not entitled to make.
    const html = renderWidgetDocument(content([review()], badge()), labels);

    expect(html).not.toContain("ld+json");
    expect(html).not.toContain("AggregateRating");
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });

  it("links to the hosted review page when there is one to link to", () => {
    // The `docs/19` requirement that P3-T2 deliberately deferred: the badge
    // "links to the SEO page", and that page only came into existence in T3.
    const linked = badge();
    const html = renderWidgetBody(
      content([], { ...linked, pageUrl: "https://fairfame.example/reviews/kadikoy-kahve" }),
      labels,
    );

    expect(html).toContain('href="https://fairfame.example/reviews/kadikoy-kahve"');
    // The whole badge is the target, so the anchor wraps the box.
    expect(html).toContain('class="rvw-badge-link"');
    // An accessible name, because "3,8 · 12 reviews" does not say where it goes.
    expect(html).toContain('aria-label="Tüm yorumları gör"');
    // Opened in a new tab: this frame is a 150-pixel box on somebody else's
    // page, and navigating it in place would replace the badge with a page.
    expect(html).toContain('target="_blank"');
  });

  it("does not link anywhere when the page is not published", () => {
    // Null is the normal case — an organization-wide widget has no single page,
    // and an unpublished one would be a link to a 404 on a customer's homepage.
    const html = renderWidgetBody(content([], badge()), labels);

    expect(html).not.toContain("rvw-badge-link");
    expect(html).not.toContain("<a ");
  });

  it("refuses a scripted URL in the badge's link, like every other href", () => {
    // `pageUrl` is ours rather than a connector's, but it still passes through
    // the same scheme check — a URL is a URL.
    const scripted = ["java", "script:alert(1)"].join("");
    const html = renderWidgetBody(content([], { ...badge(), pageUrl: scripted }), labels);

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("rvw-badge-link");
  });

  it("carries a text equivalent for its stars", () => {
    // Rounded to the nearest star for the glyphs, with the exact figure beside
    // them — so the rounding costs nothing, including for a screen reader.
    const html = renderWidgetBody(content([], badge()), labels);
    expect(html).toContain("5 üzerinden 5");
  });
});
