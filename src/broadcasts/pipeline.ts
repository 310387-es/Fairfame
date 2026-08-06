import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { resolveScopeForUser, UNRESTRICTED, type LocationScope } from "../auth/scope.ts";
import { checkSendAllowed, type GateRefusal } from "../compliance/gate.ts";
import {
  deliverRequests,
  prepareRequests,
  recordDelivery,
  type PreparedRequest,
} from "../collect/requests.ts";
import { getAdminDb } from "../db/client.ts";
import { getEnv } from "../lib/env.ts";
import { can, recordUsage, withinLimit, type MetricKey } from "../lib/entitlements.ts";
import { childLogger } from "../lib/logger.ts";
import { publicBaseUrl } from "../lib/urls.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { sendMessage } from "../messaging/outbound.ts";
import { deliverInvites, prepareInvites } from "../surveys/send.ts";
import { audienceFilters, resolveAudience, type AudienceContact } from "./audience.ts";
import { recordInviteDelivery } from "../surveys/send.ts";
import type { TemplateName } from "../connectors/whatsapp/templates.ts";

/**
 * Running a broadcast (P4-T4).
 *
 * **Nothing here re-implements a send.** Each kind is dispatched through the
 * function that already owns it — `prepareRequests`/`deliverRequests` for
 * review requests, `prepareInvites`/`deliverInvites` for surveys, `sendMessage`
 * for messages — so a broadcast cannot acquire its own idea of what an email
 * says, what a template renders to, or which permissions a channel needs.
 *
 * **The compliance gate runs here as well, and that is deliberate.** Surveys
 * and messages gate inside their own transports; review requests, sent directly
 * from `/get-reviews` since P1b-T1, do not. Rather than change Phase 1's behaviour
 * — which would stop review requests sending in every environment without an
 * İYS registry — a broadcast gates **every** recipient of **every** kind before
 * dispatching. So `docs/20`'s "İYS-compliant" holds for the unified send even
 * where the direct one predates the rule, and for surveys and messages the
 * inner gate agrees a second time, which is defence in depth rather than
 * duplication.
 *
 * Three phases, as `collect/requests.ts` established: rows in one transaction,
 * network sends outside any transaction, outcomes written back in a second.
 */

const log = childLogger({ module: "broadcasts/pipeline" });

export type BroadcastOutcome = {
  broadcastId: string;
  audience: number;
  sent: number;
  refused: number;
  failed: number;
  /** Refusals tallied by the gate's own reason. */
  refusals: Record<string, number>;
  /** Set when the whole send was abandoned rather than partly delivered. */
  abandoned?: string;
};

/**
 * Which allowance a send spends.
 *
 * Metered per *channel*, because that is what actually costs money — an SMS
 * costs an SMS whatever it says. Email surveys are deliberately unmetered
 * (P4-T2's decision: `requests_per_month` is the review-request allowance and
 * spending it on surveys would take away something bought for another purpose).
 *
 * **A review request on WhatsApp or SMS is charged twice, to two different
 * meters, and that is deliberate** (W2.2). `recordDelivery` has charged
 * `requests_per_month` since P1b-T1 and now does so whatever the channel, while
 * this adds the channel's own cost. They measure different things: one is "how
 * many customers may this plan ask", the other is "how many conversations has
 * it paid for". Charging only the channel meter would let ten thousand WhatsApp
 * requests slip past the review-request allowance entirely.
 */
export function meterFor(
  kind: "review_request" | "survey" | "message",
  channel: string,
): MetricKey | null {
  if (channel === "sms") return "sms_credits";
  if (channel === "whatsapp") return "whatsapp_conversations";
  // Email review requests are metered by `prepareRequests`; nothing else on
  // email is metered at all.
  return kind === "review_request" ? "requests_per_month" : null;
}

type Claimed = {
  id: string;
  organizationId: string;
  kind: "review_request" | "survey" | "message";
  channel: string;
  audience: unknown;
  campaignId: string | null;
  surveyId: string | null;
  templateName: string | null;
  templateValues: unknown;
  createdByUserId: string | null;
};

