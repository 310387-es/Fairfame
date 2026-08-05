import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIDGET_FILTERS,
  DEFAULT_WIDGET_STYLE,
  parseFilters,
  parseStyle,
  widgetConfigFromParams,
  widgetConfigToParams,
  type WidgetConfig,
} from "@/widgets/config";

/**
 * The widget config, and its trip through a query string (P3-T0/T1).
 *
 * The round trip is not decoration: the builder's preview is an iframe, so the
 * unsaved config reaches the renderer as a URL and comes back out through the
 * same schema the database column is read with. If the two forms disagree, the
 * preview shows something the saved widget will not — the exact failure a live
 * preview exists to prevent.
 */

const config = (overrides: Partial<WidgetConfig> = {}): WidgetConfig => ({
  filters: DEFAULT_WIDGET_FILTERS,
  style: DEFAULT_WIDGET_STYLE,
  ...overrides,
});

describe("the query-string round trip", () => {
  it("returns the defaults through an empty query string", () => {
    expect(widgetConfigFromParams(new URLSearchParams())).toEqual(config());
  });

  it("writes nothing for a default-valued config", () => {
    // A URL that spells out every field would change on every unrelated edit
    // and reload the preview for nothing.
    expect(widgetConfigToParams(config()).toString()).toBe("");
  });

  it("survives a fully non-default config unchanged", () => {
    const original = config({
      filters: parseFilters({
        sources: ["google", "instagram"],
        minRating: 4,
        itemTypes: ["review", "comment"],
        requireText: false,
        count: 21,
      }),
      style: parseStyle({
        layout: "carousel",
        theme: "dark",
        locale: "en",
        accent: "#00695c",
        showAuthor: false,
        showSource: false,
        showDate: false,
      }),
    });

    expect(widgetConfigFromParams(widgetConfigToParams(original))).toEqual(original);
  });
});

describe("a query string somebody typed", () => {
  it("drops one bad value without resetting the rest", () => {
    // The rule that matters in the builder: a bad `min` must not silently undo
    // the layout the person just chose.
    const parsed = widgetConfigFromParams(
      new URLSearchParams({ layout: "carousel", min: "9", theme: "dark" }),
    );

    expect(parsed.style.layout).toBe("carousel");
    expect(parsed.style.theme).toBe("dark");
    expect(parsed.filters.minRating).toBeNull();
  });

  it("refuses an accent that is not a colour", () => {
    // This value reaches a generated stylesheet, so anything that is not a hex
    // triplet is dropped rather than escaped.
    const parsed = widgetConfigFromParams(
      new URLSearchParams({ accent: "red; } body { display:none" }),
    );

    expect(parsed.style.accent).toBeNull();
  });

  it("ignores an item type that is not displayable", () => {
    // `dm` is not in the vocabulary at all — a direct message was never public.
    const parsed = widgetConfigFromParams(new URLSearchParams({ types: "review,dm,nonsense" }));

    expect(parsed.filters.itemTypes).toEqual(["review"]);
  });

  it("clamps a count nobody should be asking for", () => {
    expect(widgetConfigFromParams(new URLSearchParams({ count: "5000" })).filters.count).toBe(
      DEFAULT_WIDGET_FILTERS.count,
    );
  });
});

describe("reading a stored config", () => {
  it("falls back rather than throwing on a hand-edited row", () => {
    expect(parseFilters({ minRating: "very good" })).toEqual(DEFAULT_WIDGET_FILTERS);
    expect(parseStyle(42)).toEqual(DEFAULT_WIDGET_STYLE);
    expect(parseStyle(null)).toEqual(DEFAULT_WIDGET_STYLE);
  });
});
