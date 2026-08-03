import { getFormatter, getTranslations } from "next-intl/server";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { listCampaigns, listRecentRequests } from "@/collect/campaigns";
import { CampaignCard } from "@/components/requests/campaign-card";
import { CampaignForm } from "@/components/requests/campaign-form";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { listLocations } from "@/lib/active-location";
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

  const { locations, campaigns, requests, limit } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => ({
      locations: await listLocations(tx, actor.organizationId),
      campaigns: await listCampaigns(tx, actor.organizationId),
      requests: await listRecentRequests(tx, actor.organizationId, 25),
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

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <p className="mb-1 text-sm text-muted-foreground">
        {limit.limit === null
          ? t("usageUnlimited", { used: limit.current })
          : t("usage", { used: limit.current, limit: limit.limit })}
      </p>
      <p className="mb-6 max-w-2xl text-sm text-pretty text-muted-foreground">
        {t("complianceNote")}
      </p>

      {canManage ? (
        <div className="mb-6">
          {locations.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                {t("noLocations")}
              </CardContent>
            </Card>
          ) : (
            <CampaignForm locations={locations} />
          )}
        </div>
      ) : null}

      {cards.length === 0 ? (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">
            {t("empty")}
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {cards.map((campaign) => (
            <li key={campaign.id}>
              <CampaignCard campaign={campaign} canManage={canManage} />
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-10 mb-3 text-sm font-medium">{t("recentTitle")}</h2>

      {requests.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t("emptyRequests")}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
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
    </>
  );
}
