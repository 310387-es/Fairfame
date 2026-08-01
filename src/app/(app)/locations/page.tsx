import { getTranslations } from "next-intl/server";
import { requireActor } from "@/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { listLocations } from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";

/**
 * Locations list. Adding a location and connecting a source arrive in T10;
 * this already reads real, tenant-scoped data rather than a stub.
 */
export default async function LocationsPage() {
  const [t, actor] = await Promise.all([getTranslations("locations"), requireActor()]);

  const locations = await withTenant({ organizationId: actor.organizationId }, (tx) =>
    listLocations(tx, actor.organizationId),
  );

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {locations.length === 0 ? (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">
            {t("empty")}
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {locations.map((location) => (
            <li key={location.id}>
              <Card>
                <CardContent className="py-4">
                  <p className="font-medium">{location.name}</p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
