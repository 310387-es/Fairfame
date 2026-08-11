import { z } from "zod";
import { LOCALES } from "../i18n/config.ts";

/**
 * The widget contract — what a widget shows, and how it looks.
 *
 * The single definition of both, and deliberately **db-free**: the in-app
 * builder is a client component, the public endpoint is a server route, and the
 * `widgets.filters` / `widgets.style` jsonb columns are read by both. One Zod
 * schema means a new option is one edit here rather than three that drift.
 *
 * Parsed on the way *in* (a builder submission is external input) and on the
 * way *out* (a jsonb column is whatever was last written to it, including by a
 * hand-edited row or a previous version of this file). `parseFilters` /
 * `parseStyle` never throw: a widget with an unreadable config falls back to
 * the defaults rather than 500-ing a stranger's website.
 */

// ---------------------------------------------------------------------------
// Filters — which reviews qualify
// ---------------------------------------------------------------------------

/**
 * What a widget may display, and the one type it may never.
 *
 * A DM is private correspondence; it cannot be approved for display at all (the
 * database refuses it — see `reviews_dm_never_published`), so it is not an
 * option here either. Listing it and filtering it later would invite exactly
 * the query that forgets to.
 */
export const WIDGET_ITEM_TYPES = ["review", "comment", "mention"] as const;
export type WidgetItemType = (typeof WIDGET_ITEM_TYPES)[number];

/** Enough to fill a page section; past this the embed is a performance problem. */
export const MAX_WIDGET_REVIEWS = 50;
export const DEFAULT_WIDGET_COUNT = 9;

export const widgetFiltersSchema = z.object({
  /**
   * Connector sources to include; empty means every source. Free-form strings
   * rather than an enum because the set of providers grows with each connector
   * and a widget written today must not break when a new one lands.
   */
  sources: z.array(z.string().min(1).max(40)).max(20).default([]),
  /**
   * Hide reviews below this rating. Null shows every rating.
   *
   * Not rating-gating: this decides which of a business's *already published*
   * reviews appear in its own marketing, which is what a testimonial section
   * has always been. Rating-gating is steering who gets asked and where they
   * are sent based on how they feel — that lives in `src/collect/routing.ts`,
   * happens before any rating exists, and remains structurally impossible.
   */
  minRating: z.number().int().min(1).max(5).nullable().default(null),
  /** Empty means every displayable type. */
  itemTypes: z.array(z.enum(WIDGET_ITEM_TYPES)).max(WIDGET_ITEM_TYPES.length).default([]),
  /** Reviews with no text are a rating and a name — never a testimonial. */
  requireText: z.boolean().default(true),
  count: z.number().int().min(1).max(MAX_WIDGET_REVIEWS).default(DEFAULT_WIDGET_COUNT),
});

export type WidgetFilters = z.infer<typeof widgetFiltersSchema>;

// ---------------------------------------------------------------------------
// Style — how it looks
// ---------------------------------------------------------------------------

/**
 * How a widget renders — including `badge`, which renders no reviews at all.
 *
 * A rating badge is a *layout*, not a second kind of entity (P3-T2). It shares
 * everything that matters with the review widget: the same public key, the same
 * publish flag, the same scope, the same embed script, the same builder. What
 * differs is that it draws the aggregate instead of the list, and "how this
 * widget draws itself" is exactly what this field means. A parallel `badges`
 * table would have duplicated the delivery pipe to change one render branch.
 *
 * The consequence worth knowing: the review-selection filters — minimum rating,
 * count, "only reviews with text" — have no effect on a badge, because the
 * aggregate deliberately ignores them. The builder hides them rather than
 * showing controls that do nothing.
 */
export const WIDGET_LAYOUTS = ["grid", "list", "carousel", "badge"] as const;
export type WidgetLayout = (typeof WIDGET_LAYOUTS)[number];

/** Does this layout draw the aggregate rather than the reviews? */
export function isBadgeLayout(layout: WidgetLayout): boolean {
  return layout === "badge";
}

