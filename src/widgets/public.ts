import { avg, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n/config.ts";
import { withTenant } from "../lib/tenancy.ts";
import { publicBaseUrl } from "../lib/urls.ts";
import { locationPageUrl } from "../seo/urls.ts";
import {
  parseFilters,
  parseStyle,
  type WidgetFilters,
  type WidgetItemType,
  type WidgetStyle,
} from "./config.ts";
import { looksLikeWidgetKey } from "./keys.ts";
import {
  allOf,
  widgetScopeConditions,
  widgetSelectionConditions,
  type WidgetScope,
} from "./scope.ts";

/**
 * The unauthenticated side of the showcase: a stranger's browser holding a key.
 *
 * This is the most exposed code in the product. It answers requests from the
 * open internet, with no session, no cookie and no organization in scope until
 * the key in the URL names one — and it is the module `CLAUDE.md`'s public
 * surface rule points at. The rules it follows, in order:
 *
 *   1. **The tenant comes from the key, never from the caller.** There is no
 *      parameter anywhere in this file that accepts an organization id. The one
 *      lookup that cannot be tenant-scoped — key → organization — uses the
 *      owner connection, exactly as `src/collect/public.ts` does, and is
 *      confined here so there is one place to review it.
 *   2. **Everything after that runs under RLS.** The review read goes through
 *      `withTenant()` with the organization the key resolved to, so a mistake in
 *      a WHERE clause is still caught by the database.
 *   3. **The projection is an allow-list.** `select *` is never used, so a
 *      column added to `reviews` later — a triage note, an internal score —
 *      cannot arrive on the internet by default. `raw_payload` in particular is
 *      the provider's whole response and never leaves the server.
 *   4. **Only approved rows.** `display_approved_at is not null`, always, with
 *      no caller-supplied way to turn it off.
 */

export type PublicWidget = {
  widgetId: string;
  organizationId: string;
  organizationName: string;
  /** Null when the widget spans every location in the organization. */
  locationId: string | null;
  locationName: string | null;
  name: string;
  published: boolean;
  filters: WidgetFilters;
  style: WidgetStyle;
  /** Widget style wins, then the location's language, then the organization's. */
  locale: Locale;
  /**
   * Where the rating badge points, or null (P3-T2, wired in P3-T3).
   *
   * Null in every case but one: the widget names a single location, and that
   * location's hosted review page is **published**. An organization-wide widget
   * has no single page to link to, and a page that is not live would be a badge
   * on a customer's homepage linking to a 404 — which is worse than a badge
   * that does not link anywhere.
   */
  pageUrl: string | null;
};

/**
 * The widget behind a public key, or null.
 *
 * Returns unpublished widgets too — the caller decides. The public endpoint
 * refuses them; the in-app preview needs to render one before it goes live, and
 * a preview that could only show published widgets would make "preview then
 * publish" impossible.
 */
export async function resolveWidgetByKey(publicKey: string): Promise<PublicWidget | null> {
  if (!looksLikeWidgetKey(publicKey)) return null;

  const [row] = await getAdminDb()
    .select({
      widgetId: schema.widgets.id,
      organizationId: schema.widgets.organizationId,
      organizationName: schema.organizations.name,
      locationId: schema.widgets.locationId,
      locationName: schema.locations.name,
      name: schema.widgets.name,
      published: schema.widgets.published,
      filters: schema.widgets.filters,
      style: schema.widgets.style,
      locationLocale: schema.locations.locale,
      locationPageSlug: schema.locations.publicSlug,
      locationPagePublished: schema.locations.publicPagePublished,
      organizationLocale: schema.organizations.locale,
    })
    .from(schema.widgets)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.widgets.organizationId))
    .leftJoin(schema.locations, eq(schema.locations.id, schema.widgets.locationId))
    .where(eq(schema.widgets.publicKey, publicKey))
    .limit(1);

  if (!row) return null;

  const style = parseStyle(row.style);
  const locale = [style.locale, row.locationLocale, row.organizationLocale].find(
    (candidate): candidate is Locale => isLocale(candidate ?? undefined),
  );

  return {
    widgetId: row.widgetId,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    locationId: row.locationId,
    locationName: row.locationName,
    name: row.name,
    published: row.published,
    filters: parseFilters(row.filters),
    style,
    locale: locale ?? DEFAULT_LOCALE,
    // Built here rather than in the renderer, which is a pure function of data
    // and has no business reading configuration.
    pageUrl:
      row.locationPageSlug && row.locationPagePublished
        ? locationPageUrl(publicBaseUrl(), row.locationPageSlug)
        : null,
  };
}

