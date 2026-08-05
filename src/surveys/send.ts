import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { generateRequestToken } from "../collect/tokens.ts";
import { checkSendAllowed, describeRefusal, type GateRefusal } from "../compliance/gate.ts";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n/config.ts";
import { getEnv } from "../lib/env.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { buildSurveyUrl, buildUnsubscribeUrl, publicBaseUrl } from "../lib/urls.ts";
import { getEmailTransport } from "../messaging/email.ts";
import { renderSurveyInviteEmail } from "../messaging/templates.ts";
import type { Recipient } from "../collect/input.ts";
import type { SurveyType } from "./scoring.ts";

/**
 * Sending survey invitations (P4-T2).
 *
 * Three phases, exactly as `src/collect/requests.ts` does it and for the same
 * reason: rows in one transaction, network sends outside any transaction,
 * outcomes written back in a second. Holding a Postgres transaction open across
 * two hundred SMTP round trips pins a pooled connection and makes a slow mail
 * server look like a database outage.
 *
 * **What is new here is the gate.** `docs/20`'s first compliance rule is that
 * every outbound in this phase is a commercial message: İYS consent enforced
 * *before send*, opt-out honoured, sends without consent blocked. So every
 * recipient goes through `checkSendAllowed` individually, and a refusal is a
 * named reason carried back to the screen rather than a silent skip — the
 * difference between "they opted out" and "İYS is not wired up here" is the
 * difference between correct behaviour and a broken deployment, and only one of
 * them is something an operator can fix.
 *
 * A consequence worth stating plainly: with `IYS_REQUIRED=true` (the default)
 * and `IYS_GATEWAY=none` (also the default), **every survey send is refused**.
 * That is the intended behaviour before go-live, not a bug — see the long note
 * at the top of `src/compliance/gate.ts`. `IYS_GATEWAY=local` exercises the
 * path in development.
 */

const log = childLogger({ module: "surveys/send" });

export class SurveySendError extends Error {
  readonly reason: "channel" | "status";

  constructor(message: string, reason: "channel" | "status") {
    super(message);
    this.name = "SurveySendError";
    this.reason = reason;
  }
}

export type PreparedInvite = {
  responseId: string;
  token: string;
  email: string;
  contactName: string | null;
  locale: Locale;
};

/** A recipient the gate refused, and why. Shown, never swallowed. */
export type RefusedRecipient = { email: string; reason: GateRefusal; detail: string };

export type InviteContext = {
  organizationName: string;
  locationName: string;
  question: string | null;
  type: SurveyType;
  subjectOverride: string | undefined;
  bodyOverride: string | undefined;
};

export type SurveySendOutcome = {
  sent: number;
  failed: number;
  refused: RefusedRecipient[];
  failures: { email: string; reason: string }[];
};

function readOverrides(message: unknown): { subject?: string; body?: string } {
  if (typeof message !== "object" || message === null) return {};
  const record = message as Record<string, unknown>;
  return {
    ...(typeof record.subject === "string" ? { subject: record.subject } : {}),
    ...(typeof record.body === "string" ? { body: record.body } : {}),
  };
}

/** The survey's language, then the location's, then the organization's. */
function resolveLocale(...candidates: (string | null | undefined)[]): Locale {
  for (const candidate of candidates) {
    if (isLocale(candidate ?? undefined)) return candidate as Locale;
  }
  return DEFAULT_LOCALE;
}

/** Phase 1 — contacts, the consent gate, and rows, inside one transaction. */
export async function prepareInvites(
  tx: TenantDatabase,
  args: { organizationId: string; surveyId: string; recipients: Recipient[]; now?: Date },
): Promise<{ prepared: PreparedInvite[]; refused: RefusedRecipient[]; context: InviteContext }> {
  const now = args.now ?? new Date();

  const [survey] = await tx
    .select({
      survey: schema.surveys,
      locationName: schema.locations.name,
      locationLocale: schema.locations.locale,
      organizationName: schema.organizations.name,
      organizationLocale: schema.organizations.locale,
    })
    .from(schema.surveys)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.surveys.locationId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.surveys.organizationId))
    .where(
      and(
        eq(schema.surveys.organizationId, args.organizationId),
        eq(schema.surveys.id, args.surveyId),
      ),
    )
    .limit(1);

  if (!survey) throw new SurveySendError("That survey does not exist.", "status");
  if (survey.survey.status !== "active") {
    throw new SurveySendError("That survey is not active.", "status");
  }

  const locale = resolveLocale(
    survey.survey.locale,
    survey.locationLocale,
    survey.organizationLocale,
  );

  const env = getEnv();
  const prepared: PreparedInvite[] = [];
  const refused: RefusedRecipient[] = [];

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
          updatedAt: now,
        },
      })
      .returning({
        id: schema.contacts.id,
        name: schema.contacts.name,
        locale: schema.contacts.locale,
      });

    if (!contact) throw new Error("Could not record the recipient.");

    /**
     * The gate, per recipient, before any row implies we meant to message them.
     *
     * `commercial` rather than `service`: nobody started this conversation, and
     * the 24-hour service window exists for replies, not for asking a question
     * of our own. Calling a survey a service message would be exactly the
     * "this one is exempt" argument that ends in a fine.
     */
    const decision = await checkSendAllowed(
      {
        tx,
        organizationId: args.organizationId,
        contactId: contact.id,
        intent: "commercial",
        channel: "email",
        now,
      },
      env,
    );

    if (!decision.allowed) {
      refused.push({
        email: recipient.email,
        reason: decision.reason,
        detail: decision.detail ?? describeRefusal(decision.reason),
      });
      continue;
    }

    const [response] = await tx
      .insert(schema.surveyResponses)
      .values({
        organizationId: args.organizationId,
        surveyId: survey.survey.id,
        locationId: survey.survey.locationId,
        contactId: contact.id,
        channel: "email",
        status: "pending",
        token: generateRequestToken(),
      })
      .returning({ id: schema.surveyResponses.id, token: schema.surveyResponses.token });

    if (!response) throw new Error("Could not create the survey invitation.");

    prepared.push({
      responseId: response.id,
      token: response.token,
      email: recipient.email,
      contactName: recipient.name ?? contact.name,
      locale: resolveLocale(contact.locale, locale),
    });
  }

  const overrides = readOverrides(survey.survey.message);

  return {
    prepared,
    refused,
    context: {
      organizationName: survey.organizationName,
      locationName: survey.locationName,
      question: survey.survey.question,
      type: survey.survey.type,
      subjectOverride: overrides.subject,
      bodyOverride: overrides.body,
    },
  };
}

