import { cookies } from "next/headers";
import { schema } from "../db/client.ts";
import { eq } from "drizzle-orm";
import { resolveLocationScope, type LocationScope } from "../auth/scope.ts";
import type { Role } from "../auth/permissions.ts";
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

/**
 * Locations visible to the current tenant, alphabetical.
 *
 * Pass a `scope` (P2-T4) to narrow this to the locations one person may see.
 * It is optional because most callers are already whole-organization work — the
 * digest sweep, the connector scan — and giving them a scope they do not have
 * would mean inventing one. Where a *person* is looking, the caller resolves
 * their scope and passes it, and everything downstream inherits the narrowing
 * for free: the switcher offers fewer branches, and `resolveActiveLocation`
 * refuses a cookie pointing anywhere else.
 */
export async function listLocations(
  tx: TenantDatabase,
  organizationId: string,
  scope?: LocationScope,
): Promise<LocationOption[]> {
  const rows = await tx
    .select({ id: schema.locations.id, name: schema.locations.name })
    .from(schema.locations)
    .where(eq(schema.locations.organizationId, organizationId))
    .orderBy(schema.locations.name);

  if (!scope || scope.all) return rows;
  return rows.filter((row) => scope.locationIds.includes(row.id));
}

/**
 * The locations a *person* may see — scope resolved for them (P2-T8).
 *
 * This is the one every screen should call. `listLocations` above stays for the
 * callers that are not a person at all: the digest sweep, the connector scan,
 * anything running for a whole organization with nobody looking. Making the
 * scoped form the easy one is the point — a new screen that forgets to pass a
 * scope is a new screen that quietly shows a member every branch, and that is
 * not a mistake anybody would notice on a single-location account.
 */
export async function listLocationsForActor(
  tx: TenantDatabase,
  actor: { organizationId: string; userId: string; role: Role },
): Promise<LocationOption[]> {
  const scope = await resolveLocationScope(tx, actor.organizationId, actor.userId, actor.role);
  return listLocations(tx, actor.organizationId, scope);
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
