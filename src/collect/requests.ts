import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n/config.ts";
import { recordUsage, requireWithinLimit } from "../lib/entitlements.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { publicBaseUrl, buildRequestUrl, buildUnsubscribeUrl } from "../lib/urls.ts";
import { REVIEW_REQUEST_TEMPLATE, type TemplateName } from "../connectors/whatsapp/templates.ts";
import { getEmailTransport } from "../messaging/email.ts";
import { sendMessage } from "../messaging/outbound.ts";
import { renderReviewRequestEmail } from "../messaging/templates.ts";
import { generateRequestToken } from "./tokens.ts";
import { isEmailRecipient, type RequestRecipient } from "./input.ts";

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
  /** How this one goes out. A single send is one channel, the campaign's. */
  channel: "email" | "whatsapp" | "sms";
  /** Always known: the gate and the message log are both keyed on the person. */
  contactId: string;
  /** The address, for the label a failure is reported under. */
  address: string;
  contactName: string | null;
  locale: Locale;
};

export type SkippedRecipient = {
  /** Whatever identifies them on screen — an address or a name. */
  label: string;
  reason: "unsubscribed" | "no_address";
};

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
  args: { organizationId: string; campaignId: string; recipients: RequestRecipient[] },
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

  const channel = campaign.campaign.channel;

  // `link` is the only channel with nothing to send: the customer arrives from
  // a QR code on their own. Every other channel now has a transport (W2.2), and
  // whether a message may actually leave is the gate's decision at send time,
  // with a named reason — not a list here saying "not built".
  if (channel === "link") {
    throw new SendNotAllowedError(
      "A QR/link campaign has nothing to send — share its link instead.",
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
    /**
     * Two ways in, and they are not symmetrical (W2.2).
     *
     * An **email** recipient may be somebody we have never heard of — a pasted
     * address, a CSV row — so the contact is created here. A **phone**
     * recipient is always somebody we already hold, because consent is recorded
     * against a person and `checkSendAllowed` is keyed on the contact id: a
     * messaging send that began with a raw number would have to mint a contact
     * before it could ask whether it was allowed to message them.
     */
    let contact: {
      id: string;
      name: string | null;
      locale: string | null;
      unsubscribedAt: Date | null;
      address: string | null;
    } | null = null;

    if (isEmailRecipient(recipient)) {
      const [row] = await tx
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
          address: schema.contacts.email,
        });

      contact = row ?? null;
    } else {
      const [row] = await tx
        .select({
          id: schema.contacts.id,
          name: schema.contacts.name,
          locale: schema.contacts.locale,
          unsubscribedAt: schema.contacts.unsubscribedAt,
          // **The campaign's channel decides the address, not how the recipient
          // was named.** Picking a contact is now the way to address an email
          // campaign too, and branching on the recipient shape instead read a
          // picked contact's *phone* for an email send — so somebody with an
          // address and no number was skipped as unreachable while their email
          // sat in the row being ignored.
          address: channel === "email" ? schema.contacts.email : schema.contacts.phone,
        })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.organizationId, args.organizationId),
            eq(schema.contacts.id, recipient.contactId),
          ),
        )
        .limit(1);

      contact = row ?? null;
    }

    if (!contact) throw new Error("Could not record the recipient.");

    // A contact with no number cannot be messaged, and that is a fact about the
    // record rather than a failure of the send. Reported as skipped, so the
    // screen can say which people were missing a number instead of showing a
    // row of identical transport errors.
    if (!contact.address) {
      skipped.push({ label: contact.name ?? "—", reason: "no_address" });
      continue;
    }

    // An opt-out is honoured before anything is queued, not at send time —
    // there should be no row implying we intended to message them.
    if (contact.unsubscribedAt !== null) {
      skipped.push({ label: contact.address, reason: "unsubscribed" });
      continue;
    }

    const [request] = await tx
      .insert(schema.reviewRequests)
      .values({
        organizationId: args.organizationId,
        campaignId: campaign.campaign.id,
        locationId: campaign.campaign.locationId,
        contactId: contact.id,
        channel,
        status: "pending",
        token: generateRequestToken(),
      })
      .returning({ id: schema.reviewRequests.id, token: schema.reviewRequests.token });

    if (!request) throw new Error("Could not create the review request.");

    prepared.push({
      requestId: request.id,
      token: request.token,
      channel,
      contactId: contact.id,
      address: contact.address,
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

/**
 * Phase 2 — the actual sends. No transaction is held while these run.
 *
 * **Except for the messaging channels, which need one** (W2.2). `sendMessage`
 * reads the consent record, the opt-out and the conversation window, and writes
 * the message log — all of which are database work, and none of which can be
 * done from outside a tenant context. So a phone send is handed the transaction
 * and an email send is not, and the difference is stated here rather than
 * hidden behind a uniform signature that would make one of them a lie.
 *
 * The email path is unchanged and still does **not** go through the gate. That
 * is a pre-existing gap, flagged in `CLAUDE.md` rather than closed here:
 * closing it would stop review-request email sending in every environment
 * without a registry, which is all of them. A *broadcast* gates every kind
 * (P4-T4), so the unified path is compliant even where the direct one is not.
 */
export async function deliverRequests(
  prepared: PreparedRequest[],
  context: SendContext,
  baseUrl = publicBaseUrl(),
  options: { tx?: TenantDatabase; organizationId?: string } = {},
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  const transport = getEmailTransport();

  for (const request of prepared) {
    if (request.channel === "email") {
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
        to: request.address,
        subject: email.subject,
        text: email.text,
        html: email.html,
        listUnsubscribeUrl: buildUnsubscribeUrl(baseUrl, request.token),
      });

      results.push(
        result.ok
          ? { requestId: request.requestId, email: request.address, ok: true }
          : {
              requestId: request.requestId,
              email: request.address,
              ok: false,
              reason: result.reason,
            },
      );
      continue;
    }

    if (!options.tx || !options.organizationId) {
      // A caller that routed a phone send without a transaction has a bug, and
      // saying so beats a message that silently never goes.
      results.push({
        requestId: request.requestId,
        email: request.address,
        ok: false,
        reason: "A messaging send needs a tenant transaction.",
      });
      continue;
    }

    /**
     * Through `sendMessage`, which is the only thing that may let a message
     * leave — never through a transport directly.
     *
     * A **template**, not free text, and the caller does not get to say so:
     * `intentFor` derives the basis from the channel and the content, so a
     * business-initiated review request is `commercial` and needs a registered
     * permission. A campaign's copy overrides are deliberately *not* applied
     * here — a WhatsApp template is pre-approved by Meta word for word, and
     * substituting an owner's own text would send something that was never
     * approved.
     */
    const outcome = await sendMessage({
      tx: options.tx,
      organizationId: options.organizationId,
      contactId: request.contactId,
      channel: request.channel,
      request: {
        kind: "template",
        template: REVIEW_REQUEST_TEMPLATE.name as TemplateName,
        values: [
          request.contactName ?? context.locationName,
          context.locationName,
          buildRequestUrl(baseUrl, request.token),
        ],
      },
    });

    results.push(
      outcome.ok
        ? { requestId: request.requestId, email: request.address, ok: true }
        : {
            requestId: request.requestId,
            email: request.address,
            ok: false,
            // The gate's own words. "Bu kişi için kayıtlı izin yok" is a
            // different problem from "the number was unreachable", and only one
            // of them is the operator's to fix.
            reason: outcome.reason,
          },
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
  recipients: RequestRecipient[];
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

  /**
   * Email sends run outside any transaction, as they always have — holding one
   * across two hundred SMTP round trips pins a pooled connection and makes a
   * slow mail server look like a database outage.
   *
   * A messaging send cannot: `sendMessage` reads the consent record and the
   * conversation window and writes the message log, all of which need a tenant
   * context. So the two are dispatched separately rather than one shape being
   * bent to fit the other, and the phone batch is the only thing that holds a
   * transaction open (W2.2).
   */
  const emails = prepared.filter((request) => request.channel === "email");
  const messages = prepared.filter((request) => request.channel !== "email");

  const results = [
    ...(emails.length > 0 ? await deliverRequests(emails, context) : []),
    ...(messages.length > 0
      ? await withTenant(
          {
            organizationId: args.organizationId,
            ...(args.actorUserId ? { userId: args.actorUserId } : {}),
          },
          (tx) =>
            deliverRequests(messages, context, publicBaseUrl(), {
              tx,
              organizationId: args.organizationId,
            }),
        )
      : []),
  ];

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
