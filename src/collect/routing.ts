import { buildCampaignUrl } from "../lib/urls.ts";
import type { CampaignDestination } from "../db/schema.ts";

/**
 * Where a review request sends the customer.
 *
 * This module is the product's answer to rating-gating, and it answers it with
 * a type signature rather than a policy document.
 *
 * Rating-gating — asking how happy someone is, then routing the happy ones to
 * Google and quietly diverting the unhappy ones into a private complaints box —
 * violates Google's and Trustpilot's policies and is the single most common
 * dark pattern in this category. `docs/02-prd.md` R2 requires that no such
 * option exists in the UI.
 *
 * So: `resolveDestination` takes a campaign and nothing else. It cannot see a
 * rating, a sentiment, or a submission, because it is never given one. A future
 * change that tried to gate on rating would have to add a parameter here, which
 * is exactly the kind of edit that a reviewer notices and a test rejects.
 */

export type CampaignRoute = { kind: "firstparty"; url: string } | { kind: "external"; url: string };

export type RoutableCampaign = {
  slug: string;
  destination: CampaignDestination;
  destinationUrl: string | null;
};

export function resolveDestination(campaign: RoutableCampaign, baseUrl: string): CampaignRoute {
  if (campaign.destination === "external" && campaign.destinationUrl) {
    return { kind: "external", url: campaign.destinationUrl };
  }

  // Falls back to our own page when an external campaign somehow has no URL.
  // The database check constraint makes that unreachable; landing a customer
  // on a working page beats a 500 if it ever becomes reachable.
  return { kind: "firstparty", url: buildCampaignUrl(baseUrl, campaign.slug) };
}
