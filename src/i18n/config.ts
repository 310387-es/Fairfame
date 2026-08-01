/**
 * i18n configuration.
 *
 * Locale is carried in a cookie rather than a URL prefix. The app is an
 * authenticated dashboard, so there are no per-locale pages needing separate
 * indexing, and staying prefix-free keeps every route, redirect and auth
 * callback single-form. Public marketing pages, when they exist, are the case
 * that would justify `/tr` and `/en` path segments.
 */

export const LOCALES = ["tr", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** Türkiye is the launch market. */
export const DEFAULT_LOCALE: Locale = "tr";

export const LOCALE_COOKIE = "revira_locale";

/** One year — a language choice should not quietly expire. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const LOCALE_LABELS: Record<Locale, string> = {
  tr: "Türkçe",
  en: "English",
};

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (LOCALES as readonly string[]).includes(value);
}
