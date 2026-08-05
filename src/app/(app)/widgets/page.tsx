import { LayoutGrid } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
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

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {!included ? (
        <SectionCard title={t("lockedTitle")} icon={LayoutGrid}>
          <p className="pb-(--card-py) text-body text-ink-400">{t("lockedBody")}</p>
        </SectionCard>
      ) : (
        <>
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
            {widgets.length === 0 ? (
              <p className="px-(--card-px) pb-(--card-py) text-body text-ink-400">{t("empty")}</p>
            ) : (
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
                        locations.find((location) => location.id === widget.locationId)?.name ??
                        null,
                    }}
                    canManage={canManage}
                  />
                ))}
              </ul>
            )}
          </SectionCard>

          {canManage ? (
            <CreateWidget
              locations={locations.map(({ id, name }) => ({ id, name }))}
              // The server enforces the limit too; this only avoids offering a
              // form that would be refused.
              atLimit={!limit.allowed}
            />
          ) : null}
        </>
      )}
    </>
  );
}
