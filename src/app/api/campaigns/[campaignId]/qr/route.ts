import { z } from "zod";
import {
  ForbiddenError,
  NoActiveOrganizationError,
  UnauthenticatedError,
  withAuthenticatedTenant,
} from "@/auth/session";
import { getCampaign } from "@/collect/campaigns";
import { qrPng } from "@/lib/qr";
import { campaignUrl } from "@/lib/urls";

/**
 * Downloadable QR code for a campaign: /api/campaigns/{id}/qr.
 *
 * Authenticated and tenant-scoped even though the code it encodes is public —
 * the campaign id is not, and letting anyone enumerate ids to discover another
 * organization's campaigns would leak exactly what RLS exists to protect.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
): Promise<Response> {
  const { campaignId } = await params;

  if (!z.uuid().safeParse(campaignId).success) {
    return new Response("Not found", { status: 404 });
  }

  // A route handler has no layout to redirect it, so the auth failures that a
  // page would resolve by bouncing to /sign-in have to become status codes
  // here — otherwise they escape as an unhelpful 500.
  let campaign;
  try {
    campaign = await withAuthenticatedTenant(
      (tx, actor) => getCampaign(tx, actor.organizationId, campaignId),
      { minimumRole: "member" },
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError || error instanceof NoActiveOrganizationError) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (error instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
    throw error;
  }

  if (!campaign) return new Response("Not found", { status: 404 });

  const png = await qrPng(campaignUrl(campaign.slug));

  return new Response(new Uint8Array(png), {
    headers: {
      "content-type": "image/png",
      "content-disposition": `attachment; filename="${campaign.slug}-qr.png"`,
      // Private: the response is tenant data, and no shared cache should hold it.
      "cache-control": "private, max-age=3600",
    },
  });
}
