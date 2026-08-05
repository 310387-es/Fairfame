import { and, avg, count, eq, gte, inArray, sql } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import type { Role } from "../auth/permissions.ts";

/**
 * The agency console's roster (P4-T5).
 *
 * **The security rule, stated once and enforced in one query.** A client
 * appears here only when *both* of these hold:
 *
 *   1. `agency_clients` links it to this agency — the relationship, which
 *      grants nothing on its own;
 *   2. the person asking is a **member of that client organization** — which is
 *      what grants everything, and has since Phase 0.
 *
 * Neither is sufficient. The link cannot widen access, because RLS keys on
 * `app.current_org()` and nothing here changes it; membership cannot put a
 * stranger's organization on an agency's console, because the link is what puts
 * it in the list. An agency that loses a client's membership stops seeing them
 * immediately, which is the correct behaviour when a customer leaves.
 *
 * **Each client's figures are read inside that client's own tenant context.**
 * There is no cross-organization join anywhere in this file: `summarise` opens
 * `withTenant` per client, so RLS is doing the work rather than a WHERE clause
 * somebody could get wrong. It is slower than one join over N organizations and
 * that is the trade being made deliberately — an agency has tens of clients,
 * not thousands, and the alternative is the one shape this architecture has
 * refused everywhere else.
 */

const log = childLogger({ module: "agency/clients" });

/** Beyond this the console is a report, not a screen. */
export const MAX_CLIENTS = 100;

export type ClientRow = {
  organizationId: string;
  name: string;
  slug: string;
  /** What the agency calls them, when that differs from their own name. */
  label: string | null;
  /** The asking person's role *in that organization*. */
  role: Role;
  locations: number;
  /** Reviews in the last 30 days. */
  reviews: number;
  /** Average rating over the same window. Null when nobody rated anything. */
  rating: number | null;
  /** Open or in-progress items — what somebody would go in to deal with. */
  openItems: number;
};

const WINDOW_DAYS = 30;

/**
 * Client organizations this person may actually open, with a summary of each.
 *
 * The first query is cross-tenant and deliberately narrow: it joins the link to
 * the caller's own memberships and reads ids, names and a role. Nothing a
 * tenant owns — no review, no contact, no figure — crosses an organization
 * boundary in it.
 */
export async function listClients(
  agencyOrganizationId: string,
  userId: string,
  now = new Date(),
): Promise<ClientRow[]> {
  /**
   * Membership of the **agency itself**, checked first.
   *
   * Found by a test that asserted "shows nothing to somebody outside the
   * agency" and got a roster back. Both other conditions held from the query's
   * point of view — the outsider was a member of a linked client — but nothing
   * said they belonged to the agency asking. The page happens to pass
   * `actor.organizationId`, which `requireActor` guarantees, so it was never
   * reachable in the app; a function whose safety depends on every future
   * caller passing the right argument is the shape this codebase refuses
   * everywhere else.
   */
  const [self] = await getAdminDb()
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, agencyOrganizationId),
        eq(schema.memberships.userId, userId),
      ),
    )
    .limit(1);

  if (!self) return [];

  const links = await getAdminDb()
    .select({
      organizationId: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
      label: schema.agencyClients.label,
      role: schema.memberships.role,
    })
    .from(schema.agencyClients)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.agencyClients.clientOrganizationId),
    )
    // The inner join *is* the access check. A client with no membership for
    // this person simply is not in the result — there is no branch to forget.
    .innerJoin(
      schema.memberships,
      and(
        eq(schema.memberships.organizationId, schema.agencyClients.clientOrganizationId),
        eq(schema.memberships.userId, userId),
      ),
    )
    .where(eq(schema.agencyClients.organizationId, agencyOrganizationId))
    .orderBy(schema.organizations.name)
    .limit(MAX_CLIENTS);

  const rows: ClientRow[] = [];

  for (const link of links) {
    rows.push({ ...link, ...(await summarise(link.organizationId, userId, now)) });
  }

  return rows;
}

/**
 * One client's headline figures, read inside that client's own tenant context.
 *
 * Failures are swallowed to zeroes rather than propagated: one client with a
 * problem must not blank the whole console, and an agency looking at nine
 * healthy customers and one showing dashes has learned something useful.
 */
async function summarise(
  organizationId: string,
  userId: string,
  now: Date,
): Promise<Pick<ClientRow, "locations" | "reviews" | "rating" | "openItems">> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1_000);

  try {
    return await withTenant({ organizationId, userId }, async (tx) => {
      const [locations] = await tx
        .select({ value: count() })
        .from(schema.locations)
        .where(eq(schema.locations.organizationId, organizationId));

      const [recent] = await tx
        .select({
          value: count(),
          rating: avg(schema.reviews.rating),
        })
        .from(schema.reviews)
        .where(
          and(
            eq(schema.reviews.organizationId, organizationId),
            gte(sql`coalesce(${schema.reviews.postedAt}, ${schema.reviews.createdAt})`, since),
          ),
        );

      const [open] = await tx
        .select({ value: count() })
        .from(schema.reviews)
        .where(
          and(
            eq(schema.reviews.organizationId, organizationId),
            inArray(schema.reviews.status, ["open", "in_progress"]),
          ),
        );

      return {
        locations: locations?.value ?? 0,
        reviews: recent?.value ?? 0,
        // Null, never 0: a quiet month did not score nought stars. Same rule as
        // `src/insights/trends.ts`.
        rating:
          recent?.rating === null || recent?.rating === undefined ? null : Number(recent.rating),
        openItems: open?.value ?? 0,
      };
    });
  } catch (error) {
    log.warn({ organizationId, err: error }, "Could not summarise a client organization");
    return { locations: 0, reviews: 0, rating: null, openItems: 0 };
  }
}

