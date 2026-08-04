import { and, eq, inArray } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { roleAtLeast, type Role } from "./permissions.ts";

/**
 * Which locations a person may see (P2-T4).
 *
 * `docs/06` §3 scopes every role to locations — "Member: assigned locations",
 * "Client: their locations only" — and this is the one place that rule is
 * decided. Everything else asks; nothing else interprets `member_locations`.
 *
 * This is *authorization*, not tenancy. RLS already guarantees that a query
 * cannot cross an organization boundary, and it deliberately does not know about
 * location scope: a policy that filtered by the current user would stop an admin
 * from managing anyone's scope but their own. So the boundary Postgres enforces
 * is the tenant, and the boundary this module enforces is the location — two
 * different questions, kept apart on purpose.
 */

/**
 * `all` is not the same as "every location listed".
 *
 * An unrestricted person stays unrestricted when a new branch opens; someone
 * scoped to the three locations that happen to exist today does not. Collapsing
 * the two would silently widen a scope every time the organization grows.
 */
export type LocationScope = { all: true } | { all: false; locationIds: string[] };

export const UNRESTRICTED: LocationScope = { all: true };

/**
 * Reads the scope for one membership.
 *
 * The default is generous for every role but `client`, and the asymmetry is
 * deliberate. There is no screen yet for assigning locations to a teammate, so
 * reading "no rows" as "no locations" would lock every existing member out of
 * everything the moment this shipped, with no way to let them back in. A
 * `client` is the one role held by somebody outside the business, where the
 * generous default is a leak rather than an inconvenience — so for them, no rows
 * means no locations.
 *
 * `owner` is never scoped at all: the person who can delete the organization
 * cannot meaningfully be kept out of part of it, and pretending otherwise would
 * be security theatre with a support ticket attached.
 */
export async function resolveLocationScope(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
  role: Role,
): Promise<LocationScope> {
  if (role === "owner") return UNRESTRICTED;

  const rows = await tx
    .select({ locationId: schema.memberLocations.locationId })
    .from(schema.memberLocations)
    .innerJoin(schema.memberships, eq(schema.memberships.id, schema.memberLocations.membershipId))
    .where(
      and(
        eq(schema.memberLocations.organizationId, organizationId),
        eq(schema.memberships.userId, userId),
      ),
    );

  if (rows.length > 0) {
    return { all: false, locationIds: rows.map((row) => row.locationId) };
  }

  return role === "client" ? { all: false, locationIds: [] } : UNRESTRICTED;
}

/** Is this location inside the scope? */
export function withinScope(scope: LocationScope, locationId: string): boolean {
  return scope.all || scope.locationIds.includes(locationId);
}

/**
 * The scope of another member, by user id — used to answer "may this person be
 * given this review?" without trusting the browser's list of assignees.
 */
export async function resolveScopeForUser(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
): Promise<LocationScope | null> {
  const [membership] = await tx
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, organizationId),
        eq(schema.memberships.userId, userId),
      ),
    )
    .limit(1);

  // Not a member of this organization at all. Null rather than an empty scope,
  // because "may see nothing here" and "does not belong here" are different
  // answers and the caller should be able to say which happened.
  if (!membership) return null;

  return resolveLocationScope(tx, organizationId, userId, membership.role);
}

export type TeamMember = {
  userId: string;
  name: string;
  email: string;
  role: Role;
};

/**
 * Who may be given work at this location.
 *
 * Filtered by scope rather than listing the whole team, because an assignee
 * picker offering people who cannot open the item is a picker that produces
 * broken assignments. `client` is excluded outright: an agency's customer is not
 * a person the agency assigns work to.
 *
 * One query. The scope filter cannot be pushed into SQL cleanly — "no rows means
 * unrestricted" is a per-row condition about the *absence* of rows — so the team
 * is read and then narrowed in memory. A team is tens of people, not thousands.
 */
