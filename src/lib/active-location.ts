import { cookies } from "next/headers";
import { schema } from "../db/client.ts";
import { eq } from "drizzle-orm";
import type { TenantDatabase } from "./tenancy.ts";

/**
 * The active location — which branch the user is currently looking at.
 *
 * Held in a cookie because it is a view preference, not identity. Crucially,
 * the cookie is never trusted on its own: the id is always re-checked against
 * the locations the tenant context can actually see, so pasting someone else's
 * location id just falls back to your own first location.
 */

export const ACTIVE_LOCATION_COOKIE = "revira_location";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type LocationOption = {
  id: string;
  name: string;
};

export async function readActiveLocationCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACTIVE_LOCATION_COOKIE)?.value ?? null;
}

export async function writeActiveLocationCookie(locationId: string): Promise<void> {
  const store = await cookies();
  store.set(ACTIVE_LOCATION_COOKIE, locationId, {
    maxAge: COOKIE_MAX_AGE,
    sameSite: "lax",
    path: "/",
  });
}

/** Locations visible to the current tenant, alphabetical. */
export async function listLocations(
  tx: TenantDatabase,
  organizationId: string,
): Promise<LocationOption[]> {
  return tx
    .select({ id: schema.locations.id, name: schema.locations.name })
    .from(schema.locations)
    .where(eq(schema.locations.organizationId, organizationId))
    .orderBy(schema.locations.name);
}

/**
 * Resolves the active location against what the tenant can actually see.
 * Returns null when the organization has no locations yet.
 */
export function resolveActiveLocation(
  locations: LocationOption[],
  cookieValue: string | null,
): LocationOption | null {
  if (locations.length === 0) return null;
  const fromCookie = locations.find((location) => location.id === cookieValue);
  return fromCookie ?? locations[0] ?? null;
}
