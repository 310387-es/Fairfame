import { avg, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n/config.ts";
import { withTenant } from "../lib/tenancy.ts";
import { widgetFiltersSchema, type WidgetItemType } from "../widgets/config.ts";
import type { PublicAggregate, PublicReview } from "../widgets/public.ts";
import { allOf, widgetScopeConditions, widgetSelectionConditions } from "../widgets/scope.ts";

/**
 * The hosted review page's data (P3-T3), read by a stranger with a URL.
 *
 * The same threat model as `src/widgets/public.ts`, and the same four rules —
 * tenant from the slug and never from the caller, RLS after that, an allow-list
 * projection, approved rows only. What is different is that this page is meant
 * to be **indexed**, so a leak here does not merely reach one visitor: it gets
 * crawled, cached and quoted back by a search engine long after it is fixed.
 *
 * Two deliberate reuses, both of which would be bugs if they were copies:
 *
 *   1. **`src/widgets/scope.ts` builds the WHERE clauses.** This is the fourth
 *      reader of that contract, after the widget read, the aggregate and the
 *      builder's approval list. The approval list tells a business "approving a
 *      review shows it on every widget, badge and public page you have" — this
 *      module is the "and public page", and it can only keep that promise by
 *      asking the same question the others ask.
 *   2. **`PublicReview` is the projection.** One shape for everything we
 *      publish means a column added to `reviews` cannot reach the internet by
 *      way of the surface nobody remembered to check.
 */

export type PublicLocationPage = {
  organizationId: string;
  organizationName: string;
  locationId: string;
  locationName: string;
  address: string | null;
  category: string | null;
  slug: string;
  published: boolean;
  /** The location's language, then the organization's. Not the visitor's. */
  locale: Locale;
};

/**
 * How many reviews the page carries.
 *
 * A page, not a feed: everything a location has ever had approved would be a
 * slow document for a visitor and a thin one for a crawler, which reads the
 * first screens and weighs repetition. Newest first, so the page stays current
 * without anyone editing it.
 */
export const PAGE_REVIEW_LIMIT = 30;

/**
 * What the page shows: every approved review in the location's scope, with
 * words in it.
 *
 * Not the filters of any widget — a widget is one editorial choice among
 * several, and this page is the business's whole approved record. The one
 * filter kept is `requireText`, for the reason `docs/15` gives about
 * testimonials and for a second reason that only applies here: a page of
 * star-ratings with no prose is thin content, which is the specific thing a
 * search engine is looking for a reason to ignore.
 */
const PAGE_FILTERS = widgetFiltersSchema.parse({
  requireText: true,
  count: PAGE_REVIEW_LIMIT,
});

export type LocationPageContent = {
  page: PublicLocationPage;
  reviews: PublicReview[];
  aggregate: PublicAggregate;
};

/**
 * The location behind a public slug, or null.
 *
 * Returns unpublished pages too, and the caller decides — the public route
 * refuses them, and the in-app link needs to resolve one before it goes live.
 * The lookup uses the owner connection because it is the one query that cannot
 * be tenant-scoped: the slug is how the tenant is discovered. Same shape, same
 * confinement, as `resolveWidgetByKey`.
 */
export async function resolveLocationPageBySlug(slug: string): Promise<PublicLocationPage | null> {
  // A slug is lowercase letters, digits and hyphens. Anything else never
  // reaches the database — a public route should not spend a connection on
  // `/reviews/<script>alert(1)</script>`.
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) return null;

  const [row] = await getAdminDb()
    .select({
      organizationId: schema.locations.organizationId,
      organizationName: schema.organizations.name,
      locationId: schema.locations.id,
      locationName: schema.locations.name,
      address: schema.locations.address,
      category: schema.locations.category,
      slug: schema.locations.publicSlug,
      published: schema.locations.publicPagePublished,
      locationLocale: schema.locations.locale,
      organizationLocale: schema.organizations.locale,
    })
    .from(schema.locations)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.locations.organizationId))
    .where(eq(schema.locations.publicSlug, slug))
    .limit(1);

  if (!row?.slug) return null;

  const locale = [row.locationLocale, row.organizationLocale].find(
    (candidate): candidate is Locale => isLocale(candidate ?? undefined),
  );

  return {
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    locationId: row.locationId,
    locationName: row.locationName,
    address: row.address,
    category: row.category,
    slug: row.slug,
    published: row.published,
    locale: locale ?? DEFAULT_LOCALE,
  };
}

/**
 * The reviews on the page, and the aggregate above them.
 *
 * One tenant transaction for both, so the list and the count come from the same
 * snapshot rather than a few seconds apart — and so a mistake in either WHERE
 * clause is still caught by RLS.
 */
export async function loadLocationPageContent(
  page: PublicLocationPage,
): Promise<LocationPageContent> {
  const scope = {
    organizationId: page.organizationId,
    locationId: page.locationId,
    // A location's page is about that place, not about where its reviews came
    // from. Every connected source counts.
    sources: [],
  };

  return withTenant({ organizationId: page.organizationId }, async (tx) => {
    const rows = await tx
      .select({
        id: schema.reviews.id,
        rating: schema.reviews.rating,
        text: schema.reviews.text,
        authorName: schema.reviews.authorName,
        source: schema.reviews.source,
        itemType: schema.reviews.itemType,
        postedAt: schema.reviews.postedAt,
        url: schema.reviews.url,
      })
      .from(schema.reviews)
      // `approvedOnly: true`, always. Nothing on this path can change it.
      .where(allOf(widgetSelectionConditions(scope, PAGE_FILTERS, { approvedOnly: true })))
      .orderBy(sql`${schema.reviews.postedAt} desc nulls last`, desc(schema.reviews.id))
      .limit(PAGE_REVIEW_LIMIT);

    // Scope clauses, not selection ones: the score is taken over every rated
    // review at this location, approved or not. Same rule and same wording as
    // the badge — see `PublicAggregate`. It is stated on the page in prose
    // rather than in markup, because `AggregateRating` about oneself is
    // precisely the claim Google's review-snippet policy refuses (docs/19,
    // P3-T3 amendment).
    const [totals] = await tx
      .select({ average: avg(schema.reviews.rating), value: count() })
      .from(schema.reviews)
      .where(allOf([...widgetScopeConditions(scope), isNotNull(schema.reviews.rating)]));

    const average =
      totals?.average === null || totals?.average === undefined ? null : Number(totals.average);

    return {
      page,
      reviews: rows.map((row) => ({
        id: row.id,
        rating: row.rating,
        text: row.text,
        authorName: row.authorName,
        source: row.source,
        itemType: row.itemType as WidgetItemType,
        postedAt: row.postedAt?.toISOString() ?? null,
        url: row.url,
      })),
      aggregate: {
        basis: "all_reviews_in_scope",
        average: average === null || Number.isNaN(average) ? null : Math.round(average * 10) / 10,
        count: totals?.value ?? 0,
      },
    };
  });
}
