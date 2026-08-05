import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/auth/session";
import { roleAtLeast } from "@/auth/permissions";
import { AddLocationForm } from "@/components/locations/add-location-form";
import {
  LocationCard,
  type ConnectableSource,
  type ConnectedSource,
  type LocationRow,
} from "@/components/locations/location-card";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { describeConnectableProviders, describeProvider } from "@/connectors/capability-view";
import { FIRST_PARTY_PROVIDER } from "@/connectors/firstparty";
import { schema } from "@/db/client";
import { withinLimit } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";
import { publicBaseUrl } from "@/lib/urls";
import { listPublicPages } from "@/seo/store";

/**
 * Locations: add one, connect sources to it, see what has been ingested.
 *
 * The source list is capability-driven end to end — what each connection can do
 * comes from its provider descriptor, and whether connecting starts an OAuth
 * handshake or attaches a mock comes from the environment's flags. Nothing on
 * this page names a platform.
 */
export default async function LocationsPage() {
  const [t, actor] = await Promise.all([getTranslations("locations"), requireActor()]);

  const { locations, connections, reviewCounts, publicPages, approvedCount, limit } =
    await withTenant(
      { organizationId: actor.organizationId, userId: actor.userId },
      async (tx) => ({
        locations: await tx
          .select({
            id: schema.locations.id,
            name: schema.locations.name,
            address: schema.locations.address,
            category: schema.locations.category,
          })
          .from(schema.locations)
          .where(eq(schema.locations.organizationId, actor.organizationId))
          .orderBy(sql`lower(${schema.locations.name})`),

        // Separate queries rather than one join: joining connections and reviews
        // to locations at once multiplies rows and turns both counts into fiction.
        connections: await tx
          .select({
            id: schema.connections.id,
            locationId: schema.connections.locationId,
            provider: schema.connections.provider,
            status: schema.connections.status,
            lastSyncedAt: schema.connections.lastSyncedAt,
            nextSyncAt: schema.connections.nextSyncAt,
            failureCount: schema.connections.failureCount,
            lastError: schema.connections.lastError,
          })
          .from(schema.connections)
          .where(eq(schema.connections.organizationId, actor.organizationId)),

        reviewCounts: await tx
          .select({ locationId: schema.reviews.locationId, total: count(schema.reviews.id) })
          .from(schema.reviews)
          .where(eq(schema.reviews.organizationId, actor.organizationId))
          .groupBy(schema.reviews.locationId),

        // The hosted review pages, and how many reviews this organization has
        // approved for display anywhere. The second is a single count for the
        // whole organization rather than per location, because approval is a
        // property of the *review* — the warning it drives is "you have approved
        // nothing at all", which is the only version of it that can be true.
        publicPages: await listPublicPages(tx, actor.organizationId),
        approvedCount: await tx
          .select({ value: count() })
          .from(schema.reviews)
          .where(
            and(
              eq(schema.reviews.organizationId, actor.organizationId),
              isNotNull(schema.reviews.displayApprovedAt),
            ),
          )
          .then(([row]) => row?.value ?? 0),

        limit: await withinLimit({ organizationId: actor.organizationId, tx }, "max_locations"),
      }),
    );

  const countByLocation = new Map(reviewCounts.map((row) => [row.locationId, row.total]));

  /**
   * Sources an owner can add by hand. First-party is excluded: it appears on
   * its own when a collection campaign is created, and offering a second way to
   * create it would be two buttons for one thing.
   */
  const connectableCatalogue: ConnectableSource[] = describeConnectableProviders()
    .filter((view) => view.provider !== FIRST_PARTY_PROVIDER)
    .map((view) => ({
      provider: view.provider,
      label: view.label,
      sync: view.sync,
      reply: view.reply,
      isMock: view.isMock,
      canAuthorize: view.canAuthorize,
      ...(view.modeReason ? { modeReason: view.modeReason } : {}),
      ...(view.goLiveNote ? { goLiveNote: view.goLiveNote } : {}),
    }));

  const rows: LocationRow[] = locations.map((location) => {
    const sources: ConnectedSource[] = connections
      .filter((connection) => connection.locationId === location.id)
      .map((connection) => {
        const view = describeProvider(connection.provider);

        return {
          connectionId: connection.id,
          provider: connection.provider,
          label: view?.label ?? connection.provider,
          status: connection.status,
          sync: view?.sync ?? "monitor",
          reply: view?.reply ?? "none",
          isMock: view?.isMock ?? false,
          // Serialized for the client component boundary.
          // A pending connection has credentials but no chosen place yet.
          needsSetup: connection.status === "pending",
          lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
          nextSyncAt: connection.nextSyncAt?.toISOString() ?? null,
          failureCount: connection.failureCount,
          lastError: connection.lastError,
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label));

    const connected = new Set(sources.map((source) => source.provider));

    return {
      ...location,
      reviewCount: countByLocation.get(location.id) ?? 0,
      sources,
      connectable: connectableCatalogue.filter((source) => !connected.has(source.provider)),
      publicPage: publicPages.get(location.id) ?? { slug: null, published: false },
    };
  });

  const canManage = roleAtLeast(actor.role, "admin");

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-body text-muted-foreground">
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
          <CardContent className="py-14 text-center text-body text-muted-foreground">
            {t("empty")}
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {rows.map((location) => (
            <li key={location.id}>
              <LocationCard
                location={location}
                canManage={canManage}
                // The origin a customer's visitors reach, which is not
                // necessarily the one an admin is signed in to — src/lib/urls.ts.
                publicOrigin={publicBaseUrl()}
                approvedCount={approvedCount}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
