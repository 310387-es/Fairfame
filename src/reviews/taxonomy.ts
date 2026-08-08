/**
 * The canonical theme taxonomy, and the verticals it varies by (W3.2).
 *
 * **The problem this fixes.** `analyze_review` asked the model for topic tags
 * "in the review's own language", so the same complaint arrived as
 * `bekleme süresi` from a Turkish customer and `waiting time` from an English
 * one. Those are one theme, and the product treated them as two: the Inbox
 * offered both as filters, Insights charted them as separate lines, the digest
 * clustered them apart, and benchmarking could never compare a café in Kadıköy
 * with one in Berlin. A free-text label cannot be trended, translated or
 * counted across a corpus — it can only be matched against itself.
 *
 * So there are **two fields, not one**, and they do different jobs:
 *
 *   - **A canonical theme** — a key from the closed list below. This is what
 *     gets charted, filtered, compared and translated. Closed on purpose: an
 *     open vocabulary is the thing being replaced, and a list that grows
 *     whenever a model feels creative is a list nothing can be trended against.
 *   - **Free-text tags** (`review_insights.topics`, unchanged) — the long tail,
 *     in the customer's own words. `mercimek çorbası` is not a theme, it is
 *     evidence, and losing it would lose the specificity that makes the digest
 *     worth reading.
 *
 * **Keys are stable identifiers, never display text.** Every label a person
 * sees comes from `themes.*` in the message catalogue, which is what makes a
 * Turkish review's theme readable to an English-speaking manager — the thing
 * free text could not do at any price.
 */

/**
 * What kind of business a location is (`locations.category`).
 *
 * It was free text, which meant it could not drive anything. It drives two
 * things now: which themes the model is offered, and — later — which peers a
 * benchmark compares against.
 *
 * `other` is deliberate and not a failure state. A closed list that has no
 * room for "everything else" gets one business filed under the wrong vertical
 * and then trended against the wrong peers.
 */
export const VERTICALS = [
  "restaurant",
  "cafe",
  "hotel",
  "retail",
  "clinic",
  "services",
  "other",
] as const;

export type Vertical = (typeof VERTICALS)[number];

export function isVertical(value: string | null | undefined): value is Vertical {
  return VERTICALS.includes((value ?? "") as Vertical);
}

/**
 * Every canonical theme, and where it applies.
 *
 * `null` means universal — a customer can wait too long, be overcharged or meet
 * rude staff anywhere. The rest are named per vertical because offering a
 * restaurant "room comfort" invites the model to use it, and a theme used where
 * it does not belong is worse than one that is missing: it is a chart line
 * nobody can act on.
 */
export const CANONICAL_THEMES = {
  staff: null,
  service: null,
  wait_time: null,
  price: null,
  cleanliness: null,
  ambience: null,
  location_access: null,
  booking: null,

  food_quality: ["restaurant", "cafe", "hotel"],
  menu_variety: ["restaurant", "cafe"],
  portion_size: ["restaurant", "cafe"],

  room_comfort: ["hotel"],

  product_quality: ["retail"],
  stock_availability: ["retail"],

  treatment_outcome: ["clinic"],
} as const satisfies Record<string, readonly Vertical[] | null>;

export type CanonicalTheme = keyof typeof CANONICAL_THEMES;

export const THEME_KEYS = Object.keys(CANONICAL_THEMES) as CanonicalTheme[];

export function isCanonicalTheme(value: string): value is CanonicalTheme {
  return Object.hasOwn(CANONICAL_THEMES, value);
}

/**
 * The themes offered for a vertical — universal ones plus its own.
 *
 * An unknown or missing category falls back to the universal set rather than to
 * everything. Offering a business every theme in the product would put "room
 * comfort" in front of a barber, and the model would eventually use it.
 */
export function themesForVertical(category: string | null | undefined): CanonicalTheme[] {
  const vertical = isVertical(category) ? category : null;

  return THEME_KEYS.filter((key) => {
    const applies = CANONICAL_THEMES[key];
    if (applies === null) return true;
    return vertical !== null && (applies as readonly string[]).includes(vertical);
  });
}

/**
 * Keeps only the canonical themes a model actually returned.
 *
 * Anything outside the list is **dropped rather than kept as a tag**: the model
 * was given a closed set and told to choose from it, so an unlisted value is a
 * failure to follow instructions rather than a discovery. The free-text tags
 * are a separate field and already carry the long tail — quietly promoting an
 * invented key into the canonical column is how a closed vocabulary stops being
 * closed.
 */
export function normalizeThemes(values: unknown): CanonicalTheme[] {
  if (!Array.isArray(values)) return [];

  const seen = new Set<CanonicalTheme>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const key = value
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    if (isCanonicalTheme(key)) seen.add(key);
  }

  return [...seen];
}

/**
 * What to show a reader for a theme key.
 *
 * Canonical keys become a translated word; anything else is shown as the
 * customer wrote it. Both halves matter: a canonical key must never reach a
 * screen untranslated (that is the whole reason W3.2 exists), and a free tag
 * must never be dropped, because `review_insights.themes` landed with no
 * backfill and most rows still carry only the tail.
 *
 * A function here rather than three copies of the same ternary — which is what
 * it was, in `filter-bar.tsx`, `analytics/page.tsx` and the reviews page, each
 * with its own cast. Two of the three had it right and the third rendered raw
 * keys, which is exactly how this kind of duplication fails: not all at once.
 */
export function themeLabel(key: string, translate: (canonical: CanonicalTheme) => string): string {
  return isCanonicalTheme(key) ? translate(key) : key;
}

/**
 * The theme names, for surfaces that cannot reach the message catalogue.
 *
 * `src/i18n/messages/*.json` is the source of truth and every screen reads it
 * through `next-intl`. The **weekly email cannot**: it is rendered in the
 * background worker, from plain `COPY[locale]` records, deliberately — a
 * template that needed a request context could not be sent by a cron.
 *
 * So the email carries a copy, exactly as it carries a copy of the palette for
 * the same class of reason (`tests/lib/email-palette.test.ts`). And exactly as
 * there, a copy is only safe if something fails when it drifts:
 * `tests/lib/digest-themes.test.ts` asserts these are the catalogue's own
 * words, key for key, in both languages.
 *
 * Nothing in the app should reach for this. Use `themeLabel(key, tThemes)`.
 */
export const THEME_NAMES: Record<CanonicalTheme, { en: string; tr: string }> = {
  staff: { en: "Staff", tr: "Personel" },
  service: { en: "Service", tr: "Servis" },
  wait_time: { en: "Waiting time", tr: "Bekleme süresi" },
  price: { en: "Price", tr: "Fiyat" },
  cleanliness: { en: "Cleanliness", tr: "Temizlik" },
  ambience: { en: "Atmosphere", tr: "Ortam" },
  location_access: { en: "Getting there", tr: "Ulaşım" },
  booking: { en: "Booking", tr: "Rezervasyon" },
  food_quality: { en: "Food", tr: "Yemek" },
  menu_variety: { en: "Menu", tr: "Menü" },
  portion_size: { en: "Portions", tr: "Porsiyon" },
  room_comfort: { en: "Room", tr: "Oda" },
  product_quality: { en: "Products", tr: "Ürünler" },
  stock_availability: { en: "Stock", tr: "Stok" },
  treatment_outcome: { en: "Treatment", tr: "Tedavi" },
};
