"use server";

import { revalidatePath } from "next/cache";
import { isLocale } from "@/i18n/config";
import { writeLocaleCookie } from "@/i18n/locale";
import { requireActor } from "@/auth/session";
import { listLocations, writeActiveLocationCookie } from "@/lib/active-location";
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

  // Never trust the id from the client. Only a location this tenant can see is
  // allowed into the cookie.
  const allowed = await withTenant({ organizationId: actor.organizationId }, (tx) =>
    listLocations(tx, actor.organizationId),
  );

  if (!allowed.some((location) => location.id === locationId)) {
    throw new Error("That location is not available to this organization.");
  }

  await writeActiveLocationCookie(locationId);
  revalidatePath("/", "layout");
}
