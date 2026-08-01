import type { Formats } from "next-intl";

/**
 * Named date, time and number formats shared by the whole app.
 *
 * next-intl does not inherit Intl's named styles: referring to a format that
 * is not declared here throws MISSING_FORMAT at render time. Declaring them in
 * one place also stops each screen from inventing its own date shape.
 *
 * Turkish and English both read these through the active locale, so
 * "1 Ağu 2026" and "Aug 1, 2026" come from the same call site.
 */
export const formats = {
  dateTime: {
    /** Compact — dense lists where the year is obvious from context. */
    short: {
      day: "numeric",
      month: "short",
    },
    /** Default for review timestamps. */
    medium: {
      dateStyle: "medium",
    },
    /** When the time of day matters, e.g. audit entries. */
    long: {
      dateStyle: "long",
      timeStyle: "short",
    },
  },
  number: {
    integer: {
      maximumFractionDigits: 0,
    },
    /** Ratings render as 4.3, never 4.30 or 4. */
    rating: {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    },
  },
} satisfies Formats;

/** The dateTime formats callers may name. Used to keep tests honest. */
export const DATE_TIME_FORMATS = Object.keys(formats.dateTime);