/**
 * Claims a broadcast for this run, or returns null.
 *
 * The claim *is* the lock: the status transition happens in one statement with
 * the old status in the WHERE clause, so two sweeps racing produce one winner
 * and one null. Nothing else in this file needs to worry about concurrency.
 */
async function claim(
  tx: TenantDatabase,
  organizationId: string,
  broadcastId: string,
  now: Date,
): Promise<Claimed | null> {
  const [row] = await tx
    .update(schema.broadcasts)
    .set({ status: "sending", startedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.broadcasts.organizationId, organizationId),
        eq(schema.broadcasts.id, broadcastId),
        inArray(schema.broadcasts.status, ["draft", "scheduled"]),
      ),
    )
    .returning({
      id: schema.broadcasts.id,
      organizationId: schema.broadcasts.organizationId,
      kind: schema.broadcasts.kind,
      channel: schema.broadcasts.channel,
      audience: schema.broadcasts.audience,
      campaignId: schema.broadcasts.campaignId,
      surveyId: schema.broadcasts.surveyId,
      templateName: schema.broadcasts.templateName,
      templateValues: schema.broadcasts.templateValues,
      createdByUserId: schema.broadcasts.createdByUserId,
    });

  return row ?? null;
}

/**
 * The scope this broadcast's audience is resolved under.
 *
 * The creator's, at send time — the P3-T5 rule. A creator who has left the
 * organization stops the send entirely rather than falling back to
 * unrestricted, because "the person who set this up is gone" is not a reason to
 * widen an audience.
 */
async function creatorScope(
  tx: TenantDatabase,
  organizationId: string,
  userId: string | null,
): Promise<LocationScope | null> {
  // No creator recorded at all — a broadcast made by the system. Unrestricted
  // is correct there: nobody's scope is being inherited.
  if (!userId) return UNRESTRICTED;
  return resolveScopeForUser(tx, organizationId, userId);
}

async function abandon(
  organizationId: string,
  broadcastId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await withTenant({ organizationId }, (tx) =>
    tx
      .update(schema.broadcasts)
      .set({ status: "cancelled", failureReason: reason, finishedAt: now, updatedAt: now })
      .where(eq(schema.broadcasts.id, broadcastId)),
  );
}

