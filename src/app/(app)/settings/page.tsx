import { getTranslations } from "next-intl/server";
import { requireActor } from "@/auth/session";
import { PreferenceForm, type PreferenceValue } from "@/components/notifications/preference-form";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listLocations } from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";
import { DEFAULT_PREFERENCE, preferencesForUser } from "@/notifications/preferences";

/**
 * Settings.
 *
 * Notification preferences are per *user*, not per organization — the rows
 * shown here belong to the signed-in actor and nobody else's are readable,
 * which is why the query takes `actor.userId`.
 */
export default async function SettingsPage() {
  const [t, tn, actor] = await Promise.all([
    getTranslations("settings"),
    getTranslations("settings.notifications"),
    requireActor(),
  ]);

  const { locations, preferences } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => ({
      locations: await listLocations(tx, actor.organizationId),
      preferences: await preferencesForUser(tx, actor.organizationId, actor.userId),
    }),
  );

  const defaultRow = preferences.find((row) => row.locationId === null);
  const defaultValue: PreferenceValue = defaultRow
    ? {
        scope: defaultRow.scope,
        delivery: defaultRow.delivery,
        inApp: defaultRow.inApp,
        email: defaultRow.email,
      }
    : DEFAULT_PREFERENCE;

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Card id="notifications" className="scroll-mt-20">
        <CardHeader>
          <CardTitle className="text-base">{tn("title")}</CardTitle>
          <CardDescription>{tn("subtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <PreferenceForm
            locationId={null}
            locationName={tn("defaultRow")}
            value={defaultValue}
            overridden={false}
          />

          {locations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tn("noLocations")}</p>
          ) : (
            locations.map((location) => {
              const row = preferences.find((entry) => entry.locationId === location.id);

              return (
                <PreferenceForm
                  key={location.id}
                  locationId={location.id}
                  locationName={location.name}
                  // A location with no row of its own shows the default's
                  // values, so what is on screen is what would actually happen.
                  value={
                    row
                      ? {
                          scope: row.scope,
                          delivery: row.delivery,
                          inApp: row.inApp,
                          email: row.email,
                        }
                      : defaultValue
                  }
                  overridden={row !== undefined}
                />
              );
            })
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {t("placeholder")}
        </CardContent>
      </Card>
    </>
  );
}
