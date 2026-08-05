import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";
import { randomCode } from "../lib/codes.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { preferredSlug, uniqueSlug } from "./slug.ts";

/**
 * The **authenticated** side of hosted review pages: what `/locations` writes.
 *
 * Split from `src/seo/page.ts` for the same reason widgets are split — that one
 * answers strangers and resolves a tenant from a slug, this one is handed a
 * tenant transaction that already carries the caller's organization. Neither
 * file can be reached by autocomplete from the other's call sites.
 */

export type PublicPageState = {
  slug: string | null;
  published: boolean;
};

/**
 * Turn a location's page on, or off.
 *
 * The slug is minted on the first publish and then left alone forever. Two
 * consequences worth stating because they are the point:
 *
 *   - **Renaming a location does not move its page.** The URL is a fixed
 *     address a search engine has indexed and a customer may have linked to;
 *     regenerating it on every rename would silently throw that away, and the
 *     business would have no way to know.
 *   - **Unpublishing keeps the address.** It sets a boolean, so putting the
 *     page back up restores the same URL rather than minting a second one and
 *     stranding the first.
 */
export async function setPublicPage(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  published: boolean,
): Promise<PublicPageState | null> {
  const [location] = await tx
    .select({
      id: schema.locations.id,
      name: schema.locations.name,
      slug: schema.locations.publicSlug,
      organizationName: schema.organizations.name,
    })
    .from(schema.locations)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.locations.organizationId))
    .where(
      and(eq(schema.locations.id, locationId), eq(schema.locations.organizationId, organizationId)),
    )
    .limit(1);

  // RLS already hides another tenant's location, so this is "no such location
  // here" rather than a permission answer that would confirm one exists.
  if (!location) return null;

  const slug =
    location.slug ??
    (await uniqueSlug(preferredSlug(location.organizationName, location.name), slugTaken, () =>
      randomCode(8),
    ));

  const [updated] = await tx
    .update(schema.locations)
    .set({ publicSlug: slug, publicPagePublished: published, updatedAt: new Date() })
    .where(eq(schema.locations.id, locationId))
    .returning({
      slug: schema.locations.publicSlug,
      published: schema.locations.publicPagePublished,
    });

  return updated ?? null;
}

/**
 * Is this slug already spoken for — **anywhere**?
 *
 * The owner connection, deliberately, and the only place in this module that
 * uses it. A slug is globally unique because it is a URL, so "is it free" is a
 * question about every tenant's rows and cannot be answered under RLS: a
 * tenant-scoped check would say yes, then the unique index would say no, and
 * the business would get a constraint error instead of `-2` on the end of their
 * slug. Nothing about another organization is read or returned — the answer is
 * one boolean about a string the caller already holds.
 */
async function slugTaken(candidate: string): Promise<boolean> {
  const [row] = await getAdminDb()
    .select({ one: sql<number>`1` })
    .from(schema.locations)
    .where(eq(schema.locations.publicSlug, candidate))
    .limit(1);

  return row !== undefined;
}

/** Every location in this organization that has a page, published or not. */
export async function listPublicPages(
  tx: TenantDatabase,
  organizationId: string,
): Promise<Map<string, PublicPageState>> {
  const rows = await tx
    .select({
      locationId: schema.locations.id,
      slug: schema.locations.publicSlug,
      published: schema.locations.publicPagePublished,
    })
    .from(schema.locations)
    .where(
      and(
        eq(schema.locations.organizationId, organizationId),
        isNotNull(schema.locations.publicSlug),
      ),
    );

  return new Map(rows.map((row) => [row.locationId, { slug: row.slug, published: row.published }]));
}