/**
 * One review, as the public sees it.
 *
 * Every field here is a deliberate decision to publish. Absent by construction:
 * `raw_payload`, the internal id trail, and every Phase 2 triage column
 * (`status`, `assignee_user_id`, `priority`, `sla_due_at`, `first_response_at`)
 * — what a business is behind on is nobody else's business.
 */
export type PublicReview = {
  id: string;
  rating: number | null;
  text: string | null;
  authorName: string | null;
  source: string;
  itemType: WidgetItemType;
  /** ISO 8601, or null when the source gave no date. */
  postedAt: string | null;
  /** The review where it was originally published, when there is one. */
  url: string | null;
};

/**
 * The aggregate behind the rating badge.
 *
 * Computed over **every rated review in the widget's scope** — approved or not,
 * above the minimum rating or not. That is the whole point of the field, and
 * the one place in this file where the approval gate deliberately does not
 * apply.
 *
 * An average taken over only the reviews a business hand-picked is a number the
 * business chose, presented in the shape of a number its customers produced.
 * Publishing that as "4.8 · 320 reviews" is deceptive on its face, and as
 * schema.org `AggregateRating` (P3-T3) it is a rich-result claim to a search
 * engine that the business's own selection made true. So the showcase may curate
 * *which reviews it quotes*; it may not curate *the score*.
 *
 * `basis` is on the wire so no consumer can mistake which of the two it holds.
 */
export type PublicAggregate = {
  basis: "all_reviews_in_scope";
  /** Mean rating to one decimal, or null when nothing in scope is rated. */
  average: number | null;
  /** How many rated reviews that average is drawn from. */
  count: number;
};

export type WidgetContent = {
  widget: PublicWidget;
  reviews: PublicReview[];
  aggregate: PublicAggregate;
};

/** This widget's outer boundary, in the shape `src/widgets/scope.ts` expects. */
export function scopeOfWidget(widget: PublicWidget): WidgetScope {
  return {
    organizationId: widget.organizationId,
    locationId: widget.locationId,
    sources: widget.filters.sources,
  };
}

/**
 * The reviews a widget shows, and the aggregate beside them.
 *
 * Both reads happen in one tenant transaction: two round trips against the same
 * snapshot, so the list and the count are never a few seconds apart. Neither
 * builds its own WHERE clause — `src/widgets/scope.ts` owns what "in scope"
 * means, so the badge cannot end up counting a location the list does not show,
 * and the builder's candidate list cannot offer a review this would refuse.
 */
export async function loadWidgetContent(widget: PublicWidget): Promise<WidgetContent> {
  const scope = scopeOfWidget(widget);

  // `approvedOnly: true`, always. There is no input on this path that can
  // change it — see the module header.
  const listConditions = widgetSelectionConditions(scope, widget.filters, { approvedOnly: true });

  return withTenant({ organizationId: widget.organizationId }, async (tx) => {
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
      .where(allOf(listConditions))
      // `id` breaks the tie so paging and caching see a stable order rather
      // than whatever the planner returned that second.
      .orderBy(sql`${schema.reviews.postedAt} desc nulls last`, desc(schema.reviews.id))
      .limit(widget.filters.count);

    // The aggregate deliberately uses the *scope* clauses, not the selection
    // ones: no approval gate and no minimum rating. See PublicAggregate.
    const [totals] = await tx
      .select({ average: avg(schema.reviews.rating), value: count() })
      .from(schema.reviews)
      .where(allOf([...widgetScopeConditions(scope), isNotNull(schema.reviews.rating)]));

    const average =
      totals?.average === null || totals?.average === undefined ? null : Number(totals.average);

    return {
      widget,
      reviews: rows.map((row) => ({
        id: row.id,
        rating: row.rating,
        text: row.text,
        authorName: row.authorName,
        source: row.source,
        // The list is filtered to displayable types, so the cast reflects a
        // condition the query already enforces.
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