export class AgencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgencyError";
  }
}

/**
 * Links a client organization to this agency.
 *
 * **The person doing it must already be a member of that organization.** An
 * agency cannot adopt an organization it has not been given access to, which is
 * what stops the link table becoming a way to name any slug and see inside it.
 * Membership is created the way membership has always been created — by
 * somebody in that organization inviting them — and this only records the
 * relationship afterwards.
 */
export async function linkClient(
  tx: TenantDatabase,
  agencyOrganizationId: string,
  userId: string,
  input: { clientSlug: string; label: string | null },
): Promise<{ clientOrganizationId: string }> {
  const [client] = await getAdminDb()
    .select({ id: schema.organizations.id, role: schema.memberships.role })
    .from(schema.organizations)
    .innerJoin(
      schema.memberships,
      and(
        eq(schema.memberships.organizationId, schema.organizations.id),
        eq(schema.memberships.userId, userId),
      ),
    )
    .where(eq(schema.organizations.slug, input.clientSlug))
    .limit(1);

  // One message for "no such organization" and "you are not a member of it":
  // distinguishing them would let an agency probe for slugs.
  if (!client) {
    throw new AgencyError("No organization you belong to has that address.");
  }

  if (client.id === agencyOrganizationId) {
    throw new AgencyError("An agency cannot be its own client.");
  }

  await tx
    .insert(schema.agencyClients)
    .values({
      organizationId: agencyOrganizationId,
      clientOrganizationId: client.id,
      label: input.label,
    })
    .onConflictDoUpdate({
      target: [schema.agencyClients.organizationId, schema.agencyClients.clientOrganizationId],
      set: { label: input.label, updatedAt: new Date() },
    });

  return { clientOrganizationId: client.id };
}

/**
 * Unlinks a client.
 *
 * Removes the *relationship* only. Membership is untouched, because it was not
 * this table's to grant and is not its to take away — and because an agency
 * tidying its console must not be able to lock somebody out of an organization.
 */
export async function unlinkClient(
  tx: TenantDatabase,
  agencyOrganizationId: string,
  clientOrganizationId: string,
): Promise<boolean> {
  const rows = await tx
    .delete(schema.agencyClients)
    .where(
      and(
        eq(schema.agencyClients.organizationId, agencyOrganizationId),
        eq(schema.agencyClients.clientOrganizationId, clientOrganizationId),
      ),
    )
    .returning({ id: schema.agencyClients.id });

  return rows.length > 0;
}

/**
 * Every organization this person belongs to (P4-T5).
 *
 * **Not tenant data**: it is the caller's own membership list, which is why it
 * reads across organizations with the owner connection and why the projection
 * is three columns with nothing a tenant owns in them.
 *
 * It exists because the agency console was one-way. "Open" switched an agency
 * into a client; nothing switched back, so a person belonging to several
 * organizations could reach a client and then be stuck in it — found while
 * working out how to demonstrate white-label, which needs two organizations to
 * mean anything.
 */
export async function listOrganizationsForUser(
  userId: string,
): Promise<{ id: string; name: string; slug: string }[]> {
  return getAdminDb()
    .select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
    })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.organizationId))
    .where(eq(schema.memberships.userId, userId))
    .orderBy(schema.organizations.name);
}

/** Whether this organization looks after anybody — what shows the console at all. */
export async function isAgency(tx: TenantDatabase, organizationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.agencyClients.id })
    .from(schema.agencyClients)
    .where(eq(schema.agencyClients.organizationId, organizationId))
    .limit(1);

  return row !== undefined;
}

/** Every location across a client roster — the bulk view `docs/20` asks for. */
export async function listClientLocations(
  clients: ClientRow[],
  userId: string,
): Promise<{ clientId: string; clientName: string; id: string; name: string }[]> {
  const rows: { clientId: string; clientName: string; id: string; name: string }[] = [];

  for (const client of clients) {
    try {
      const locations = await withTenant({ organizationId: client.organizationId, userId }, (tx) =>
        tx
          .select({ id: schema.locations.id, name: schema.locations.name })
          .from(schema.locations)
          .where(eq(schema.locations.organizationId, client.organizationId))
          .orderBy(schema.locations.name),
      );

      for (const location of locations) {
        rows.push({
          clientId: client.organizationId,
          clientName: client.label ?? client.name,
          ...location,
        });
      }
    } catch (error) {
      log.warn({ organizationId: client.organizationId, err: error }, "Could not list locations");
    }
  }

  return rows;
}
