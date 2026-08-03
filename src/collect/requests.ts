import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n/config.ts";
import { recordUsage, requireWithinLimit } from "../lib/entitlements.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { publicBaseUrl, buildRequestUrl, buildUnsubscribeUrl } from "../lib/urls.ts";
import { getEmailTransport } from "../messaging/email.ts";
import { renderReviewRequestEmail } from "../messaging/templates.ts";
import { generateRequestToken } from "./tokens.ts";
import type { Recipient } from "./input.ts";

/**
 * Sending review requests, and tracking what becomes of them.
 *
 * Structured as three phases on purpose: rows are created in one transaction,
 * the network sends happen outside any transaction, and the outcomes are
 * written back in a second one. Holding a Postgres transaction open across two
 * hundred SMTP round trips would pin a pooled connection for the duration and
 * make a slow mail server look like a database outage.
 *
 * The plan's channel scope for T1 is email. `link` campaigns send nothing (the
 * customer arrives via QR), and SMS/WhatsApp are refused until their connectors
 * and the İYS consent gate exist — see P1b-T3 and T5.
 */

const log = childLogger({ module: "collect/requests" });

export class SendNotAllowedError extends Error {
  readonly reason: "channel" | "status";

  constructor(message: string, reason: "channel" | "status") {
    super(message);
    this.name = "SendNotAllowedError";
    this.reason = reason;
  }
}

export type PreparedRequest = {
  requestId: string;
  token: string;
  email: string;
  contactName: string | null;
  locale: Locale;
};

export type SkippedRecipient = { email: string; reason: "unsubscribed" };

export type SendContext = {
  organizationName: string;
  locationName: string;
  subjectOverride: string | undefined;
  bodyOverride: string | undefined;
};

export type SendOutcome = {
  sent: number;
  failed: number;
  skipped: SkippedRecipient[];
  /** Addresses that came back permanently undeliverable, for the UI to show. */
  failures: { email: string; reason: string }[];
};

/** Campaign copy overrides live in a jsonb blob, so validate before trusting. */
function readOverrides(message: unknown): { subject?: string; body?: string } {
  if (typeof message !== "object" || message === null) return {};
  const record = message as Record<string, unknown>;
  return {
    ...(typeof record.subject === "string" ? { subject: record.subject } : {}),
    ...(typeof record.body === "string" ? { body: record.body } : {}),
  };
}

/**
 * The recipient's language: the campaign's choice, then the location's, then
 * the organization's, then the launch-market default. A customer should not be
 * emailed in English because an admin happened to be viewing the dashboard in
 * English.
 */
function resolveLocale(...candidates: (string | null | undefined)[]): Locale {
  for (const candidate of candidates) {
    if (isLocale(candidate ?? undefined)) return candidate as Locale;
  }
  return DEFAULT_LOCALE;
}

/**
 * Phase 1 — contacts and request rows, inside the tenant transaction.
 *
 * The plan limit is checked here, against live counters, in the same
 * transaction that creates the rows: two concurrent sends cannot both squeeze
 * past the last remaining allowance.
 */
export async function prepareRequests(
  tx: TenantDatabase,
  args: { organizationId: string; campaignId: string; recipients: Recipient[] },
): Promise<{ prepared: PreparedRequest[]; skipped: SkippedRecipient[]; context: SendContext }> {
  const [campaign] = await tx
    .select({
      campaign: schema.campaigns,
      locationName: schema.locations.name,
      locationLocale: schema.locations.locale,
      organizationName: schema.organizations.name,
      organizationLocale: schema.organizations.locale,
    })
    .from(schema.campaigns)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.campaigns.locationId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.campaigns.organizationId))
    .where(
      and(
        eq(schema.campaigns.organizationId, args.organizationId),
        eq(schema.campaigns.id, args.campaignId),
      ),
    )
    .limit(1);

  if (!campaign) throw new SendNotAllowedError("That campaign does not exist.", "status");

  if (campaign.campaign.channel !== "email") {
    throw new SendNotAllowedError(
      campaign.campaign.channel === "link"
        ? "A QR/link campaign has nothing to send — share its link instead."
        : `Sending on "${campaign.campaign.channel}" needs its connector and the İYS consent gate (P1b-T3/T5).`,
      "channel",
    );
  }

  if (campaign.campaign.status !== "active") {
    throw new SendNotAllowedError("That campaign is not active.", "status");
  }

  await requireWithinLimit({ organizationId: args.organizationId, tx }, "requests_per_month", {
    additional: args.recipients.length,
  });

  const locale = resolveLocale(
    campaign.campaign.locale,
    campaign.locationLocale,
    campaign.organizationLocale,
  );

  const prepared: PreparedRequest[] = [];
  const skipped: SkippedRecipient[] = [];

  for (const recipient of args.recipients) {
    const [contact] = await tx
      .insert(schema.contacts)
      .values({
        organizationId: args.organizationId,
        email: recipient.email,
        name: recipient.name,
        locale,
      })
      .onConflictDoUpdate({
        target: [schema.contacts.organizationId, schema.contacts.email],
        set: {
          // Never overwrite a known name with nothing.
          name: sql`coalesce(excluded.name, ${schema.contacts.name})`,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: schema.contacts.id,
        name: schema.contacts.name,
        locale: schema.contacts.locale,
        unsubscribedAt: schema.contacts.unsubscribedAt,
      });

    if (!contact) throw new Error("Could not record the recipient.");

    // An opt-out is honoured before anything is queued, not at send time —
    // there should be no row implying we intended to message them.
    if (contact.unsubscribedAt !== null) {
      skipped.push({ email: recipient.email, reason: "unsubscribed" });
      continue;
    }

    const [request] = await tx
      .insert(schema.reviewRequests)
      .values({
        organizationId: args.organizationId,
        campaignId: campaign.campaign.id,
        locationId: campaign.campaign.locationId,
        contactId: contact.id,
        channel: "email",
        status: "pending",
        token: generateRequestToken(),
      })
      .returning({ id: schema.reviewRequests.id, token: schema.reviewRequests.token });

    if (!request) throw new Error("Could not create the review request.");

    prepared.push({
      requestId: request.id,
      token: request.token,
      email: recipient.email,
      contactName: recipient.name ?? contact.name,
      locale: resolveLocale(contact.locale, locale),
    });
  }

  const overrides = readOverrides(campaign.campaign.message);

  return {
    prepared,
    skipped,
    context: {
      organizationName: campaign.organizationName,
      locationName: campaign.locationName,
      subjectOverride: overrides.subject,
      bodyOverride: overrides.body,
    },
  };
}

