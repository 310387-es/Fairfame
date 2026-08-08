import { getTranslations } from "next-intl/server";
// Our own resolver, not `next-intl`'s: this page hands the value to a control
// that writes it back, and the two must agree about what a locale is (W3.3).
import { getLocale } from "@/i18n/locale";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { BrandingForm } from "@/components/agency/branding-form";
import { PreferenceForm, type PreferenceValue } from "@/components/notifications/preference-form";
import { PushToggle } from "@/components/notifications/push-toggle";
import { pushConfig } from "@/notifications/push";
import { TemplateManager } from "@/components/replies/template-manager";
import { LanguageCard } from "@/components/settings/language-card";
import { PageHeader } from "@/components/shell/page-header";
import { SectionTabs } from "@/components/shell/section-tabs";
import { PlanSection } from "@/components/billing/plan-section";
import { canCheckout } from "@/billing/checkout";
import { PLAN_CATALOG, PLAN_KEYS } from "@/lib/plans";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import { listLocationsForActor } from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";
import { DEFAULT_PREFERENCE, preferencesForUser } from "@/notifications/preferences";
import { minutesToClock, quietWindowOf } from "@/notifications/quiet-hours";
import { MAX_TEMPLATE_BODY, listReplyTemplates } from "@/replies/templates";
import { parseBranding } from "@/agency/branding";
import { can, getEntitlements, withinLimit } from "@/lib/entitlements";
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
  const [t, tn, tt, tb, tp, actor, locale] = await Promise.all([
    getTranslations("settings"),
    getTranslations("settings.notifications"),
    getTranslations("templates"),
    getTranslations("branding"),
    getTranslations("billing"),
    requireActor(),
    getLocale(),
  ]);

  const { locations, preferences, templates, organization, canWhiteLabel, entitlements, requests } =
    await withTenant(
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
            currency: schema.organizations.currency,
          })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, actor.organizationId))
          .limit(1)
          .then(([row]) => row ?? null),
        canWhiteLabel: await can({ organizationId: actor.organizationId, tx }, "white_label"),
        entitlements: await getEntitlements({ organizationId: actor.organizationId, tx }),
        requests: await withinLimit(
          { organizationId: actor.organizationId, tx },
          "requests_per_month",
        ),
        // Why a message would not send — the İYS registry and each channel's
        // own state. The same reader the /channels screen uses, so the two
        // cannot disagree about whether something is set up.
      }),
    );

  const branding = parseBranding(organization?.branding);

  /**
   * The stored quiet window as the `HH:MM` pair the form edits.
   *
   * Through `quietWindowOf` rather than reading the two columns directly, so
   * the screen and the sender agree about what half a window means — showing
   * hours the sender is ignoring would be the worst version of this.
   */
  function toClockPair(
    from: number | null,
    to: number | null,
  ): { from: string; to: string } | null {
    const window = quietWindowOf(from, to);
    return window ? { from: minutesToClock(window.from), to: minutesToClock(window.to) } : null;
  }

  const defaultRow = preferences.find((row) => row.locationId === null);
  const defaultValue: PreferenceValue = defaultRow
    ? {
        scope: defaultRow.scope,
        delivery: defaultRow.delivery,
        inApp: defaultRow.inApp,
        email: defaultRow.email,
        quiet: toClockPair(defaultRow.quietFrom, defaultRow.quietTo),
      }
    : { ...DEFAULT_PREFERENCE, quiet: null };

  /**
   * The four tiers, straight from the catalog (W1.8).
   *
   * Highlights are the *differences*, not a feature matrix: three lines a
   * reader can compare at a glance beats twenty checkboxes they will not read.
   * They come from i18n rather than from the catalog because they are marketing
   * copy in two languages, while the catalog holds the numbers the product
   * enforces — and those two things change for different reasons.
   */
  // Literal keys rather than a two-part template: `pnpm check:i18n` only
  // follows a single dot-namespaced dynamic segment, and a key it cannot see
  // reads as dead. The same reason `broadcasts/page.tsx` spells its labels out.
  const highlights: Record<(typeof PLAN_KEYS)[number], string[]> = {
    starter: [tp("highlights.starter1"), tp("highlights.starter2"), tp("highlights.starter3")],
    growth: [tp("highlights.growth1"), tp("highlights.growth2"), tp("highlights.growth3")],
    pro: [tp("highlights.pro1"), tp("highlights.pro2"), tp("highlights.pro3")],
    agency: [tp("highlights.agency1"), tp("highlights.agency2"), tp("highlights.agency3")],
  };

  const plans = PLAN_KEYS.map((key) => ({
    key,
    name: PLAN_CATALOG[key].name,
    priceMonth: PLAN_CATALOG[key].priceMonth,
    currency: PLAN_CATALOG[key].currency,
    highlights: highlights[key],
  }));

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <SectionTabs active="settings" />

      <PlanSection
        current={entitlements.effectivePlanKey}
        isTrialing={entitlements.isTrialing}
        trialEndsAt={entitlements.trialEndsAt?.toISOString() ?? null}
        plans={plans}
        usage={[
          {
            label: tp("usageRequests"),
            used: requests.current,
            limit: requests.limit,
          },
          {
            label: tp("usageLocations"),
            used: locations.length,
            limit: entitlements.entitlements.limits.max_locations,
          },
        ]}
        // Asked here rather than inside the component: whether a payment
        // provider exists is a server fact, and shipping the answer beats
        // shipping the question.
        canCheckout={canCheckout(organization?.currency ?? "TRY")}
        canManage={actor.role === "owner"}
      />

      <LanguageCard current={await getLocale()} />

      <Card id="notifications" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>{tn("title")}</CardTitle>
          <CardDescription>{tn("subtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {/*
            Above the per-branch rows, because it is about *this device* rather
            than about a branch — and because somebody who came here to make
            their phone buzz should not have to read a table first (W5-9).

            The public key is resolved on the server: whether push is configured
            at all is a deployment fact, and shipping the answer beats shipping
            the question.
          */}
          <PushToggle publicKey={pushConfig()?.publicKey ?? null} />

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
                          quiet: toClockPair(row.quietFrom, row.quietTo),
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
