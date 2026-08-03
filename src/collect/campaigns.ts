import { and, desc, eq, sql } from "drizzle-orm";
import { connectSource } from "../connectors/sync.ts";
import { FIRST_PARTY_PROVIDER } from "../connectors/firstparty.ts";
import { schema } from "../db/client.ts";
import { isUniqueViolation } from "../db/errors.ts";
import type { Campaign, CampaignChannel } from "../db/schema.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { generateCampaignSlug } from "./tokens.ts";
import type { CreateCampaignInput } from "./input.ts";

/**
 * Campaigns — the tenant-scoped half of first-party collection.
 *
 * Everything here takes a `TenantDatabase`, which only ever exists inside
 * `withTenant()`. The unauthenticated counterpart, which has to find a tenant
 * before it can scope to one, is deliberately quarantined in ./public.ts.
 */

/**
 * A location must have a first-party connection before it can receive
 * submissions: the connection is what carries `locationId` into `normalize()`,
 * and what makes the source visible in the UI beside Google and Instagram.
 *
 * Idempotent — `connectSource` upserts on (location, provider), so calling it
 * for every new campaign is free.
 */
export async function ensureFirstPartyConnection(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
): Promise<string> {
  const connection = await connectSource(tx, {
    organizationId,
    provider: FIRST_PARTY_PROVIDER,
    config: { locationId },
  });

  return connection.id;
}

/** How many times to redraw a slug before admitting something is wrong. */
const SLUG_ATTEMPTS = 5;

export type CreateCampaignArgs = {
  organizationId: string;
  actorUserId: string | null;
  input: CreateCampaignInput;
};

export async function createCampaign(
  tx: TenantDatabase,
  { organizationId, actorUserId, input }: CreateCampaignArgs,
): Promise<Campaign> {
  await ensureFirstPartyConnection(tx, organizationId, input.locationId);

  const message = {
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.body ? { body: input.body } : {}),
  };

  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt += 1) {
    // Nested transaction = SAVEPOINT. Without it a duplicate-slug insert would
    // abort the whole tenant transaction and there would be nothing left to
    // retry inside.
    try {
      const row = await tx.transaction(async (savepoint) => {
        const [created] = await savepoint
          .insert(schema.campaigns)
          .values({
            organizationId,
            locationId: input.locationId,
            name: input.name,
            channel: input.channel,
            destination: input.destination,
            destinationUrl: input.destinationUrl,
            slug: generateCampaignSlug(input.name),
            locale: input.locale ?? null,
            // Created active: a campaign nobody can submit to is not a useful
            // default, and archiving is one click.
            status: "active",
            message,
          })
          .returning();

        if (!created) throw new Error("Could not create the campaign.");
        return created;
      });

      await tx.insert(schema.auditLogs).values({
        organizationId,
        actorUserId,
        action: "campaign.created",
        entity: `campaign:${row.id}`,
        meta: { slug: row.slug, channel: row.channel, destination: row.destination },
      });

      return row;
    } catch (error) {
      // Only a slug collision is worth another draw; anything else is a real
      // failure and must not be retried into a storm.
      if (isUniqueViolation(error) && attempt < SLUG_ATTEMPTS) continue;
      throw error;
    }
  }

  throw new Error("Could not allocate a unique campaign link. Please try again.");
}

export type CampaignFunnel = {
  /** Asks that went out. Always 0 for a link/QR campaign — nothing is sent. */
  sent: number;
  opened: number;
  submitted: number;
};

export type CampaignWithFunnel = Campaign & { funnel: CampaignFunnel; locationName: string };

/** Campaigns for the organization, newest first, each with its conversion funnel. */
export async function listCampaigns(
  tx: TenantDatabase,
  organizationId: string,
  locationId?: string,
): Promise<CampaignWithFunnel[]> {
  const rows = await tx
    .select({ campaign: schema.campaigns, locationName: schema.locations.name })
    .from(schema.campaigns)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.campaigns.locationId))
    .where(
      locationId
        ? and(
            eq(schema.campaigns.organizationId, organizationId),
            eq(schema.campaigns.locationId, locationId),
          )
        : eq(schema.campaigns.organizationId, organizationId),
    )
    .orderBy(desc(schema.campaigns.createdAt));

  if (rows.length === 0) return [];

  // Counted in a second query rather than a join: an aggregate over
  // review_requests joined to campaigns would multiply rows per campaign and
  // needs a subquery to be correct anyway.
  const counts = await tx
    .select({
      campaignId: schema.reviewRequests.campaignId,
      sent: sql<number>`count(*) filter (where ${schema.reviewRequests.sentAt} is not null)`.mapWith(
        Number,
      ),
      opened:
        sql<number>`count(*) filter (where ${schema.reviewRequests.openedAt} is not null)`.mapWith(
          Number,
        ),
      submitted:
        sql<number>`count(*) filter (where ${schema.reviewRequests.submittedAt} is not null)`.mapWith(
          Number,
        ),
    })
    .from(schema.reviewRequests)
    .where(eq(schema.reviewRequests.organizationId, organizationId))
    .groupBy(schema.reviewRequests.campaignId);

  const byCampaign = new Map(counts.map((row) => [row.campaignId, row]));

  return rows.map(({ campaign, locationName }) => {
    const funnel = byCampaign.get(campaign.id);
    return {
      ...campaign,
      locationName,
      funnel: {
        sent: funnel?.sent ?? 0,
        opened: funnel?.opened ?? 0,
        submitted: funnel?.submitted ?? 0,
      },
    };
  });
}

export async function getCampaign(
  tx: TenantDatabase,
  organizationId: string,
  campaignId: string,
): Promise<Campaign | null> {
  const [row] = await tx
    .select()
    .from(schema.campaigns)
    .where(
      and(eq(schema.campaigns.organizationId, organizationId), eq(schema.campaigns.id, campaignId)),
    )
    .limit(1);

  return row ?? null;
}

export type RecentRequest = {
  id: string;
  campaignName: string;
  channel: CampaignChannel;
  status: string;
  recipient: string | null;
  sentAt: Date | null;
  openedAt: Date | null;
  submittedAt: Date | null;
  createdAt: Date;
};

/** The funnel, request by request — what the Requests page lists. */
export async function listRecentRequests(
  tx: TenantDatabase,
  organizationId: string,
  limit = 50,
): Promise<RecentRequest[]> {
  return tx
    .select({
      id: schema.reviewRequests.id,
      campaignName: schema.campaigns.name,
      channel: schema.reviewRequests.channel,
      status: schema.reviewRequests.status,
      recipient: schema.contacts.email,
      sentAt: schema.reviewRequests.sentAt,
      openedAt: schema.reviewRequests.openedAt,
      submittedAt: schema.reviewRequests.submittedAt,
      createdAt: schema.reviewRequests.createdAt,
    })
    .from(schema.reviewRequests)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.reviewRequests.campaignId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.reviewRequests.contactId))
    .where(eq(schema.reviewRequests.organizationId, organizationId))
    .orderBy(desc(schema.reviewRequests.createdAt))
    .limit(limit);
}
