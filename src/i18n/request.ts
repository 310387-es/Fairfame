import { getRequestConfig } from "next-intl/server";
import { isLocale } from "./config";
import { formats } from "./formats";
import { getLocale } from "./locale";

/**
 * Resolves the locale and loads its messages for every server render.
 * Registered via the next-intl plugin in next.config.ts.
 *
 * An explicitly requested locale wins over the cookie. That matters for the
 * public collection pages: a customer opening a Turkish business's review link
 * must see Turkish, whatever locale cookie their browser happens to carry from
 * a previous visit to the dashboard.
 */
export default getRequestConfig(async ({ locale: requested }) => {
  const locale = isLocale(requested) ? requested : await getLocale();

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
    // Both launch markets use the same time zone today; making it explicit
    // stops server and client from disagreeing on formatted dates.
    timeZone: "Europe/Istanbul",
    /**
     * One "now" per request, shared by the server render and — through
     * NextIntlClientProvider — by every client component that formats a
     * relative time.
     *
     * Without it each side reads its own clock, so "5 minutes ago" can render
     * on the server and hydrate as "6 minutes ago" on the client. next-intl
     * warns about exactly this (ENVIRONMENT_FALLBACK) rather than letting it
     * become an intermittent hydration mismatch.
     */
    now: new Date(),
    // Named formats must be declared, or `format.dateTime(d, "medium")`
    // throws MISSING_FORMAT.
    formats,
  };
});
