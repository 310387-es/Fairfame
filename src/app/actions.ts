"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { isLocale } from "@/i18n/config";
import { writeLocaleCookie } from "@/i18n/locale";
import { localeForUser, rememberLocale } from "@/i18n/resolve";
import { getSession, requireActor } from "@/auth/session";
import { listLocationsForActor, writeActiveLocationCookie } from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";

/**
 * Shell-level server actions.
 *
 * Both switchers write a cookie and revalidate, rather than pushing state into
 * the URL — the choice should persist across navigation without decorating
 * every link.
 */

export async function setLocaleAction(locale: string): Promise<void> {
  if (!isLocale(locale)) {
    throw new Error(`Unsupported locale: ${locale}`);
  }

  await writeLocaleCookie(locale);

  /**
   * And against the person, not just the device (W3.3).
   *
   * A cookie is per-browser. Somebody who works in English does so on their
   * phone too, and until now the toggle was forgotten the moment they signed in
   * anywhere else — which is most of why the precedence in
   * `docs/remediation-plan.md` was worth writing down.
   *
   * Tolerant of there being no session: the toggle is in the shell, and the
   * shell renders before an organization exists during onboarding. A signed-out
   * visitor still gets the cookie, which is the whole preference they have.
   */
  const session = await getSession();
  if (session) await rememberLocale(session.user.id, locale);

  revalidatePath("/", "layout");
}

/**
 * Adopts the signed-in person's language, straight after sign-in (W3.3).
 *
 * The precedence in `docs/remediation-plan.md` — user → organization → browser
 * → tr — needs a moment where a `userId` exists *and* a cookie can be written,
 * and this is it. `getLocale()` deliberately stays a cookie read, so this is
 * where the cookie learns what the profile says.
 *
 * **The stored preference wins over the cookie**, and that is the interesting
 * call. Somebody who set English on their laptop and signs in on a borrowed
 * phone should get English: `users.locale` is the choice they made
 * deliberately, and the cookie on a device they have never used is whatever a
 * default put there. Where nothing is stored, the organization's language and
 * then the browser's decide — and if neither says anything, the existing cookie
 * is left alone rather than reset to Turkish.
 *
 * Called from the sign-in form rather than from BetterAuth's hooks: the hook
 * runs inside the auth handler, which has its own response and cannot set a
 * cookie on the navigation that follows.
 */
export async function adoptLocaleAction(): Promise<void> {
  const session = await getSession();
  if (!session) return;

  const incoming = await headers();

  const resolved = await localeForUser(
    session.user.id,
    incoming.get("accept-language"),
    // Whatever the deployment's edge knows about where they are (A22-C3).
    // Absent everywhere that does not add one, which is the local and
    // self-hosted case, and there the behaviour is exactly what it was.
    countryHeader(incoming),
  );
  if (!resolved) return;

  await writeLocaleCookie(resolved);
  revalidatePath("/", "layout");
}

export async function setActiveLocationAction(locationId: string): Promise<void> {
  const actor = await requireActor();

  // Never trust the id from the client. Only a location **this person** may
  // see is allowed into the cookie — the organization check alone let a member
  // scoped to one branch switch the whole app to another (P2-T8).
  const allowed = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    (tx) => listLocationsForActor(tx, actor),
  );

  if (!allowed.some((location) => location.id === locationId)) {
    throw new Error("That location is not available to you.");
  }

  await writeActiveLocationCookie(locationId);
  revalidatePath("/", "layout");
}

/**
 * The country an edge proxy claims the request came from.
 *
 * Two de-facto standards and nothing clever. This is a **hint** that seeds a
 * first paint — the toggle beside it overrides it in one click — so a missing
 * or unknown value is an ordinary answer rather than a problem to solve.
 */
function countryHeader(incoming: Awaited<ReturnType<typeof headers>>): string | null {
  return incoming.get("x-vercel-ip-country") ?? incoming.get("cf-ipcountry");
}
