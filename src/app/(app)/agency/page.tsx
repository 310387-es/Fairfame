import { Building2, MapPin } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { ClientRoster, type ClientCard } from "@/components/agency/client-roster";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
import { listClientLocations, listClients } from "@/agency/clients";
import { can } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";

/**
 * The agency console (P4-T5).
 *
 * One screen listing every client organization this person can actually open,
 * with enough of a summary to decide which one needs attention today.
 *
 * **There is no cross-organization view beyond these figures, and that is a
 * decision rather than an omission.** `docs/20` asks for "bulk multi-location
 * management"; what it gets is a roster, a location table across the roster,
 * and a switcher — because a screen that *wrote* across tenants could not go
 * through `withTenant`, and the one thing this architecture has refused
 * everywhere since Phase 0 is a query that is not tenant-scoped. Managing a
 * client's locations means being in that client's account, which is one click
 * away rather than zero.
 *
 * **Gated on `agency_console` (Agency tier).** T5 shipped this ungated on the
 * argument that a roster is bookkeeping over access somebody already has, so
 * there is nothing to sell; P4-T6 reversed it, because `docs/20` prices
 * "white-label + agency console" together as the thing an agency buys, and a
 * build plan that names a tier is a pricing decision already taken.
 *
 * The **organization switcher** in the user menu is deliberately not behind
 * this. Being able to leave an organization you belong to is not a feature.
 */
export default async function ClientsPage() {
  const [actor, t, format] = await Promise.all([
    requireActor(),
    getTranslations("clients"),
    getFormatter(),
  ]);

  // A locked card rather than a redirect, on the P3-T7 precedent: "not on your
  // plan" is information, and a bounce to Home is a mystery.
  const unlocked = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    (tx) => can({ organizationId: actor.organizationId, tx }, "agency_console"),
  );

  if (!unlocked) {
    return (
      <>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <SectionCard title={t("locked.title")} icon={Building2}>
          <p className="pb-(--card-py) text-body text-ink-400">{t("locked.body")}</p>
        </SectionCard>
      </>
    );
  }

  const clients = await listClients(actor.organizationId, actor.userId);
  const locations = await listClientLocations(clients, actor.userId);
  const canManage = roleAtLeast(actor.role, "admin");

  const cards: ClientCard[] = clients.map((client) => ({
    organizationId: client.organizationId,
    name: client.name,
    label: client.label,
    slug: client.slug,
    role: client.role,
    locations: client.locations,
    reviews: client.reviews,
    // Formatted server-side — Turkish writes 4,3 where English writes 4.3.
    rating:
      client.rating === null
        ? null
        : format.number(client.rating, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    openItems: client.openItems,
  }));

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {clients.length === 0 ? (
        <SectionCard title={t("empty.title")} icon={Building2}>
          <div className="flex flex-col gap-3 pb-(--card-py)">
            <p className="text-body text-ink-400">{t("empty.body")}</p>
            <ClientRoster clients={[]} canManage={canManage} />
          </div>
        </SectionCard>
      ) : (
        <SectionCard title={t("roster")} icon={Building2} flush>
          <div className="px-(--card-px) pb-(--card-py)">
            <ClientRoster clients={cards} canManage={canManage} />
          </div>
        </SectionCard>
      )}

      {/*
        Every location across the roster, in one place — the "bulk
        multi-location management" view. Read-only by design: see the module
        note. Each row links into its own organization, which is where a change
        to it can legitimately be made.
      */}
      {locations.length > 0 ? (
        <SectionCard title={t("locations")} icon={MapPin} meta={t("locationsNote")} flush>
          <ul className="divide-y divide-line-soft">
            {locations.map((location) => (
              <li
                key={`${location.clientId}:${location.id}`}
                className="flex flex-wrap items-center gap-2 px-(--card-px) py-2.5"
              >
                <span className="min-w-0 truncate text-copy font-medium text-foreground">
                  {location.name}
                </span>
                <span className="text-meta text-faint">{location.clientName}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </>
  );
}