export type DeliveryResult =
  | { requestId: string; email: string; ok: true }
  | { requestId: string; email: string; ok: false; reason: string };

/** Phase 2 — the actual sends. No transaction is held while these run. */
export async function deliverRequests(
  prepared: PreparedRequest[],
  context: SendContext,
  baseUrl = publicBaseUrl(),
): Promise<DeliveryResult[]> {
  const transport = getEmailTransport();
  const results: DeliveryResult[] = [];

  for (const request of prepared) {
    const email = renderReviewRequestEmail({
      locale: request.locale,
      contactName: request.contactName,
      businessName: context.organizationName,
      locationName: context.locationName,
      link: buildRequestUrl(baseUrl, request.token),
      unsubscribeUrl: buildUnsubscribeUrl(baseUrl, request.token),
      overrides: { subject: context.subjectOverride, body: context.bodyOverride },
    });

    const result = await transport.send({
      to: request.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
      listUnsubscribeUrl: buildUnsubscribeUrl(baseUrl, request.token),
    });

    results.push(
      result.ok
        ? { requestId: request.requestId, email: request.email, ok: true }
        : { requestId: request.requestId, email: request.email, ok: false, reason: result.reason },
    );
  }

  return results;
}

/** Phase 3 — write the outcomes back and meter what actually went out. */
export async function recordDelivery(
  tx: TenantDatabase,
  organizationId: string,
  results: DeliveryResult[],
  now = new Date(),
): Promise<{ sent: number; failed: number }> {
  const sentIds = results.filter((result) => result.ok).map((result) => result.requestId);

  if (sentIds.length > 0) {
    await tx
      .update(schema.reviewRequests)
      .set({ status: "sent", sentAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.reviewRequests.organizationId, organizationId),
          inArray(schema.reviewRequests.id, sentIds),
        ),
      );
  }

  for (const result of results) {
    if (result.ok) continue;
    await tx
      .update(schema.reviewRequests)
      .set({ status: "failed", failureReason: result.reason.slice(0, 500), updatedAt: now })
      .where(
        and(
          eq(schema.reviewRequests.organizationId, organizationId),
          eq(schema.reviewRequests.id, result.requestId),
        ),
      );
  }

  // Metered on delivery, not on intent: a message that failed to leave the
  // building should not consume the customer's monthly allowance.
  if (sentIds.length > 0) {
    await recordUsage({ organizationId, tx }, "requests_per_month", sentIds.length, now);
  }

  return { sent: sentIds.length, failed: results.length - sentIds.length };
}

export type SendReviewRequestsArgs = {
  organizationId: string;
  actorUserId: string | null;
  campaignId: string;
  recipients: Recipient[];
};

/** The whole send, phases in order. Used by the server action and by tests. */
export async function sendReviewRequests(args: SendReviewRequestsArgs): Promise<SendOutcome> {
  const { prepared, skipped, context } = await withTenant(
    {
      organizationId: args.organizationId,
      ...(args.actorUserId ? { userId: args.actorUserId } : {}),
    },
    (tx) =>
      prepareRequests(tx, {
        organizationId: args.organizationId,
        campaignId: args.campaignId,
        recipients: args.recipients,
      }),
  );

  const results = prepared.length > 0 ? await deliverRequests(prepared, context) : [];

  const outcome = await withTenant(
    {
      organizationId: args.organizationId,
      ...(args.actorUserId ? { userId: args.actorUserId } : {}),
    },
    async (tx) => {
      const counts = await recordDelivery(tx, args.organizationId, results);

      await tx.insert(schema.auditLogs).values({
        organizationId: args.organizationId,
        actorUserId: args.actorUserId,
        action: "review_requests.sent",
        entity: `campaign:${args.campaignId}`,
        meta: { ...counts, skipped: skipped.length },
      });

      return counts;
    },
  );

  log.info(
    { organizationId: args.organizationId, campaignId: args.campaignId, ...outcome },
    "Review requests dispatched",
  );

  return {
    ...outcome,
    skipped,
    failures: results
      .filter((result): result is DeliveryResult & { ok: false } => !result.ok)
      .map((result) => ({ email: result.email, reason: result.reason })),
  };
}