export async function runBroadcast(
  organizationId: string,
  broadcastId: string,
  now = new Date(),
): Promise<BroadcastOutcome> {
  const empty: BroadcastOutcome = {
    broadcastId,
    audience: 0,
    sent: 0,
    refused: 0,
    failed: 0,
    refusals: {},
  };

  // ---- Phase 1: claim, resolve the audience, decide who may be messaged ----

  const prepared = await withTenant({ organizationId }, async (tx) => {
    const broadcast = await claim(tx, organizationId, broadcastId, now);
    if (!broadcast) return null;

    /**
     * The plan, checked **at send time** and not only when the broadcast was
     * created (P4-T6).
     *
     * A broadcast can be scheduled weeks ahead, and a subscription can lapse in
     * between. Without this, a downgrade would keep firing sends the account no
     * longer pays for — the same failure P3-T5 avoided by checking scheduled
     * reports on save *and* on send, and the reason that rule is worth
     * repeating: anything with a delay between the decision and the act needs
     * the entitlement asked twice.
     */
    if (!(await can({ organizationId, tx }, "broadcasts"))) {
      return { broadcast, abandoned: "Broadcasts are no longer included in this plan." };
    }

    const scope = await creatorScope(tx, organizationId, broadcast.createdByUserId);
    if (!scope) {
      return { broadcast, abandoned: "The person who created this broadcast has left the team." };
    }

    const contacts = await resolveAudience({
      tx,
      organizationId,
      scope,
      filters: audienceFilters(broadcast.audience),
      channel: broadcast.channel as "email" | "sms" | "whatsapp" | "link",
    });

    if (contacts.length === 0) {
      return { broadcast, abandoned: "Nobody in this audience can be reached on that channel." };
    }

    // The plan's allowance, checked once against the whole audience before a
    // single message goes out. Half-sending a campaign and then stopping at the
    // limit is the outcome nobody wants to explain.
    const metric = meterFor(broadcast.kind, broadcast.channel);
    if (metric && metric !== "requests_per_month") {
      const check = await withinLimit({ organizationId, tx }, metric, {
        additional: contacts.length,
      });
      if (!check.allowed) {
        return {
          broadcast,
          abandoned: `This send needs ${contacts.length} ${metric.replace(/_/g, " ")}; ${check.remaining ?? 0} remain.`,
        };
      }
    }

    // Every recipient, through the gate, before anything is dispatched.
    const env = getEnv();
    const allowed: AudienceContact[] = [];
    const refused: { contact: AudienceContact; reason: GateRefusal }[] = [];

    for (const contact of contacts) {
      const decision = await checkSendAllowed(
        {
          tx,
          organizationId,
          contactId: contact.id,
          // A broadcast is business-initiated by definition. There is no
          // audience of people who all happen to have written to us in the last
          // 24 hours, and calling one a service message would be the exemption
          // argument the gate exists to refuse.
          intent: "commercial",
          channel:
            broadcast.channel === "email" ? "email" : (broadcast.channel as "sms" | "whatsapp"),
          now,
        },
        env,
      );

      if (decision.allowed) allowed.push(contact);
      else refused.push({ contact, reason: decision.reason });
    }

    // The audience snapshot, written before anything is sent so a crash
    // mid-send leaves a record of who was considered.
    await tx
      .insert(schema.broadcastRecipients)
      .values(
        contacts.map((contact) => {
          const refusal = refused.find((entry) => entry.contact.id === contact.id);
          return {
            organizationId,
            broadcastId,
            contactId: contact.id,
            status: refusal ? ("refused" as const) : ("pending" as const),
            refusalReason: refusal ? refusal.reason : null,
          };
        }),
      )
      .onConflictDoNothing();

    return { broadcast, contacts, allowed, refused };
  });

  if (!prepared) {
    // Already running, already sent, or cancelled. Not an error — this is what
    // the claim is for.
    log.info({ organizationId, broadcastId }, "Broadcast was not claimable");
    return empty;
  }

  if ("abandoned" in prepared && prepared.abandoned) {
    await abandon(organizationId, broadcastId, prepared.abandoned, now);
    return { ...empty, abandoned: prepared.abandoned };
  }

  const {
    broadcast,
    contacts = [],
    allowed = [],
    refused = [],
  } = prepared as {
    broadcast: Claimed;
    contacts?: AudienceContact[];
    allowed?: AudienceContact[];
    refused?: { contact: AudienceContact; reason: GateRefusal }[];
  };

  const refusals = refused.reduce<Record<string, number>>((tally, entry) => {
    tally[entry.reason] = (tally[entry.reason] ?? 0) + 1;
    return tally;
  }, {});

  // ---- Phases 2 and 3: dispatch, then write the outcomes back -------------

  /**
   * A throw here used to strand the broadcast (found by running it, P4-T4).
   *
   * The claim in phase 1 has already committed, so an exception escaping
   * dispatch left `status = 'sending'` forever: unclaimable by the next sweep,
   * unsendable by the button, and with no reason on the screen. The audience
   * snapshot is deliberately kept — those rows are the record of who was
   * considered, and deleting them would erase the evidence of what a partly
   * completed send actually did.
   */
  let results: DispatchResult[];
  try {
    results = await dispatch(organizationId, broadcast, allowed, now);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The send could not be started.";
    await abandon(organizationId, broadcastId, reason, now);
    log.error({ organizationId, broadcastId, err: error }, "Broadcast dispatch failed");
    return {
      ...empty,
      audience: contacts.length,
      refused: refused.length,
      refusals,
      abandoned: reason,
    };
  }

  const counts = await withTenant({ organizationId }, async (tx) => {
    let sent = 0;
    let failed = 0;

    for (const result of results) {
      await tx
        .update(schema.broadcastRecipients)
        .set({
          status: result.ok ? "sent" : "failed",
          refusalReason: result.ok ? null : result.reason.slice(0, 300),
          reviewRequestId: result.ok ? (result.reviewRequestId ?? null) : null,
          surveyResponseId: result.ok ? (result.surveyResponseId ?? null) : null,
          messageId: result.ok ? (result.messageId ?? null) : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.broadcastRecipients.broadcastId, broadcastId),
            eq(schema.broadcastRecipients.contactId, result.contactId),
          ),
        );

      if (result.ok) sent += 1;
      else failed += 1;
    }

    // Metered on delivery, not on intent — the P1b-T1 rule. A message that
    // failed to leave the building must not consume the customer's allowance.
    const metric = meterFor(broadcast.kind, broadcast.channel);
    if (metric && metric !== "requests_per_month" && sent > 0) {
      await recordUsage({ organizationId, tx }, metric, sent, now);
    }

    await tx
      .update(schema.broadcasts)
      .set({ status: "sent", finishedAt: now, updatedAt: now })
      .where(eq(schema.broadcasts.id, broadcastId));

    await tx.insert(schema.auditLogs).values({
      organizationId,
      actorUserId: broadcast.createdByUserId,
      action: "broadcast.sent",
      entity: `broadcast:${broadcastId}`,
      meta: { kind: broadcast.kind, channel: broadcast.channel, sent, failed, refusals },
    });

    return { sent, failed };
  });

  log.info(
    { organizationId, broadcastId, audience: contacts.length, ...counts, refused: refused.length },
    "Broadcast finished",
  );

  return {
    broadcastId,
    audience: contacts.length,
    sent: counts.sent,
    failed: counts.failed,
    refused: refused.length,
    refusals,
  };
}

