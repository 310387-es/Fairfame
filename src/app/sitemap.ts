import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { MetadataRoute } from "next";
import { getAdminDb, schema } from "@/db/client";
import { publicBaseUrl } from "@/lib/urls";
import { locationPageUrl } from "@/seo/urls";

/**
 * `sitemap.xml` — every published review page, so they can be found (P3-T3).
 *
 * **This is a deliberately cross-tenant read, and the only one in the app.**
 * `CLAUDE.md` says never write a query that is not tenant-scoped, so the
 * exception needs to earn itself:
 *
 *   - A sitemap is, by definition, a list of every public URL on a domain.
 *     There is no tenant in scope — nobody is signed in, and the file is one
 *     document for the whole site. Scoping it is not merely hard, it is
 *     incoherent.
 *   - It selects **two columns**: a slug that is already in the URL of a page
 *     anyone can load, and the time that page last changed. No organization
 *     id, no name, no review, no count. Nothing here is a fact a visitor could
 *     not get by loading the page it points at.
 *   - It reads only rows the business explicitly published. An unpublished
 *     page is absent, so this cannot be used to discover a page that is not
 *     live yet.
 *
 * The projection is an allow-list for the same reason the public widget read's
 * is: a column added to `locations` later — a phone number, an internal note —
 * must not reach a public document because somebody wrote `select()`.
 */

/**
 * Rendered per request, not prerendered.
 *
 * The default would make this a static file built once — which quietly moves a
 * database query into `pnpm build`, so a build with no database reachable fails
 * instead of a single route erroring, and a page published after the build
 * waits for a revalidation before it can be discovered. A crawler fetches this
 * document rarely and the query behind it is one partial-index lookup, so there
 * is nothing to save by baking it in.
 */
export const dynamic = "force-dynamic";

/**
 * A cap, and a visible one.
 *
 * Sitemaps are limited to 50,000 URLs by the protocol, and a single business
 * cannot approach that. If the product ever does, this needs a sitemap index
 * rather than a bigger number — the silent-truncation failure is a page that
 * quietly stops being discoverable with nothing to show for it.
 */
const MAX_SITEMAP_URLS = 10_000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = publicBaseUrl();

  const rows = await getAdminDb()
    .select({
      slug: schema.locations.publicSlug,
      updatedAt: schema.locations.updatedAt,
    })
    .from(schema.locations)
    .where(
      and(eq(schema.locations.publicPagePublished, true), isNotNull(schema.locations.publicSlug)),
    )
    .orderBy(desc(schema.locations.updatedAt))
    .limit(MAX_SITEMAP_URLS);

  return [
    {
      url: base,
      changeFrequency: "monthly",
      priority: 1,
    },
    ...rows.flatMap((row) =>
      row.slug
        ? [
            {
              url: locationPageUrl(base, row.slug),
              lastModified: row.updatedAt,
              // Weekly, because that is roughly how often a business approves
              // something new. Claiming "daily" for a page that changes monthly
              // is the kind of hint crawlers learn to ignore.
              changeFrequency: "weekly" as const,
              priority: 0.7,
            },
          ]
        : [],
    ),
  ];
}
