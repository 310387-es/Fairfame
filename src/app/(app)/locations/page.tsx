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
import { getEnv } from "@/lib/env";
import { withTenant } from "@/lib/tenancy";
import { publicBaseUrl } from "@/lib/urls";
import { loadLocationFacts } from "@/locations/facts";
import { renderAutoReply } from "@/replies/auto";
import { listReplyTemplates } from "@/replies/templates";
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
   * working on the thing, and `ALLOW_DEV_CONNECTORS` is the part that cannot be
   * typed into an address bar by a customer who saw the query string in a
   * screen recording. A real deployment never sets it, so this is false there
   * however the URL is written.
   *
   * It used to read `NODE_ENV !== "production"`, which was wrong in the
   * direction nobody notices: `next start` is production mode *everywhere*,
   * so the built app hid the connectors from CI as well — and the browser
   * suite, which needs one, only caught it once CI ran the real bundle.
   */
  const includeDevOnly = getEnv().ALLOW_DEV_CONNECTORS && params.dev === "1";

  const {
    locations,
    connections,
    facts,
    publicPages,
    templates,
    organizationName,
    approvedCount,
    limit,
  } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => ({
      locations: await tx
        .select({
          id: schema.locations.id,
          name: schema.locations.name,
          address: schema.locations.address,
          category: schema.locations.category,
          // How this branch's replies sound and sign off (W5-12). Read here
          // rather than in `loadLocationFacts` because they are settings, not
          // figures — the facts loader answers "how is this branch doing".
          brandTone: schema.locations.brandTone,
          replySignature: schema.locations.replySignature,
          // The auto-reply rule (W5-6). Null template means off.
          autoReplyTemplateId: schema.locations.autoReplyTemplateId,
          autoReplyDelayHours: schema.locations.autoReplyDelayHours,
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
      // The business's own name, which a template's `{{business}}` expands to.
      organizationName: await tx
        .select({ name: schema.organizations.name })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, actor.organizationId))
        .limit(1)
        .then(([row]) => row?.name ?? ""),
      // What an auto-reply rule may point at. The whole (short) list, because
      // the picker needs names and the preview needs one body.
      templates: await listReplyTemplates(tx, actor.organizationId),
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

  const templateOptions = templates.map((template) => ({
    id: template.id,
    name: template.name,
    language: template.language,
  }));

  /**
   * What a branch's auto-reply rule would actually post.
   *
   * Only for the template the rule is *currently* pointed at: a preview of an
   * unsaved selection would need every template rendered on every branch, and
   * the control says so rather than guessing.
   */
  function autoReplyPreview(
    location: { autoReplyTemplateId: string | null; name: string; replySignature: string | null },
    all: typeof templates,
    sampleAuthor: string,
  ): string | null {
    if (!location.autoReplyTemplateId) return null;
    const template = all.find((entry) => entry.id === location.autoReplyTemplateId);
    if (!template) return null;

    return renderAutoReply(
      { body: template.body, signature: location.replySignature },
      {
        authorName: sampleAuthor,
        locationName: location.name,
        organizationName: organizationName,
      },
    );
  }

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
      id: location.id,
      name: location.name,
      address: location.address,
      category: location.category,
      reviewCount: fact?.reviews ?? 0,
      sources,
      connectable: connectableCatalogue.filter((source) => !connected.has(source.provider)),
      publicPage,
      voice: { brandTone: location.brandTone, replySignature: location.replySignature },
      autoReply: {
        templateId: location.autoReplyTemplateId,
        delayHours: location.autoReplyDelayHours,
        /*
          What the rule would actually post, rendered here rather than in the
          browser — the same reason every other formatted string on this page
          is: `renderAutoReply` reaches the template body and the branch's
          signature, and a client component may not.

          The preview uses a stand-in author, because the rule answers whoever
          turns up next and there is nobody to name yet.
        */
        preview: autoReplyPreview(location, templates, t("autoReply.sampleAuthor")),
      },
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
      // One decimal, like every other rating in the product — and like the
      // delta nine lines below, which this file already got right. Unformatted,
      // a stored average announces itself as "3.745 out of 5": false precision
      // that only somebody on a screen reader ever hears, because the column
      // beside it draws stars and shows no number at all.
      ratingLabel:
        rating === null
          ? null
          : t("ratingSr", {
              rating: format.number(rating, {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              }),
            }),
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
          templates={templateOptions}
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
