import { MapPin } from "lucide-react";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getFormatter, getTranslations } from "next-intl/server";
import { requireActor } from "@/auth/session";
import { roleAtLeast } from "@/auth/permissions";
import { AddLocationForm } from "@/components/locations/add-location-form";
import {
  LocationDetail,
  type ConnectableSource,
  type ConnectedSource,
  type LocationRow,
} from "@/components/locations/location-detail";
import { LocationsTable, type LocationTableRow } from "@/components/locations/locations-table";
import { ResourcePage } from "@/components/ds/resource-page";
import { SectionTabs } from "@/components/shell/section-tabs";
import { describeConnectableProviders, describeProvider } from "@/connectors/capability-view";
import { FIRST_PARTY_PROVIDER } from "@/connectors/firstparty";
import { schema } from "@/db/client";
import { withinLimit } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";
import { publicBaseUrl } from "@/lib/urls";
import { loadLocationFacts } from "@/locations/facts";
import { listPublicPages } from "@/seo/store";

/**
 * Branches, as a table (W4.2).
 *
 * **What changed and why.** This was a grid of ~320px cards, each stacking a
 * branch's identity, its whole source list with per-source controls, and the
 * public-page panel. It answered "tell me about this branch" one branch at a
 * time and could not answer the question a multi-branch owner actually has —
 * *which* branch needs me — because no two numbers were ever on one line.
 *
 * The columns are now thirty-day figures with a rating delta, and the controls
 * moved into the row's detail panel. Everything that was on the card is still
 * reachable; it is one click down instead of permanently open.
 *
 * ## Deliberately not built here, and where each one lives
 *
 * `docs/remediation-plan.md` asks the row detail to carry a map, business hours
 * and a QR poster. All three are omitted on purpose rather than stubbed:
 *
 *   - **A map** needs a tile provider — an API key, an external request on a
 *     page served under this app's CSP, and a third party handed our customers'
 *     branch addresses. That is an infrastructure decision, not a component.
 *   - **Business hours** is item 8 on the plan's own later list, paired with
 *     the SLA calendar that is the entire reason to collect them. A field
 *     nothing reads is the `competitor_snapshots` mistake again: stored data
 *     outlives the intention behind it.
 *   - **A QR poster** is W4.5, which names it the highest ROI-to-effort item in
 *     the audit. Building half of it here would mean building it twice.
 */
export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ dev?: string }>;
}) {
  const [t, tThemes, format, actor, params] = await Promise.all([
    getTranslations("locations"),
    getTranslations("themes"),
    getFormatter(),
    requireActor(),
    searchParams,
  ]);

  /**
   * Whether to offer the development connectors (W1.4).
   *
   * Both conditions, not either: `?dev=1` is a convenience for whoever is
   * working on the thing, and `NODE_ENV` is the part that cannot be typed into
   * an address bar by a customer who saw the query string in a screen
   * recording. In production this is false however the URL is written.
   */
  const includeDevOnly = process.env.NODE_ENV !== "production" && params.dev === "1";

  const { locations, connections, facts, publicPages, approvedCount, limit } = await withTenant(
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

      facts: await loadLocationFacts(tx, actor.organizationId),

      // The hosted review pages, and how many reviews this organization has
      // approved for display anywhere. The second is a single count for the
      // whole organization rather than per location, because approval is a
      // property of the *review* — the warning it drives is "you have approved
      // nothing at all", which is the only version of it that can be true.
      publicPages: await listPublicPages(tx, actor.organizationId),
      approvedCount: await tx
        .select({ value: sql<number>`count(*)::int` })
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

  /**
   * Sources an owner can add by hand. First-party is excluded: it appears on
   * its own when a collection campaign is created, and offering a second way to
   * create it would be two buttons for one thing.
   */
  const connectableCatalogue: ConnectableSource[] = describeConnectableProviders({ includeDevOnly })
    .filter((view) => view.provider !== FIRST_PARTY_PROVIDER)
    .map((view) => ({
      provider: view.provider,
      label: view.label,
      sync: view.sync,
      isMock: view.isMock,
      canAuthorize: view.canAuthorize,
      ...(view.modeReason ? { modeReason: view.modeReason } : {}),
      ...(view.goLiveNote ? { goLiveNote: view.goLiveNote } : {}),
    }));

  const canManage = roleAtLeast(actor.role, "admin");
  const publicOrigin = publicBaseUrl();

  const rows: LocationTableRow[] = locations.map((location) => {
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
    const fact = facts.get(location.id);
    const publicPage = publicPages.get(location.id) ?? { slug: null, published: false };

    const detailRow: LocationRow = {
      ...location,
      reviewCount: fact?.reviews ?? 0,
      sources,
      connectable: connectableCatalogue.filter((source) => !connected.has(source.provider)),
      publicPage,
    };

    const rating = fact?.rating ?? null;
    const delta = fact?.ratingDelta ?? null;

    return {
      id: location.id,
      name: location.name,
      address: location.address,
      providers: sources.map((source) => source.provider),
      reviews: fact?.reviews ?? 0,
      rating,
      ratingDelta: delta,
      unanswered: fact?.unanswered ?? 0,
      publicPage,
      // Formatted on the server: a formatter function cannot cross the RSC
      // boundary, which this codebase has learned twice already (P3-T4, P4-T2).
      ratingLabel: rating === null ? null : t("ratingSr", { rating: format.number(rating) }),
      /**
       * A delta smaller than a rounding step is **no delta**, not "+0.0".
       * Printing a signed zero next to a star rating reads as a movement that
       * did not happen, and on a table of nine branches it is nine of them.
       */
      deltaLabel:
        delta === null || Math.abs(delta) < 0.05
          ? null
          : format.number(delta, { signDisplay: "always", maximumFractionDigits: 1 }),
      themes: (fact?.themes ?? []).map((entry) => ({
        label: tThemes(entry.theme),
        count: entry.count,
      })),
      detail: (
        <LocationDetail
          location={detailRow}
          canManage={canManage}
          // The origin a customer's visitors reach, which is not necessarily
          // the one an admin is signed in to — src/lib/urls.ts.
          publicOrigin={publicOrigin}
          approvedCount={approvedCount}
        />
      ),
    };
  });

  // A spent plan limit is a `blocked` reason rather than a disabled button:
  // "you have used all 3 of your locations" is something a reader can act on,
  // and a greyed-out control is not (W1.7).
  const create = !canManage
    ? null
    : !limit.allowed
      ? { blocked: t("limitReached", { limit: limit.limit ?? 0 }) }
      : {
          label: t("add"),
          title: t("addTitle"),
          description: t("addDescription"),
          form: <AddLocationForm />,
        };

  return (
    <ResourcePage
      title={t("title")}
      subtitle={t("subtitle")}
      icon={MapPin}
      isEmpty={rows.length === 0}
      empty={{ line: t("empty"), hint: t("addDescription") }}
      create={create}
      tabs={<SectionTabs active="locations" />}
    >
      <p className="text-body text-muted-foreground">
        {limit.limit === null
          ? t("usageUnlimited", { used: limit.current })
          : t("usage", { used: limit.current, limit: limit.limit })}
      </p>

      <LocationsTable rows={rows} />
    </ResourcePage>
  );
}