export type InviteResult =
  | { responseId: string; email: string; ok: true }
  | { responseId: string; email: string; ok: false; reason: string };

/** Phase 2 — the sends. No transaction is held while these run. */
export async function deliverInvites(
  prepared: PreparedInvite[],
  context: InviteContext,
  baseUrl = publicBaseUrl(),
): Promise<InviteResult[]> {
  const transport = getEmailTransport();
  const results: InviteResult[] = [];

  for (const invite of prepared) {
    const unsubscribeUrl = buildUnsubscribeUrl(baseUrl, invite.token);

    const email = renderSurveyInviteEmail({
      locale: invite.locale,
      contactName: invite.contactName,
      businessName: context.organizationName,
      locationName: context.locationName,
      type: context.type,
      question: context.question,
      link: buildSurveyUrl(baseUrl, invite.token),
      unsubscribeUrl,
      overrides: { subject: context.subjectOverride, body: context.bodyOverride },
    });

    const result = await transport.send({
      to: invite.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
      listUnsubscribeUrl: unsubscribeUrl,
    });

    results.push(
      result.ok
        ? { responseId: invite.responseId, email: invite.email, ok: true }
        : { responseId: invite.responseId, email: invite.email, ok: false, reason: result.reason },
    );
  }

  return results;
}

/** Phase 3 — write the outcomes back. */
export async function recordInviteDelivery(
  tx: TenantDatabase,
  organizationId: string,
  results: InviteResult[],
  now = new Date(),
): Promise<{ sent: number; failed: number }> {
  const sentIds = results.filter((result) => result.ok).map((result) => result.responseId);

  if (sentIds.length > 0) {
    await tx
      .update(schema.surveyResponses)
      .set({ status: "sent", sentAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.surveyResponses.organizationId, organizationId),
          inArray(schema.surveyResponses.id, sentIds),
        ),
      );
  }

  for (const result of results) {
    if (result.ok) continue;
    await tx
      .update(schema.surveyResponses)
      .set({ status: "failed", failureReason: result.reason.slice(0, 500), updatedAt: now })
      .where(
        and(
          eq(schema.surveyResponses.organizationId, organizationId),
          eq(schema.surveyResponses.id, result.responseId),
        ),
      );
  }

  return { sent: sentIds.length, failed: results.length - sentIds.length };
}

/**
 * The whole send.
 *
 * **Deliberately not metered.** `requests_per_month` is the review-request
 * allowance and spending it on surveys would take away something a business
 * bought for another purpose; a `surveys_per_month` key invented here would be
 * packaging nobody has decided. P4-T4 is where metering is in the DoD, and it
 * has `sms_credits` / `whatsapp_conversations` waiting for it. Until then the
 * effective bound is the gate: every recipient needs a registered permission.
 */
export async function sendSurveyInvites(args: {
  organizationId: string;
  actorUserId: string | null;
  surveyId: string;
  recipients: Recipient[];
}): Promise<SurveySendOutcome> {
  const tenant = {
    organizationId: args.organizationId,
    ...(args.actorUserId ? { userId: args.actorUserId } : {}),
  };

  const { prepared, refused, context } = await withTenant(tenant, (tx) =>
    prepareInvites(tx, {
      organizationId: args.organizationId,
      surveyId: args.surveyId,
      recipients: args.recipients,
    }),
  );

  const results = prepared.length > 0 ? await deliverInvites(prepared, context) : [];

  const outcome = await withTenant(tenant, async (tx) => {
    const counts = await recordInviteDelivery(tx, args.organizationId, results);

    await tx.insert(schema.auditLogs).values({
      organizationId: args.organizationId,
      actorUserId: args.actorUserId,
      action: "survey_invites.sent",
      entity: `survey:${args.surveyId}`,
      meta: {
        ...counts,
        refused: refused.length,
        // The reasons, counted. An operator reading the audit log needs to know
        // whether nothing went out because people opted out or because the
        // registry is not wired up.
        refusals: refused.reduce<Record<string, number>>((tally, entry) => {
          tally[entry.reason] = (tally[entry.reason] ?? 0) + 1;
          return tally;
        }, {}),
      },
    });

    return counts;
  });

  log.info(
    {
      organizationId: args.organizationId,
      surveyId: args.surveyId,
      ...outcome,
      refused: refused.length,
    },
    "Survey invitations dispatched",
  );

  return {
    ...outcome,
    refused,
    failures: results
      .filter((result): result is InviteResult & { ok: false } => !result.ok)
      .map((result) => ({ email: result.email, reason: result.reason })),
  };
}