type DispatchResult =
  | {
      contactId: string;
      ok: true;
      reviewRequestId?: string;
      surveyResponseId?: string;
      messageId?: string;
    }
  | { contactId: string; ok: false; reason: string };

async function dispatch(
  organizationId: string,
  broadcast: Claimed,
  allowed: AudienceContact[],
  now: Date,
): Promise<DispatchResult[]> {
  if (allowed.length === 0) return [];

  if (broadcast.kind === "message") {
    // Per contact, because a message is: `sendMessage` gates, sends and records
    // one at a time, and there is no bulk shape underneath it to reuse.
    const results: DispatchResult[] = [];

    for (const contact of allowed) {
      const outcome = await withTenant({ organizationId }, (tx) =>
        sendMessage({
          tx,
          organizationId,
          contactId: contact.id,
          channel: broadcast.channel === "sms" ? "sms" : "whatsapp",
          request: {
            kind: "template",
            template: broadcast.templateName as TemplateName,
            values: Array.isArray(broadcast.templateValues)
              ? (broadcast.templateValues as string[])
              : [],
          },
          sentByUserId: broadcast.createdByUserId,
          now,
        }),
      );

      results.push(
        outcome.ok
          ? { contactId: contact.id, ok: true, messageId: outcome.messageId }
          : { contactId: contact.id, ok: false, reason: outcome.reason },
      );
    }

    return results;
  }

  const recipients = allowed
    .filter((contact): contact is AudienceContact & { email: string } => Boolean(contact.email))
    .map((contact) => ({ email: contact.email, name: contact.name }));

  const byEmail = new Map(allowed.map((contact) => [contact.email, contact.id]));

  if (broadcast.kind === "survey") {
    const { prepared, refused, context } = await withTenant({ organizationId }, (tx) =>
      prepareInvites(tx, {
        organizationId,
        surveyId: broadcast.surveyId as string,
        recipients,
        now,
      }),
    );

    const delivered = prepared.length > 0 ? await deliverInvites(prepared, context) : [];
    await withTenant({ organizationId }, (tx) =>
      recordInviteDelivery(tx, organizationId, delivered, now),
    );

    const results: DispatchResult[] = [];

    for (const result of delivered) {
      const contactId = byEmail.get(result.email);
      if (!contactId) continue;

      if (result.ok) {
        const invite = prepared.find((entry) => entry.email === result.email);
        results.push({
          contactId,
          ok: true,
          ...(invite ? { surveyResponseId: invite.responseId } : {}),
        });
      } else {
        results.push({ contactId, ok: false, reason: result.reason });
      }
    }

    // The inner gate refusing after the outer one allowed would be a genuine
    // disagreement between two checks of the same rule, so it is reported
    // rather than swallowed.
    for (const entry of refused) {
      const contactId = byEmail.get(entry.email);
      if (contactId) results.push({ contactId, ok: false, reason: entry.detail });
    }

    return results;
  }

  /**
   * A review request now goes out on whichever channel the broadcast names
   * (W2.2), and the two are addressed differently.
   *
   * **Email** may reach somebody we have never held, so the address is enough.
   * **WhatsApp and SMS** cannot: consent is recorded against a person, so the
   * recipient is the contact id and the gate is answerable. The audience is
   * already a list of contacts either way — this only decides which of their
   * fields identifies them.
   */
  const requestRecipients =
    broadcast.channel === "email"
      ? recipients
      : allowed.map((contact) => ({ contactId: contact.id, name: contact.name }));

  const { prepared, context } = await withTenant({ organizationId }, (tx) =>
    prepareRequests(tx, {
      organizationId,
      campaignId: broadcast.campaignId as string,
      recipients: requestRecipients,
    }),
  );

  /**
   * A phone send needs the transaction; an email send must not hold one.
   *
   * `sendMessage` reads the consent record and the conversation window and
   * writes the message log, none of which can be done outside a tenant context
   * — while holding a transaction across a batch of SMTP round trips pins a
   * pooled connection. The same split `sendReviewRequests` makes.
   */
  const delivered =
    prepared.length === 0
      ? []
      : broadcast.channel === "email"
        ? await deliverRequests(prepared, context)
        : await withTenant({ organizationId }, (tx) =>
            deliverRequests(prepared, context, publicBaseUrl(), { tx, organizationId }),
          );

  await withTenant({ organizationId }, (tx) => recordDelivery(tx, organizationId, delivered, now));

  /**
   * Correlated by **request id**, not by address.
   *
   * The old map was keyed on the email, which quietly assumed every recipient
   * had one — true while this was email-only and false the moment a WhatsApp
   * broadcast reaches somebody addressed by phone. `PreparedRequest` carries
   * the contact id, so the join no longer goes through a string that may not
   * exist.
   */
  const contactOfRequest = new Map(
    prepared.map((entry: PreparedRequest) => [entry.requestId, entry.contactId]),
  );

  const results: DispatchResult[] = [];

  /**
   * Everybody `prepareRequests` skipped, accounted for (W2.2).
   *
   * It skips a recipient with no address for the channel, and one who has
   * opted out, without creating a request row — correctly, since no row should
   * imply we meant to write. But that left them out of the broadcast's
   * arithmetic entirely: not sent, not failed, not refused, simply absent. A
   * WhatsApp broadcast over a segment collected by email reported an audience
   * of three and three of nothing, which is the least useful screen possible.
   */
  const attempted = new Set(prepared.map((entry: PreparedRequest) => entry.contactId));

  for (const contact of allowed) {
    if (attempted.has(contact.id)) continue;
    results.push({
      contactId: contact.id,
      ok: false,
      reason: "No address for this channel, or they have opted out.",
    });
  }

  for (const result of delivered) {
    const contactId = contactOfRequest.get(result.requestId);
    if (!contactId) continue;

    if (result.ok) {
      results.push({ contactId, ok: true, reviewRequestId: result.requestId });
    } else {
      results.push({ contactId, ok: false, reason: result.reason });
    }
  }

  return results;
}

/**
 * Every broadcast whose time has come (P4-T4).
 *
 * Cross-tenant by nature, exactly as the sync scan is: the sweep runs before
 * any tenant context exists, so it reads ids with the owner connection and then
 * re-enters `withTenant` per broadcast. A time in the past is sent now rather
 * than skipped — a worker that was down for an hour should catch up, not
 * silently drop an afternoon's campaigns.
 */
export async function runDueBroadcasts(now = new Date(), limit = 50): Promise<BroadcastOutcome[]> {
  const due = await getAdminDb()
    .select({ id: schema.broadcasts.id, organizationId: schema.broadcasts.organizationId })
    .from(schema.broadcasts)
    .where(
      and(
        eq(schema.broadcasts.status, "scheduled"),
        lte(schema.broadcasts.scheduledAt, now),
        sql`${schema.broadcasts.scheduledAt} is not null`,
      ),
    )
    .orderBy(schema.broadcasts.scheduledAt)
    .limit(limit);

  const outcomes: BroadcastOutcome[] = [];
  for (const row of due) {
    outcomes.push(await runBroadcast(row.organizationId, row.id, now));
  }

  return outcomes;
}
