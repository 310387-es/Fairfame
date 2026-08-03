import { and, eq, sql } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";
import type { CampaignChannel, CampaignDestination, CampaignStatus } from "../db/schema.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant } from "../lib/tenancy.ts";
import { looksLikeSlug, looksLikeToken } from "./tokens.ts";

/**
 * The unauthenticated side of collection: a stranger holding a slug or a token.
 *
 * Every function here starts with the one lookup that *cannot* be tenant-scoped
 * — a QR code carries no session, so there is no organization to scope to until
 * the slug itself names one. That lookup uses the owner connection, exactly as
 * the job scheduler's cross-tenant scan does, and is confined to this file so
 * there is a single place to review it.
 *
 * The rules it follows:
 *   1. Read the minimum: enough to identify the tenant and render the page.
 *   2. Never accept a caller-supplied organization id — it always comes from
 *      the row the slug or token resolved to.
 *   3. Every subsequent write goes through `withTenant()`, so RLS still has the
 *      final say on which rows may be touched.
 */

const log = childLogger({ module: "collect/public" });

export type PublicCampaign = {
  organizationId: string;
  organizationName: string;
  campaignId: string;
  locationId: string;
  locationName: string;
  slug: string;
  channel: CampaignChannel;
  status: CampaignStatus;
  destination: CampaignDestination;
  destinationUrl: string | null;
  /** Campaign locale, falling back to the location's then the organization's. */
  locale: string | null;
  message: unknown;
};

const campaignColumns = {
  organizationId: schema.campaigns.organizationId,
  organizationName: schema.organizations.name,
  campaignId: schema.campaigns.id,
  locationId: schema.campaigns.locationId,
  locationName: schema.locations.name,
  slug: schema.campaigns.slug,
  channel: schema.campaigns.channel,
  status: schema.campaigns.status,
  destination: schema.campaigns.destination,
  destinationUrl: schema.campaigns.destinationUrl,
  locale: sql<
    string | null
  >`coalesce(${schema.campaigns.locale}, ${schema.locations.locale}, ${schema.organizations.locale})`,
  message: schema.campaigns.message,
};

/** The campaign behind a public slug, or null. */
export async function resolveCampaignBySlug(slug: string): Promise<PublicCampaign | null> {
  if (!looksLikeSlug(slug)) return null;

  const [row] = await getAdminDb()
    .select(campaignColumns)
    .from(schema.campaigns)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.campaigns.locationId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.campaigns.organizationId))
    .where(eq(schema.campaigns.slug, slug))
    .limit(1);

  return row ?? null;
}

export type PublicRequest = {
  campaign: PublicCampaign;
  requestId: string;
  contactId: string | null;
  contactName: string | null;
  submittedAt: Date | null;
};

/** The single ask behind a request token, or null. */
export async function resolveRequestByToken(token: string): Promise<PublicRequest | null> {
  if (!looksLikeToken(token)) return null;

  const [row] = await getAdminDb()
    .select({
      ...campaignColumns,
      requestId: schema.reviewRequests.id,
      contactId: schema.reviewRequests.contactId,
      contactName: schema.contacts.name,
      submittedAt: schema.reviewRequests.submittedAt,
    })
    .from(schema.reviewRequests)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.reviewRequests.campaignId))
    .innerJoin(schema.locations, eq(schema.locations.id, schema.campaigns.locationId))
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.reviewRequests.organizationId),
    )
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.reviewRequests.contactId))
    .where(eq(schema.reviewRequests.token, token))
    .limit(1);

  if (!row) return null;

  const { requestId, contactId, contactName, submittedAt, ...campaign } = row;
  return { campaign, requestId, contactId, contactName, submittedAt };
}

/**
 * Records that the customer opened their request.
 *
 * First touch only: `opened_at` is set once, and the status never travels
 * backwards from `submitted`. Reloading the link a week later must not undo a
 * conversion.
 */
export async function markRequestOpened(
  organizationId: string,
  requestId: string,
  now = new Date(),
): Promise<void> {
  try {
    await withTenant({ organizationId }, (tx) =>
      tx
        .update(schema.reviewRequests)
        .set({
          openedAt: sql`coalesce(${schema.reviewRequests.openedAt}, ${now})`,
          status: sql`case when ${schema.reviewRequests.status} in ('pending', 'sent')
                        then 'opened'::review_request_status
                        else ${schema.reviewRequests.status} end`,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.reviewRequests.organizationId, organizationId),
            eq(schema.reviewRequests.id, requestId),
          ),
        ),
    );
  } catch (error) {
    // Analytics must never stand between a customer and the page they asked
    // for; log it and let the redirect happen.
    log.warn({ organizationId, requestId, err: error }, "Could not record request open");
  }
}

export type UnsubscribeResult = { ok: boolean; email: string | null };

/**
 * Honours an opt-out from a link in a message we sent.
 *
 * Idempotent, and irreversible from here: `unsubscribed_at` is only ever set,
 * never cleared, so a second visit cannot re-subscribe anyone.
 */
export async function unsubscribeByToken(
  token: string,
  now = new Date(),
): Promise<UnsubscribeResult> {
  const request = await resolveRequestByToken(token);
  if (!request?.contactId) return { ok: false, email: null };

  const contactId = request.contactId;
  const organizationId = request.campaign.organizationId;

  return withTenant({ organizationId }, async (tx) => {
    const [contact] = await tx
      .update(schema.contacts)
      .set({
        unsubscribedAt: sql`coalesce(${schema.contacts.unsubscribedAt}, ${now})`,
        updatedAt: now,
      })
      .where(
        and(eq(schema.contacts.organizationId, organizationId), eq(schema.contacts.id, contactId)),
      )
      .returning({ email: schema.contacts.email });

    await tx.insert(schema.auditLogs).values({
      organizationId,
      // No actor: the customer is not a user of the product.
      actorUserId: null,
      action: "contact.unsubscribed",
      entity: `contact:${contactId}`,
      meta: { via: "email_link", campaignId: request.campaign.campaignId },
    });

    return { ok: contact !== undefined, email: contact?.email ?? null };
  });
}