/**
 * The message an embedded widget posts to whatever is framing it, carrying the
 * size it wants to be.
 *
 * It lives here, in the db-free module, rather than beside the script that
 * sends it. Three things need the same string — the frame document, the embed
 * loader, and the builder's preview — and one of those is a `"use client"`
 * component, which `CLAUDE.md` forbids from importing a runtime value out of
 * any module that can reach the database.
 *
 * **The string still says "height", and must.** The message grew a `width` when
 * the rating badge landed, but a customer's browser can be holding a cached
 * copy of `/embed/widget.js` older than the frame it is listening to. Renaming
 * the value would make those two stop speaking to each other and every widget
 * on that page would freeze at its first-guess height. Adding a field is
 * backwards compatible in both directions: an old loader ignores `width`, and a
 * new loader given no width leaves the frame full-bleed, which is what every
 * layout but the badge wants anyway.
 */
export const SIZE_MESSAGE_TYPE = "revira-widget-height";

/**
 * A widget theme is **not** the app's dark mode.
 *
 * `CLAUDE.md` is unambiguous that the product has one theme and no `dark:`
 * variant, and that stands — nothing here adds one. But a widget renders inside
 * a *stranger's* page, and a customer with a dark site pasting a hard-white
 * card into it gets something visibly broken. So the embed carries its own
 * self-contained stylesheet with two palettes, chosen per widget, in
 * `src/widgets/theme.ts`. It never touches a Tailwind class or a token in
 * `globals.css`, because it cannot: none of ours are loaded on that page.
 */
export const WIDGET_THEMES = ["light", "dark"] as const;
export type WidgetTheme = (typeof WIDGET_THEMES)[number];

/**
 * A customer's brand colour is data, not design — the "never type a hex code"
 * rule is about *our* surfaces, and this value is typed by the business, about
 * their own site. Bounded to a hex triplet so it cannot become a CSS injection
 * vector when it reaches the embed's stylesheet.
 */
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Expected a #rrggbb colour.");

export const widgetStyleSchema = z.object({
  layout: z.enum(WIDGET_LAYOUTS).default("grid"),
  theme: z.enum(WIDGET_THEMES).default("light"),
  /** Null follows the location's locale, then the organization's. */
  locale: z.enum(LOCALES).nullable().default(null),
  /** Null uses Fairfame indigo. */
  accent: hexColor.nullable().default(null),
  showAuthor: z.boolean().default(true),
  showSource: z.boolean().default(true),
  showDate: z.boolean().default(true),
});

export type WidgetStyle = z.infer<typeof widgetStyleSchema>;

// ---------------------------------------------------------------------------
// Reading stored config
// ---------------------------------------------------------------------------

/**
 * Defaults come from the schema itself, so there is no second list to keep in
 * step with the first.
 */
export const DEFAULT_WIDGET_FILTERS: WidgetFilters = widgetFiltersSchema.parse({});
export const DEFAULT_WIDGET_STYLE: WidgetStyle = widgetStyleSchema.parse({});

/**
 * A stored jsonb blob → a usable config, never an exception.
 *
 * Anything unreadable degrades to the defaults. The alternative — throwing —
 * would turn one bad row into a 500 on a customer's homepage, which is a worse
 * outcome than a widget showing its default selection.
 */
export function parseFilters(value: unknown): WidgetFilters {
  const parsed = widgetFiltersSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : DEFAULT_WIDGET_FILTERS;
}

export function parseStyle(value: unknown): WidgetStyle {
  const parsed = widgetStyleSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : DEFAULT_WIDGET_STYLE;
}

// ---------------------------------------------------------------------------
// The config as a query string
// ---------------------------------------------------------------------------

