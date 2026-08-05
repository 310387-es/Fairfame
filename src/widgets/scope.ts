import { and, eq, gte, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { WIDGET_ITEM_TYPES, type WidgetFilters, type WidgetItemType } from "./config.ts";

/**
 * What "in this widget's scope" means — in exactly one place.
 *
 * Three readers need this answer and they must never disagree:
 *
 *   - the public endpoint, which serves the reviews;
 *   - the aggregate beside them, which counts a wider set on purpose;
 *   - the builder's approval list, which shows a business what it is choosing
 *     between.
 *
 * A builder that listed candidates by slightly different rules than the widget
 * renders by is a support ticket that reads "I approved it and it did not
 * appear", and the cause would be two WHERE clauses that drifted a month apart.
 * So the clauses are built here and imported, never retyped.
 */

export type WidgetScope = {
  organizationId: string;
  /** Null spans every location in the organization. */
  locationId: string | null;
  /** Empty means every source. */
  sources: string[];
};

/**
 * The outer boundary: tenant, location, source. Everything a widget could ever
 * draw from, before any editorial choice is applied.
 *
 * `organizationId` is threaded explicitly even though RLS already constrains
 * the rows, because one of the callers answers the open internet and belt plus
 * braces is cheap.
 */
export function widgetScopeConditions(scope: WidgetScope): SQL[] {
  const conditions: SQL[] = [
    eq(schema.reviews.organizationId, scope.organizationId),
    /**
     * A DM can never be displayed. The database refuses to approve one
     * (`reviews_dm_never_published`) so this is redundant — and it stays,
     * because private correspondence staying private should not depend on a
     * CHECK constraint surviving a future migration.
     */
    ne(schema.reviews.itemType, "dm"),
  ];

  if (scope.locationId) {
    conditions.push(eq(schema.reviews.locationId, scope.locationId));
  }
  if (scope.sources.length > 0) {
    conditions.push(inArray(schema.reviews.source, scope.sources));
  }

  return conditions;
}

/**
 * The editorial layer: which of those a widget actually shows.
 *
 * `approvedOnly` is a parameter with exactly two callers, and they are not
 * symmetrical. The public read passes `true`, always, with no input that can
 * change it. The builder passes `false` because its whole job is to show a
 * business the reviews it has *not* yet chosen — that list would be empty
 * otherwise, and nobody could ever approve a first one.
 */
export function widgetSelectionConditions(
  scope: WidgetScope,
  filters: WidgetFilters,
  options: { approvedOnly: boolean },
): SQL[] {
  const conditions = widgetScopeConditions(scope);

  if (options.approvedOnly) {
    conditions.push(isNotNull(schema.reviews.displayApprovedAt));
  }

  const itemTypes: readonly WidgetItemType[] =
    filters.itemTypes.length > 0 ? filters.itemTypes : WIDGET_ITEM_TYPES;
  conditions.push(inArray(schema.reviews.itemType, [...itemTypes]));

  if (filters.minRating !== null) {
    conditions.push(gte(schema.reviews.rating, filters.minRating));
  }
  if (filters.requireText) {
    conditions.push(sql`length(trim(coalesce(${schema.reviews.text}, ''))) > 0`);
  }

  return conditions;
}

/** Convenience for the common `where(and(...))` shape. */
export function allOf(conditions: SQL[]): SQL {
  // `and()` is only undefined for an empty list, which none of these are.
  return and(...conditions)!;
}
