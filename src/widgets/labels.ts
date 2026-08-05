import { getTranslations } from "next-intl/server";
import type { Locale } from "../i18n/config.ts";
import type { WidgetLabels } from "./markup.ts";

/**
 * The widget's copy, in the widget's language.
 *
 * Explicitly *not* the visitor's language. A Turkish café's testimonial wall
 * reads Turkish to everyone who loads that café's page, exactly as the hosted
 * collection page does — the alternative is a widget whose language depends on
 * a cookie the visitor set on our dashboard, which nobody visiting the café's
 * site has ever seen.
 *
 * Kept apart from `markup.ts` so the renderer stays a pure function of data and
 * strings, with no framework in it.
 */
export async function widgetLabels(locale: Locale): Promise<WidgetLabels> {
  const t = await getTranslations({ locale, namespace: "widget" });

  return {
    ratingLabels: [1, 2, 3, 4, 5].map((rating) => t("starLabel", { rating })),
    empty: t("empty"),
    // A function rather than a formatted string, because the count is not known
    // until the aggregate is read — and because English pluralises where Turkish
    // does not. `next-intl` owns that rule; a `replace()` here would bypass it.
    badgeCount: (count: number) => t("badgeCount", { count }),
    badgeNoRatings: t("badgeNoRatings"),
    badgeLink: t("badgeLink"),
    viewOriginal: t("viewOriginal"),
    poweredBy: t("poweredBy"),
  };
}
