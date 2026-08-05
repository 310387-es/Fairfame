import { and, eq } from "drizzle-orm";
import { normalizePhone } from "../connectors/whatsapp/client.ts";
import { TEMPLATES, type TemplateName } from "../connectors/whatsapp/templates.ts";
import {
  checkSendAllowed,
  describeRefusal,
  type GateRefusal,
  type MessageIntent,
} from "../compliance/gate.ts";
import { schema } from "../db/client.ts";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "../i18n/config.ts";
import { getEnv } from "../lib/env.ts";
import { childLogger } from "../lib/logger.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { recordOutbound, type MessageChannel } from "./messages.ts";
import { getSmsClient } from "./sms.ts";
import { sendSessionReply, sendTemplateMessage } from "./whatsapp.ts";

/**
 * Sending a message to a customer (P4-T3).
 *
 * The one entry point the product calls. Its job is to decide two things and
 * then get out of the way:
 *
 * **1. Which basis this send rests on — and the caller does not get a vote.**
 * There is deliberately no `intent` parameter. Intent follows from *what is
 * being sent*, which is also how WhatsApp's own rule works: free text is a
 * reply and needs an open 24-hour window; an approved template is
 * business-initiated and needs consent. Letting a screen declare "this one is a
 * service message" would be precisely the exemption argument
 * `src/compliance/gate.ts` warns about, and it would be one checkbox away from
 * a fine.
 *
 * **2. Which transport carries it.** Every transport is entered through a
 * function that gates — `sendTemplateMessage` and `sendSessionReply` for
 * WhatsApp, `sendSms` below — so there is no path from this module to a network
 * call that skips `checkSendAllowed`.
 *
 * **SMS is always `commercial`, and that is not an oversight.** The 24-hour
 * service window is a *Meta* rule about a *WhatsApp* conversation. Turkish law
 * grants no equivalent exemption for replying to an SMS, so a free-text SMS to
 * a customer still needs a registered permission. Treating an inbound SMS as
 * consent would be inventing an exemption out of a platform's product
 * decision.
 */

const log = childLogger({ module: "messaging/outbound" });

export type OutboundRequest =
  /** Free text. WhatsApp: a reply inside the window. SMS: still commercial. */
  | { kind: "reply"; body: string }
  /** A pre-approved template. Always business-initiated. */
  | { kind: "template"; template: TemplateName; values: string[] };

export type OutboundRefusal =
  | GateRefusal
  /** The channel has no client in this environment. */
  | "not_configured"
  /** The contact has no number to send to. */
  | "no_address"
  /** The platform accepted the request and then refused it. */
  | "send_failed";

export type OutboundResult =
  | { ok: true; messageId: string; intent: MessageIntent; externalId: string }
  | { ok: false; refusal: OutboundRefusal; reason: string };

export type SendMessageInput = {
  tx: TenantDatabase;
  organizationId: string;
  contactId: string;
  channel: MessageChannel;
  request: OutboundRequest;
  /** Who pressed send. Null when the product sent it on its own. */
  sentByUserId?: string | null;
  now?: Date;
};

/**
 * The basis a send rests on, derived from the channel and the content.
 *
 * A pure function of two things the caller cannot lie about, exported so the
 * UI can *show* what will happen — "this will go as a reply, inside the window
 * that closes at 18:40" — without a second copy of the rule.
 */
export function intentFor(channel: MessageChannel, request: OutboundRequest): MessageIntent {
  if (channel === "sms") return "commercial";
  return request.kind === "reply" ? "service" : "commercial";
}

function localeOf(value: string | null | undefined): Locale {
  return (LOCALES as readonly string[]).includes(value ?? "") ? (value as Locale) : DEFAULT_LOCALE;
}

/**
 * The SMS transport entry point. Gates, then sends.
 *
 * Symmetrical with `sendTemplateMessage`/`sendSessionReply`: the gate is inside
 * the function that can reach the network, so a caller who constructs their own
 * client is not a way around it.
 */
async function sendSms(input: {
  tx: TenantDatabase;
  organizationId: string;
  contactId: string;
  body: string;
  now?: Date;
}): Promise<
  { ok: true; messageId: string } | { ok: false; refusal: OutboundRefusal; reason: string }
> {
  const decision = await checkSendAllowed(
    {
      tx: input.tx,
      organizationId: input.organizationId,
      contactId: input.contactId,
      intent: "commercial",
      channel: "sms",
      ...(input.now ? { now: input.now } : {}),
    },
    getEnv(),
  );

  if (!decision.allowed) {
    return { ok: false, refusal: decision.reason, reason: describeRefusal(decision.reason) };
  }

  const client = getSmsClient();
  if (!client) {
    return {
      ok: false,
      refusal: "not_configured",
      reason: "No SMS gateway is configured in this environment.",
    };
  }

  const [contact] = await input.tx
    .select({ phone: schema.contacts.phone })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.organizationId, input.organizationId),
        eq(schema.contacts.id, input.contactId),
      ),
    )
    .limit(1);

  const phone = contact?.phone ? normalizePhone(contact.phone) : null;
  if (!phone) {
    return {
      ok: false,
      refusal: "no_address",
      reason: "That contact has no usable phone number.",
    };
  }

  const result = await client.send({ to: phone, body: input.body });
  return result.ok
    ? { ok: true, messageId: result.messageId }
    : { ok: false, refusal: "send_failed", reason: result.reason };
}

