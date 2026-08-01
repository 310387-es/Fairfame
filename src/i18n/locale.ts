import { cookies } from "next/headers";
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  type Locale,
} from "./config";

/**
 * Reading and writing the active locale.
 *
 * Kept in a cookie so the choice survives navigation and reloads without a URL
 * prefix. A user's stored `users.locale` is not consulted yet — layouts cannot
 * write cookies in Next.js, so seeding it from the profile needs a server
 * action at sign-in. Noted rather than half-built.
 */

export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export async function writeLocaleCookie(locale: Locale): Promise<void> {
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
    path: "/",
  });
}
