"use server";

import { revalidatePath } from "next/cache";
import { isLocale } from "@/i18n/config";
import { writeLocaleCookie } from "@/i18n/locale";
import { requireActor } from "@/auth/session";
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