export async function assignableMembers(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
): Promise<TeamMember[]> {
  const rows = await tx
    .select({
      userId: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      role: schema.memberships.role,
      membershipId: schema.memberships.id,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.organizationId, organizationId))
    .orderBy(schema.users.name);

  const candidates = rows.filter((row) => row.role !== "client");
  if (candidates.length === 0) return [];

  const scoped = await tx
    .select({
      membershipId: schema.memberLocations.membershipId,
      locationId: schema.memberLocations.locationId,
    })
    .from(schema.memberLocations)
    .where(
      and(
        eq(schema.memberLocations.organizationId, organizationId),
        inArray(
          schema.memberLocations.membershipId,
          candidates.map((row) => row.membershipId),
        ),
      ),
    );

  const restricted = new Map<string, Set<string>>();
  for (const row of scoped) {
    const set = restricted.get(row.membershipId) ?? new Set<string>();
    set.add(row.locationId);
    restricted.set(row.membershipId, set);
  }

  return candidates
    .filter((row) => {
      if (row.role === "owner") return true;
      const scope = restricted.get(row.membershipId);
      return scope === undefined || scope.has(locationId);
    })
    .map((row) => ({
      userId: row.userId,
      name: row.name,
      email: row.email,
      role: row.role,
    }));
}

export type TeamMemberScope = {
  userId: string;
  membershipId: string;
  name: string;
  email: string;
  role: Role;
  /** Empty means unrestricted — see `resolveLocationScope` for the asymmetry. */
  locationIds: string[];
};

/** The team, each with the locations they have been pinned to. */
export async function listTeamWithScope(
  tx: TenantDatabase,
  organizationId: string,
): Promise<TeamMemberScope[]> {
  const members = await tx
    .select({
      userId: schema.users.id,
      membershipId: schema.memberships.id,
      name: schema.users.name,
      email: schema.users.email,
      role: schema.memberships.role,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.organizationId, organizationId))
    .orderBy(schema.users.name);

  if (members.length === 0) return [];

  const scoped = await tx
    .select({
      membershipId: schema.memberLocations.membershipId,
      locationId: schema.memberLocations.locationId,
    })
    .from(schema.memberLocations)
    .where(eq(schema.memberLocations.organizationId, organizationId));

  const byMembership = new Map<string, string[]>();
  for (const row of scoped) {
    byMembership.set(row.membershipId, [
      ...(byMembership.get(row.membershipId) ?? []),
      row.locationId,
    ]);
  }

  return members.map((member) => ({
    ...member,
    locationIds: byMembership.get(member.membershipId) ?? [],
  }));
}

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

/**
 * Pins a member to a set of locations, or lifts the restriction entirely.
 *
 * An **empty list means unrestricted**, which is the same thing the absence of
 * rows has always meant (see `resolveLocationScope`). The UI never sends an
 * empty list to mean "nothing": it offers "all locations" and "only these", and
 * refuses to save the second with nothing ticked. Encoding "sees nothing" as an
 * empty set would make the two indistinguishable in the database.
 *
 * Rewritten wholesale rather than diffed. The set is small, the write is one
 * delete plus one insert inside the caller's transaction, and a diff would be
 * three code paths to express something that is already atomic.
 */
export async function setMemberLocations(
  tx: TenantDatabase,
  actor: { organizationId: string; role: Role },
  input: { userId: string; locationIds: string[] },
): Promise<void> {
  if (!roleAtLeast(actor.role, "admin")) {
    throw new ScopeError("Only an admin can change who sees which locations.");
  }

  const [membership] = await tx
    .select({ id: schema.memberships.id, role: schema.memberships.role })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, actor.organizationId),
        eq(schema.memberships.userId, input.userId),
      ),
    )
    .limit(1);

  if (!membership) throw new ScopeError("That person is not on this team.");

  // The person who can delete the organization cannot meaningfully be kept out
  // of part of it; pretending otherwise would be theatre with a support ticket.
  if (membership.role === "owner" && input.locationIds.length > 0) {
    throw new ScopeError("An owner always sees every location.");
  }

  const wanted = [...new Set(input.locationIds)];

  if (wanted.length > 0) {
    // Never trust the ids from the client. RLS would refuse a foreign location
    // on insert anyway, but failing here names the actual problem.
    const known = await tx
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(
        and(
          eq(schema.locations.organizationId, actor.organizationId),
          inArray(schema.locations.id, wanted),
        ),
      );

    if (known.length !== wanted.length) {
      throw new ScopeError("That location does not belong to this organization.");
    }
  }

  await tx
    .delete(schema.memberLocations)
    .where(
      and(
        eq(schema.memberLocations.organizationId, actor.organizationId),
        eq(schema.memberLocations.membershipId, membership.id),
      ),
    );

  if (wanted.length === 0) return;

  await tx.insert(schema.memberLocations).values(
    wanted.map((locationId) => ({
      organizationId: actor.organizationId,
      membershipId: membership.id,
      locationId,
    })),
  );
}
