import { Send } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { listCampaigns, listRecentRequests } from "@/collect/campaigns";
import { loadCollectionFunnel } from "@/collect/funnel";
import { FunnelStrip } from "@/components/requests/funnel-strip";
import { CampaignCard } from "@/components/requests/campaign-card";
import { CampaignForm } from "@/components/requests/campaign-form";
import { SectionTabs } from "@/components/shell/section-tabs";
import { ResourcePage } from "@/components/ds/resource-page";
import { Card, CardContent } from "@/components/ui/card";
import { listLocationsForActor } from "@/lib/active-location";
import { withinLimit } from "@/lib/entitlements";
import { qrSvg } from "@/lib/qr";
import { withTenant } from "@/lib/tenancy";
import { campaignUrl } from "@/lib/urls";

/**
 * Requests — create collection campaigns, share their link or QR, and watch
 * the funnel.
 *
 * The plan's `requests_per_month` allowance is shown from the same
 * `withinLimit()` the send path enforces, so the number on screen and the rule
 * in the action cannot disagree.
 */
export default async function RequestsPage() {
  const [t, format, actor] = await Promise.all([
    getTranslations("requests"),
    getFormatter(),
    requireActor(),
  ]);

  const { locations, campaigns, requests, funnel, limit } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => ({
      locations: await listLocationsForActor(tx, actor),
      campaigns: await listCampaigns(tx, actor.organizationId),
      requests: await listRecentRequests(tx, actor.organizationId, 25),
      funnel: await loadCollectionFunnel(tx, actor.organizationId),
      limit: await withinLimit(
        { organizationId: actor.organizationId, tx },
        "requests_per_month",
        // Report the current position, not whether one more would fit.
        { additional: 0 },
      ),
    }),
  );

  // Rendered on the server: the encoder stays out of the browser bundle, and
  // the markup is identical on every request for a given slug.
  const cards = await Promise.all(
    campaigns.map(async (campaign) => ({
      id: campaign.id,
      name: campaign.name,
      locationName: campaign.locationName,
      channel: campaign.channel,
      status: campaign.status,
      destination: campaign.destination,
      destinationUrl: campaign.destinationUrl,
      url: campaignUrl(campaign.slug),
      qrSvg: await qrSvg(campaignUrl(campaign.slug)),
      funnel: campaign.funnel,
    })),
  );

  const canManage = roleAtLeast(actor.role, "admin");

  // Without a location there is nothing to ask *about*, so that is a reason
  // rather than a form nobody can submit (W1.7).
  const create = !canManage
    ? null
    : locations.length === 0
      ? { blocked: t("noLocations") }
      : {
          label: t("newCampaign"),
          title: t("newCampaign"),
          description: t("newCampaignDescription"),
          form: <CampaignForm locations={locations} />,
        };

  return (
    <>
      {/* Above the ResourcePage rather than inside it: the tabs switch which
          *section* you are in, and the page's own header describes the one you
          landed on. Nesting them would make the tabs look like a filter. */}
      <SectionTabs active="requests" />

      <ResourcePage
        title={t("title")}
        subtitle={t("subtitle")}
        icon={Send}
        isEmpty={cards.length === 0}
        empty={{ line: t("empty"), hint: t("newCampaignDescription") }}
        create={create}
      >
        <p className="text-body text-muted-foreground">
          {limit.limit === null
            ? t("usageUnlimited", { used: limit.current })
            : t("usage", { used: limit.current, limit: limit.limit })}
        </p>
        <p className="max-w-2xl text-body text-pretty text-muted-foreground">
          {t("complianceNote")}
        </p>

        {/* Across the top, before the campaigns: "is this working" is the
            question somebody arrives with, and it is answered over every
            campaign at once rather than one card at a time. */}
        <FunnelStrip funnel={funnel} />

        <ul className="grid gap-3 lg:grid-cols-2">
          {cards.map((campaign) => (
            // `min-w-0`: a grid item defaults to `min-width: auto`, so without it
            // the track is floored at the card's min-content width and no amount
            // of wrapping inside can bring the page back (P1-12).
            <li key={campaign.id} className="min-w-0">
              <CampaignCard campaign={campaign} canManage={canManage} />
            </li>
          ))}
        </ul>

        <h2 className="mt-10 mb-3 text-title">{t("recentTitle")}</h2>

        {requests.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-body text-muted-foreground">
              {t("emptyRequests")}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-body">
                <thead className="border-b text-left text-copy text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t("columnRecipient")}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t("columnCampaign")}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t("columnStatus")}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t("columnSent")}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t("columnSubmitted")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((request) => (
                    <tr key={request.id} className="border-b last:border-0">
                      <td className="px-4 py-2">{request.recipient ?? t("walkIn")}</td>
                      <td className="px-4 py-2 text-muted-foreground">{request.campaignName}</td>
                      <td className="px-4 py-2">{t(`status.${request.status}`)}</td>
                      <td className="px-4 py-2 text-muted-foreground tabular-nums">
                        {request.sentAt ? format.dateTime(request.sentAt, "short") : "—"}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground tabular-nums">
                        {request.submittedAt ? format.dateTime(request.submittedAt, "short") : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </ResourcePage>
    </>
  );
}