/**
 * The builder's live preview is an iframe, and an iframe is addressed by URL —
 * so the config has to survive a round trip through one.
 *
 * Same reasoning as `src/inbox/filters.ts`: this is the **only** place a widget
 * config becomes a query string and back. The preview route parses what the
 * builder wrote with the same schema the database column is read through, so a
 * preview cannot show something the saved widget would not.
 *
 * Only non-default values are written. A preview URL that spells out every
 * field would change on every unrelated edit and defeat the browser's cache for
 * no benefit, and the short form is legible when something goes wrong.
 */
export type WidgetConfig = { filters: WidgetFilters; style: WidgetStyle };

export function widgetConfigToParams({ filters, style }: WidgetConfig): URLSearchParams {
  const params = new URLSearchParams();
  const put = (key: string, value: string | number | boolean, fallback: unknown) => {
    if (value !== fallback) params.set(key, String(value));
  };

  put("layout", style.layout, DEFAULT_WIDGET_STYLE.layout);
  put("theme", style.theme, DEFAULT_WIDGET_STYLE.theme);
  if (style.locale) params.set("locale", style.locale);
  if (style.accent) params.set("accent", style.accent);
  put("author", style.showAuthor, DEFAULT_WIDGET_STYLE.showAuthor);
  put("src", style.showSource, DEFAULT_WIDGET_STYLE.showSource);
  put("date", style.showDate, DEFAULT_WIDGET_STYLE.showDate);

  put("count", filters.count, DEFAULT_WIDGET_FILTERS.count);
  if (filters.minRating !== null) params.set("min", String(filters.minRating));
  if (filters.sources.length > 0) params.set("sources", filters.sources.join(","));
  if (filters.itemTypes.length > 0) params.set("types", filters.itemTypes.join(","));
  put("text", filters.requireText, DEFAULT_WIDGET_FILTERS.requireText);

  return params;
}

/** A list parameter, tolerant of the empty string and stray whitespace. */
function list(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The inverse — and every field falls back **on its own**.
 *
 * That matters more here than when reading the database. The person looking at
 * this output is mid-edit in the builder, and a single bad parameter resetting
 * the whole preview would leave them guessing which control betrayed them. So
 * each value is checked against what its schema will accept *before* parsing,
 * and an unusable one is simply dropped.
 */
export function widgetConfigFromParams(params: URLSearchParams): WidgetConfig {
  const flag = (key: string, fallback: boolean) => {
    const value = params.get(key);
    return value === null ? fallback : value === "true";
  };

  /** An integer inside `[min, max]`, or undefined. */
  const bounded = (key: string, min: number, max: number) => {
    const value = Number(params.get(key));
    if (!Number.isInteger(value) || value < min || value > max) return undefined;
    return value;
  };

  const oneOf = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const value = params.get(key);
    return allowed.includes(value as T) ? (value as T) : undefined;
  };

  const accent = params.get("accent");

  return {
    filters: parseFilters({
      sources: list(params.get("sources")).slice(0, 20),
      minRating: bounded("min", 1, 5) ?? null,
      itemTypes: list(params.get("types")).filter((type) =>
        (WIDGET_ITEM_TYPES as readonly string[]).includes(type),
      ),
      requireText: flag("text", DEFAULT_WIDGET_FILTERS.requireText),
      count: bounded("count", 1, MAX_WIDGET_REVIEWS) ?? DEFAULT_WIDGET_FILTERS.count,
    }),
    style: parseStyle({
      layout: oneOf("layout", WIDGET_LAYOUTS) ?? DEFAULT_WIDGET_STYLE.layout,
      theme: oneOf("theme", WIDGET_THEMES) ?? DEFAULT_WIDGET_STYLE.theme,
      locale: oneOf("locale", LOCALES) ?? null,
      accent: accent !== null && hexColor.safeParse(accent).success ? accent : null,
      showAuthor: flag("author", DEFAULT_WIDGET_STYLE.showAuthor),
      showSource: flag("src", DEFAULT_WIDGET_STYLE.showSource),
      showDate: flag("date", DEFAULT_WIDGET_STYLE.showDate),
    }),
  };
}
