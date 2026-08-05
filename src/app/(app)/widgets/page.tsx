import { LayoutGrid } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
import { ResourcePage } from "@/components/ds/resource-page";
import { CreateWidget } from "@/components/widgets/create-widget";
import { WidgetRow } from "@/components/widgets/widget-row";
import { listLocationsForActor } from "@/lib/active-location";
import { getEntitlements, withinLimit } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";
import { listWidgets } from "@/widgets/store";

/**
 * Widgets — the showcase list (P3-T1).
 *
 * Deliberately plain: a widget is configured on its own page, so this one only
 * has to answer "what do I have, and is it live". The published/draft state is
 * the column that matters, because the difference between the two is whether
 * something is on the open internet.
 */
export default async function WidgetsPage() {
  const [t, actor] = await Promise.all([getTranslations("widgets"), requireActor()]);

  const { widgets, locations, entitlements, limit } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const org = { organizationId: actor.organizationId, tx };
      return {
        widgets: await listWidgets(tx, actor.organizationId),
        locations: await listLocationsForActor(tx, actor),
        entitlements: await getEntitlements(org),
        limit: await withinLimit(org, "max_widgets"),
      };
    },
  );

  const included = entitlements.entitlements.features.widgets;
  const canManage = roleAtLeast(actor.role, "admin");

  if (!included) {
    return (
      <>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <SectionCard title={t("lockedTitle")} icon={LayoutGrid}>
          <p className="pb-(--card-py) text-body text-ink-400">{t("lockedBody")}</p>
        </SectionCard>
      </>
    );
  }

  // The server enforces the limit too; this decides what to *offer*, and a
  // spent allowance is a sentence rather than a form that would be refused.
  const create = !canManage
    ? null
    : !limit.allowed
      ? { blocked: t("atLimit") }
      : {
          label: t("createTitle"),
          title: t("createTitle"),
          form: <CreateWidget locations={locations.map(({ id, name }) => ({ id, name }))} />,
        };

  return (
    <ResourcePage
      title={t("title")}
      subtitle={t("subtitle")}
      icon={LayoutGrid}
      isEmpty={widgets.length === 0}
      empty={{ line: t("empty") }}
      create={create}
    >
      <SectionCard
        title={t("listTitle")}
        icon={LayoutGrid}
        meta={
          limit.limit === null
            ? undefined
            : t("limitMeta", { used: limit.current, limit: limit.limit })
        }
        flush
      >
        <ul className="border-t border-line-soft">
          {widgets.map((widget) => (
            <WidgetRow
              key={widget.id}
              widget={{
                id: widget.id,
                name: widget.name,
                published: widget.published,
                layout: widget.style.layout,
                locationName:
                  locations.find((location) => location.id === widget.locationId)?.name ?? null,
              }}
              canManage={canManage}
            />
          ))}
        </ul>
      </SectionCard>
    </ResourcePage>
  );
}
