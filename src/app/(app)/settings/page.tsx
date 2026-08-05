import { getLocale, getTranslations } from "next-intl/server";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { BrandingForm } from "@/components/agency/branding-form";
import { PreferenceForm, type PreferenceValue } from "@/components/notifications/preference-form";
import { TemplateManager } from "@/components/replies/template-manager";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import { listLocationsForActor } from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";
import { DEFAULT_PREFERENCE, preferencesForUser } from "@/notifications/preferences";
import { MAX_TEMPLATE_BODY, listReplyTemplates } from "@/replies/templates";
import { parseBranding } from "@/agency/branding";
import { can } from "@/lib/entitlements";
import { schema } from "@/db/client";
import { eq } from "drizzle-orm";

/**
 * Settings.
 *
 * Notification preferences are per *user*, not per organization — the rows
 * shown here belong to the signed-in actor and nobody else's are readable,
 * which is why the query takes `actor.userId`.
 */
export default async function SettingsPage() {
  const [t, tn, tt, tb, actor, locale] = await Promise.all([
    getTranslations("settings"),
    getTranslations("settings.notifications"),
    getTranslations("templates"),
    getTranslations("branding"),
    requireActor(),
    getLocale(),
  ]);

  const { locations, preferences, templates, organization, canWhiteLabel } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => ({
      locations: await listLocationsForActor(tx, actor),
      preferences: await preferencesForUser(tx, actor.organizationId, actor.userId),
      templates: await listReplyTemplates(tx, actor.organizationId),
      organization: await tx
        .select({
          logo: schema.organizations.logo,
          branding: schema.organizations.branding,
          customDomain: schema.organizations.customDomain,
        })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, actor.organizationId))
        .limit(1)
        .then(([row]) => row ?? null),
      canWhiteLabel: await can({ organizationId: actor.organizationId, tx }, "white_label"),
    }),
  );

  const branding = parseBranding(organization?.branding);

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
          <CardTitle>{tn("title")}</CardTitle>
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
            <p className="text-body text-muted-foreground">{tn("noLocations")}</p>
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

      {/*
        Branding (P4-T5). Admin only: it changes what a business's customers
        see, which is not a per-person preference like the block above.
      */}
      {roleAtLeast(actor.role, "admin") ? (
        <Card id="branding" className="mt-4 scroll-mt-20">
          <CardHeader>
            <CardTitle>{tb("title")}</CardTitle>
            <CardDescription>{tb("subtitle")}</CardDescription>
          </CardHeader>
          <CardContent>
            <BrandingForm
              initial={{
                senderName: branding.senderName ?? "",
                primaryColor: branding.primaryColor ?? "",
                logoUrl: organization?.logo ?? "",
                hidePoweredBy: branding.hidePoweredBy ?? false,
                customDomain: organization?.customDomain ?? "",
              }}
              canWhiteLabel={canWhiteLabel}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card id="templates" className="mt-4 scroll-mt-20">
        <CardHeader>
          <CardTitle>{tt("title")}</CardTitle>
          <CardDescription>{tt("subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <TemplateManager
            templates={templates}
            // Templates shape what the whole team says in the business's name,
            // so writing them is admin work. The server enforces the same rule.
            canManage={roleAtLeast(actor.role, "admin")}
            maxChars={MAX_TEMPLATE_BODY}
            defaultLanguage={isLocale(locale) ? locale : DEFAULT_LOCALE}
          />
        </CardContent>
      </Card>
    </>
  );
}
