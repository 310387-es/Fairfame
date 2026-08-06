import { eq } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./config.ts";

/**
 * Which language somebody gets, and in what order (W3.3).
 *
 * `docs/remediation-plan.md` folds this into metric integrity as **user pref →
 * org locale → browser → tr**, and until now only the cookie existed: a Turkish
 * business whose owner had set English got Turkish on every new device, and an
 * account created through an English browser got Turkish because that is what
 * the constant says.
 *
 * ## The cookie is the transport, not the preference
 *
 * `getLocale()` reads a cookie and must keep doing so. It is called on public
 * pages with no session, in a layout that cannot write cookies, and on every
 * render — a database read there would put a query on the widget endpoint. So
 * the cookie stays the fast path and this module decides **what to seed it
 * with** when it is absent, at the two moments a cookie can actually be
 * written: signing in, and pressing the toggle.
 *
 * ## Why `users.locale` and not just the cookie
 *
 * A cookie is per-device. The preference is per-person: somebody who works in
 * English does so on their phone as well, and the sign-in that gives us a
 * `userId` is exactly the moment we can put that right.
 *
 * Read with the **admin** connection deliberately. This runs at sign-in, before
 * an active organization exists, so there is no tenant context to open — and
 * the query is keyed by the authenticated user's own id, which is the one
 * lookup that cannot be somebody else's row.
 */

export type LocaleSources = {
  /** `users.locale`, the durable per-person preference. */
  user?: string | null;
  /** `organizations.locale`, what the business is run in. */
  organization?: string | null;
  /** The raw `Accept-Language` header. */
  header?: string | null;
};

/**
 * The precedence, as a pure function so the order is testable without a
 * database, a request or a session.
 */
export function resolveLocale(sources: LocaleSources): Locale {
  if (isLocale(sources.user)) return sources.user;
  if (isLocale(sources.organization)) return sources.organization;

  const fromHeader = parseAcceptLanguage(sources.header);
  if (fromHeader) return fromHeader;

  return DEFAULT_LOCALE;
}

/**
 * The first supported language in an `Accept-Language` header.
 *
 * Deliberately not a full RFC 4647 implementation. The header is a *hint* from
 * a browser the user may never have configured, it sits third in the
 * precedence, and the two languages this product speaks are distinguishable by
 * their primary subtag alone. `tr-TR` and `tr` are the same answer; a q-value
 * ordering that disagrees with document order is not worth the parser.
 */
export function parseAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;

  for (const part of header.split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase();
    if (!tag) continue;

    const primary = tag.split("-")[0];
    if (isLocale(primary)) return primary;
  }

  return null;
}

/**
 * The locale to seed a freshly signed-in session with.
 *
 * Returns null when nothing is stored and the header says nothing, so a caller
 * can leave an existing cookie alone rather than overwriting a deliberate
 * choice with a default.
 */
export async function localeForUser(
  userId: string,
  header: string | null | undefined,
): Promise<Locale | null> {
  const db = getAdminDb();

  const [user] = await db
    .select({ locale: schema.users.locale, organizationId: schema.users.lastActiveOrganizationId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!user) return parseAcceptLanguage(header);
  if (isLocale(user.locale)) return user.locale;

  const organizationLocale = user.organizationId
    ? await db
        .select({ locale: schema.organizations.locale })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, user.organizationId))
        .limit(1)
        .then(([row]) => row?.locale ?? null)
    : null;

  if (isLocale(organizationLocale)) return organizationLocale;

  return parseAcceptLanguage(header);
}

/** Stores the choice against the person, so it follows them to another device. */
export async function rememberLocale(userId: string, locale: Locale): Promise<void> {
  await getAdminDb()
    .update(schema.users)
    .set({ locale, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
}