/** The text a message will carry, for the thread. */
function bodyOf(request: OutboundRequest, locale: Locale): string {
  if (request.kind === "reply") return request.body;

  const template = TEMPLATES[request.template];
  // A name that is not in the registry cannot reach a client — `dispatch`
  // refuses it — so the body is the name itself rather than a throw here, which
  // would turn a bad template into a 500 instead of a refusal.
  if (!template) return String(request.template);

  // Rendered rather than stored as "{{1}}": the thread has to show what the
  // customer received, and a placeholder is not that.
  return request.values.reduce(
    (text, value, index) => text.replaceAll(`{{${index + 1}}}`, value),
    template.body[locale],
  );
}

/**
 * Sends, and records what happened.
 *
 * **A refusal by the gate writes no row.** Nothing left the building and
 * nothing was attempted, so a thread showing failed sends to somebody who never
 * consented would read as harassment we did not commit. A *platform* failure
 * does write one, because an attempt was made and "why did they never hear
 * back" is a question a support agent has to be able to answer.
 */
export async function sendMessage(input: SendMessageInput): Promise<OutboundResult> {
  const { tx, organizationId, contactId, channel, request } = input;
  const intent = intentFor(channel, request);

  const [contact] = await tx
    .select({ locale: schema.contacts.locale })
    .from(schema.contacts)
    .where(
      and(eq(schema.contacts.organizationId, organizationId), eq(schema.contacts.id, contactId)),
    )
    .limit(1);

  const locale = localeOf(contact?.locale);
  const body = bodyOf(request, locale);

  const outcome = await dispatch(input, locale);

  if (!outcome.ok) {
    const gateRefused = outcome.refusal !== "send_failed";

    if (gateRefused) {
      log.info(
        { organizationId, channel, intent, refusal: outcome.refusal },
        "Outbound message refused before sending",
      );
      return outcome;
    }

    const messageId = await recordOutbound({
      tx,
      organizationId,
      contactId,
      channel,
      body,
      intent,
      templateName: request.kind === "template" ? String(request.template) : null,
      sentByUserId: input.sentByUserId ?? null,
      outcome: "failed",
      failureReason: outcome.reason,
      ...(input.now ? { at: input.now } : {}),
    });

    log.warn(
      { organizationId, channel, messageId, reason: outcome.reason },
      "Outbound send failed",
    );
    return outcome;
  }

  const messageId = await recordOutbound({
    tx,
    organizationId,
    contactId,
    channel,
    body,
    intent,
    templateName: request.kind === "template" ? String(request.template) : null,
    sentByUserId: input.sentByUserId ?? null,
    outcome: "sent",
    externalId: outcome.externalId,
    ...(input.now ? { at: input.now } : {}),
  });

  // The 24-hour window is *not* touched here. It is opened by the customer and
  // by nobody else — `last_outbound_at` exists for diagnostics only, and the
  // gate never reads it.
  await tx
    .update(schema.whatsappConversations)
    .set({ lastOutboundAt: input.now ?? new Date(), updatedAt: input.now ?? new Date() })
    .where(
      and(
        eq(schema.whatsappConversations.organizationId, organizationId),
        eq(schema.whatsappConversations.contactId, contactId),
      ),
    );

  return { ok: true, messageId, intent, externalId: outcome.externalId };
}

async function dispatch(
  input: SendMessageInput,
  locale: Locale,
): Promise<
  { ok: true; externalId: string } | { ok: false; refusal: OutboundRefusal; reason: string }
> {
  const { tx, organizationId, contactId, channel, request } = input;
  const common = {
    tx,
    organizationId,
    contactId,
    locale,
    ...(input.now ? { now: input.now } : {}),
  };

  if (channel === "sms") {
    const result = await sendSms({
      tx,
      organizationId,
      contactId,
      body: bodyOf(request, locale),
      ...(input.now ? { now: input.now } : {}),
    });
    return result.ok ? { ok: true, externalId: result.messageId } : result;
  }

  const result =
    request.kind === "reply"
      ? await sendSessionReply({ ...common, body: request.body })
      : await sendTemplateMessage({
          ...common,
          template: request.template,
          values: request.values,
        });

  if (result.ok) return { ok: true, externalId: result.messageId };

  return {
    ok: false,
    refusal: result.refusal === "send_failed" ? "send_failed" : result.refusal,
    reason: result.reason,
  };
}
