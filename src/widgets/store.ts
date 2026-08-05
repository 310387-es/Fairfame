import { and, desc, eq } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import {
  DEFAULT_WIDGET_FILTERS,
  parseFilters,
  parseStyle,
  widgetFiltersSchema,
  widgetStyleSchema,
  type WidgetFilters,
  type WidgetStyle,
} from "./config.ts";
import { generateWidgetKey } from "./keys.ts";

/**
 * The **authenticated** side of widgets: what the builder reads and writes.
 *
 * Deliberately a different module from `src/widgets/public.ts`. That one is
 * reached by strangers and resolves a tenant from a key; this one is reached by
 * a signed-in member and is handed a tenant transaction that already carries
 * their organization. Keeping them apart means the public file stays small
 * enough to read in one sitting, and no call site can reach for the wrong one
 * by autocomplete.
 *
 * Every function here takes a `TenantDatabase` — the caller opened the scope,
 * so RLS is already in force and there is no path that forgets it.
 */

export type WidgetSummary = {
  id: string;
  name: string;
  publicKey: string;
  published: boolean;
  locationId: string | null;
  filters: WidgetFilters;
  style: WidgetStyle;
  updatedAt: Date;
};

const summaryColumns = {
  id: schema.widgets.id,
  name: schema.widgets.name,
  publicKey: schema.widgets.publicKey,
  published: schema.widgets.published,
  locationId: schema.widgets.locationId,
  filters: schema.widgets.filters,
  style: schema.widgets.style,
  updatedAt: schema.widgets.updatedAt,
};

function toSummary(row: {
  id: string;
  name: string;
  publicKey: string;
  published: boolean;
  locationId: string | null;
  filters: unknown;
  style: unknown;
  updatedAt: Date;
}): WidgetSummary {
  return { ...row, filters: parseFilters(row.filters), style: parseStyle(row.style) };
}

export async function listWidgets(
  tx: TenantDatabase,
  organizationId: string,
): Promise<WidgetSummary[]> {
  const rows = await tx
    .select(summaryColumns)
    .from(schema.widgets)
    .where(eq(schema.widgets.organizationId, organizationId))
    .orderBy(desc(schema.widgets.updatedAt));

  return rows.map(toSummary);
}

export async function getWidget(
  tx: TenantDatabase,
  organizationId: string,
  id: string,
): Promise<WidgetSummary | null> {
  const [row] = await tx
    .select(summaryColumns)
    .from(schema.widgets)
    .where(and(eq(schema.widgets.organizationId, organizationId), eq(schema.widgets.id, id)))
    .limit(1);

  return row ? toSummary(row) : null;
}

export type NewWidgetInput = {
  organizationId: string;
  name: string;
  locationId: string | null;
};

/**
 * What a *new* widget starts as, which is not the same as what an unreadable
 * config falls back to.
 *
 * A new widget begins at four stars and up. `DEFAULT_WIDGET_FILTERS` stays at
 * "any rating" because it is also the fallback for a config that failed to
 * parse, and silently hiding reviews a business had chosen to show would be the
 * wrong way to degrade. But a *fresh* widget with no minimum plus a prominent
 * "Approve all 43" button is a trap: one click and a one-star rant is on the
 * homepage, which is not what anybody pressing that button meant. The control
 * is right there to lower it, and the rating badge counts every review either
 * way, so nothing here hides anything from a visitor who wants the real number.
 */
const NEW_WIDGET_MIN_RATING = 4;

/**
 * Creates a widget, unpublished.
 *
 * Retries once on the vanishingly unlikely key collision rather than looping:
 * at 24 characters over a 31-symbol alphabet a second collision would be
 * evidence that the random source is broken, and quietly retrying through that
 * is worse than failing loudly.
 */
export async function createWidget(
  tx: TenantDatabase,
  input: NewWidgetInput,
): Promise<WidgetSummary> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const [row] = await tx
      .insert(schema.widgets)
      .values({
        organizationId: input.organizationId,
        name: input.name,
        locationId: input.locationId,
        publicKey: generateWidgetKey(),
        filters: { ...DEFAULT_WIDGET_FILTERS, minRating: NEW_WIDGET_MIN_RATING },
      })
      .onConflictDoNothing({ target: schema.widgets.publicKey })
      .returning(summaryColumns);

    if (row) return toSummary(row);
  }

  throw new Error("Could not allocate a widget key.");
}

export type WidgetUpdate = {
  name?: string;
  locationId?: string | null;
  filters?: WidgetFilters;
  style?: WidgetStyle;
  published?: boolean;
};

/**
 * Saves a widget's configuration.
 *
 * `filters` and `style` are re-validated on the way in even though the action
 * already parsed them. They are about to become jsonb — the one column shape
 * the database cannot check — and this is the last place with a schema in hand.
 */
export async function updateWidget(
  tx: TenantDatabase,
  organizationId: string,
  id: string,
  update: WidgetUpdate,
): Promise<WidgetSummary | null> {
  const values: Record<string, unknown> = { updatedAt: new Date() };

  if (update.name !== undefined) values.name = update.name;
  if (update.locationId !== undefined) values.locationId = update.locationId;
  if (update.published !== undefined) values.published = update.published;
  if (update.filters !== undefined) values.filters = widgetFiltersSchema.parse(update.filters);
  if (update.style !== undefined) values.style = widgetStyleSchema.parse(update.style);

  const [row] = await tx
    .update(schema.widgets)
    .set(values)
    .where(and(eq(schema.widgets.organizationId, organizationId), eq(schema.widgets.id, id)))
    .returning(summaryColumns);

  return row ? toSummary(row) : null;
}

/**
 * Which connector sources this organization actually has reviews from.
 *
 * The builder offers these as filter checkboxes rather than a fixed list of
 * every provider Revira supports: a source toggle for a platform a business has
 * never connected is a control that does nothing, and three of them make the
 * panel look broken. A source with no reviews is not a choice.
 */
export async function listReviewSources(
  tx: TenantDatabase,
  organizationId: string,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ source: schema.reviews.source })
    .from(schema.reviews)
    .where(eq(schema.reviews.organizationId, organizationId))
    .orderBy(schema.reviews.source);

  return rows.map((row) => row.source);
}

export async function deleteWidget(
  tx: TenantDatabase,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const rows = await tx
    .delete(schema.widgets)
    .where(and(eq(schema.widgets.organizationId, organizationId), eq(schema.widgets.id, id)))
    .returning({ id: schema.widgets.id });

  return rows.length > 0;
}
