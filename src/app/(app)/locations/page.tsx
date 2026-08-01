import { count, eq, sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/auth/session";
import { roleAtLeast } from "@/auth/permissions";
import { AddLocationForm } from "@/components/locations/add-location-form";
import { LocationCard, type LocationRow } from "@/components/locations/location-card";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { schema } from "@/db/client";
import { withinLimit } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";

/**
 * Locations: add one, connect the Mock source, see what has been ingested.
 *
 * Reads are tenant-scoped; the plan limit shown here is the same check the
 * server action enforces, so the affordance and the rule cannot disagree.
 */
export default async function LocationsPage() {
  const [t, actor] = await Promise.all([getTranslations("locations"), requireActor()]);

  const { rows, limit } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      // One query: locations, their mock connection if any, and review counts.
      const locations = await tx
        .select({
          id: schema.locations.id,
          name: schema.locations.name,
          address: schema.locations.address,
          category: schema.locations.category,
          connectionId: schema.connections.id,
          reviewCount: count(schema.reviews.id),
        })
        .from(schema.locations)
        .leftJoin(schema.connections, eq(schema.connections.locationId, schema.locations.id))
        .leftJoin(schema.reviews, eq(schema.reviews.locationId, schema.locations.id))
        .where(eq(schema.locations.organizationId, actor.organizationId))
        .groupBy(schema.locations.id, schema.connections.id)
        .orderBy(sql`lower(${schema.locations.name})`);

      return {
        rows: locations satisfies LocationRow[],
        limit: await withinLimit({ organizationId: actor.organizationId, tx }, "max_locations"),
      };
    },
  );

  const canManage = roleAtLeast(actor.role, "admin");

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {limit.limit === null
            ? t("usageUnlimited", { used: limit.current })
            : t("usage", { used: limit.current, limit: limit.limit })}
        </p>
      </div>

      {canManage ? (
        <div className="mb-6">
          <AddLocationForm
            disabled={!limit.allowed}
            disabledReason={
              limit.allowed ? undefined : t("limitReached", { limit: limit.limit ?? 0 })
            }
          />
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">
            {t("empty")}
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {rows.map((location) => (
            <li key={location.id}>
              <LocationCard location={location} canManage={canManage} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
