import { getRequestConfig } from "next-intl/server";
import { getLocale } from "./locale";

/**
 * Resolves the locale and loads its messages for every server render.
 * Registered via the next-intl plugin in next.config.ts.
 */
export default getRequestConfig(async () => {
  const locale = await getLocale();

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
    // Both launch markets use the same time zone today; making it explicit
    // stops server and client from disagreeing on formatted dates.
    timeZone: "Europe/Istanbul",
  };
});
