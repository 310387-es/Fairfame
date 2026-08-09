import { Send, ShieldCheck } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { channelStatuses } from "@/channels/status";
import { listCampaigns, listRecentRequests } from "@/collect/campaigns";
import { loadCollectionFunnel } from "@/collect/funnel";
import { FunnelStrip } from "@/components/requests/funnel-strip";
import { CampaignCard } from "@/components/requests/campaign-card";
import { CampaignForm } from "@/components/requests/campaign-form";
import { SectionTabs } from "@/components/shell/section-tabs";
import { ResourcePage } from "@/components/ds/resource-page";
import { Th, Thead } from "@/components/ds/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { listLocationsForActor } from "@/lib/active-location";
import { withinLimit } from "@/lib/entitlements";
import { qrSvg } from "@/lib/qr";
import { withTenant } from "@/lib/tenancy";
import { campaignUrl } from "@/lib/urls";

/**
 * How a request's state is drawn.
 *
 * Only the two ends are coloured. `submitted` is the outcome the whole screen
 * exists to produce and `failed` is the only one anybody can act on; the three
 * in between are progress, and colouring them would spend the reader's
 * attention on the fact that an email was delivered.
 */
const REQUEST_TONES: Record<string, "positive" | "destructive" | "secondary"> = {
  submitted: "positive",
  failed: "destructive",
  pending: "secondary",
  sent: "secondary",
  opened: "secondary",
};

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

  const { locations, campaigns, requests, funnel, limit, channels } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => ({
      locations: await listLocationsForActor(tx, actor),
      campaigns: await listCampaigns(tx, actor.organizationId),
      requests: await listRecentRequests(tx, actor.organizationId, 25),
      funnel: await loadCollectionFunnel(tx, actor.organizationId),
      // What a campaign may actually be created on. Read here rather than in
      // the form, which is a client component and cannot ask the gate.
      channels: await channelStatuses(tx, actor.organizationId),
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
          form: (
            <CampaignForm
              locations={locations}
              // Only the two that carry a message. Email needs no provisioning
              // and `link` sends nothing, so neither has a status to report.
              messagingChannels={channels
                .filter(
                  (
                    status,
                  ): status is (typeof channels)[number] & {
                    descriptor: { key: "whatsapp" | "sms" };
                  } => status.descriptor.key === "whatsapp" || status.descriptor.key === "sms",
                )
                .map((status) => ({
                  channel: status.descriptor.key,
                  connected: !status.blockers.includes("not_connected"),
                  deliverable: status.deliverable,
                }))}
            />
          ),
        };

  return (
    <>
      {/*
        Into `ResourcePage`'s `tabs` slot, which renders them *under* the page
        header — the placement `/locations`, `/connections` and `/contacts`
        already use.

        These three had them above the header instead, on the reasoning that a
        tab strip switches section while the header describes the page. That is
        true and it is not what the reader sees: above the title, the strip
        reads as chrome the title hangs off, and the page's own name comes
        second on its own screen.

        What settles it is that this file already did both. The locked-plan
        branch a few lines up renders `PageHeader` then `SectionTabs`, so the
        tab strip moved up or down the page depending on the organization's
        entitlement — the same screen, two layouts, decided by billing.
      */}
      <ResourcePage
        title={t("title")}
        subtitle={t("subtitle")}
        icon={Send}
        tabs={<SectionTabs active="requests" />}
        isEmpty={cards.length === 0}
        empty={{ line: t("empty"), hint: t("newCampaignDescription") }}
        create={create}
      >
        {/*
          Two floating paragraphs used to sit here — the month's quota and the
          no-rating-gating promise — set as plain grey body text above a card,
          which is how a page acquires prose nobody reads. They are both real
          content: one is a limit somebody can hit, the other is the sentence
          that distinguishes this product from the competitors who filter by
          rating. Neither is a paragraph; together they are one note.

          The shield is the point. `complianceNote` says the option does not
          exist here, which reads as a boast in grey and as a guarantee beside a
          positive mark.
        */}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 rounded-lg border border-line-soft bg-surface-sunken/50 px-4 py-3">
          <p className="flex max-w-2xl items-start gap-2 text-copy text-pretty text-muted-foreground">
            <ShieldCheck aria-hidden className="mt-px size-4 shrink-0 text-positive" />
            {t("complianceNote")}
          </p>
          <p className="text-copy text-faint tabular-nums">
            {limit.limit === null
              ? t("usageUnlimited", { used: limit.current })
              : t("usage", { used: limit.current, limit: limit.limit })}
          </p>
        </div>

        {/* Across the top, before the campaigns: "is this working" is the
            question somebody arrives with, and it is answered over every
            campaign at once rather than one card at a time. */}
        <FunnelStrip funnel={funnel} />

        {/*
          One campaign per row, not two across.

          Two-up gave each card 520px of a 1500px page, and a campaign is not a
          tile — it carries a QR, a public link, five share actions, a recipient
          picker and an address box. At 520px the share buttons wrapped with
          "Open page" alone on a line, the send form was pushed below everything,
          and 990px of the page stayed empty. `CampaignCard` splits into share
          and send at `lg` instead, so the width goes to the content rather than
          to a second column of white.

          Comparing campaigns is not the job here — `FunnelStrip` above answers
          that across all of them at once, which is why it is at the top.
        */}
        <ul className="flex flex-col gap-4">
          {cards.map((campaign) => (
            // `min-w-0`: a flex item defaults to `min-width: auto`, so without it
            // the row is floored at the card's min-content width and no amount
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
            <CardContent className="overflow-x-auto p-0 scroll-shadow">
              <table className="w-full text-body">
                <Thead>
                  <tr>
                    <Th>{t("columnRecipient")}</Th>
                    <Th>{t("columnCampaign")}</Th>
                    <Th>{t("columnStatus")}</Th>
                    <Th numeric>{t("columnSent")}</Th>
                    <Th numeric>{t("columnSubmitted")}</Th>
                  </tr>
                </Thead>
                <tbody>
                  {requests.map((request) => (
                    <tr key={request.id} className="border-b last:border-0">
                      <td className="px-4 py-2">{request.recipient ?? t("walkIn")}</td>
                      <td className="px-4 py-2 text-muted-foreground">{request.campaignName}</td>
                      <td className="px-4 py-2">
                        {/*
                          A chip, not a word. Every other state in the product
                          is one — a campaign's "Active" is a chip six rows up
                          this same page — and the five values here are the one
                          column somebody scans this table for. As plain text
                          they read as five equal facts; the two that matter are
                          "Review left" (it worked) and "Failed" (it did not).
                        */}
                        <Badge variant={REQUEST_TONES[request.status] ?? "secondary"}>
                          {t(`status.${request.status}`)}
                        </Badge>
                      </td>
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
