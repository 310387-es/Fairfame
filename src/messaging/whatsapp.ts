import { and, eq } from "drizzle-orm";
import {
  checkSendAllowed,
  describeRefusal,
  type GateRefusal,
  type MessageIntent,
} from "../compliance/gate.ts";
import {
  createWhatsAppClient,
  normalizePhone,
  WHATSAPP_PROVIDER,
  type WhatsAppClient,
} from "../connectors/whatsapp/client.ts";
import { createMockWhatsAppClient } from "../connectors/whatsapp/mock-client.ts";
import { resolveMode } from "../connectors/providers.ts";
import { TEMPLATES, type TemplateName } from "../connectors/whatsapp/templates.ts";
import { schema } from "../db/client.ts";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "../i18n/config.ts";
import { channelCredentials } from "../channels/store.ts";
import { getEnv } from "../lib/env.ts";
import { childLogger } from "../lib/logger.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";

/**
 * Sending on WhatsApp (P1b-T3).
 *
 * The sibling of `./email.ts` that `docs/11` anticipated: the code deciding
 * *what* to say never learns *how* it is sent. What this adds over the email
 * transport is a gate — every business-initiated message passes
 * `checkSendAllowed` before a request is made, and a refusal is returned rather
 * than thrown, because "we declined to message this person" is an outcome the
 * caller must record, not an exception to swallow.
 *
 * **The gate is checked here, not in the client.** A client that enforced
 * consent would be bypassable by anyone who constructed their own; a send
 * function that cannot reach the network without passing the gate is not.
 *
 * Fixture-tested only — see the module note in `../connectors/whatsapp/client.ts`.
 */

const log = childLogger({ module: "messaging/whatsapp" });

/**
 * `no_address` and `not_configured` are **not** `send_failed`, and the
 * distinction decides whether a row is written (W2.2).
 *
 * `sendMessage` treats anything other than `send_failed` as a refusal that
 * never reached the network, and writes no `messages` row for it — the P4-T3
 * rule: nothing left the building, and a thread showing failed sends to
 * somebody who could never receive them reads as harassment we did not commit.
 *
 * Both of these used to come back as `send_failed`, so a contact with no phone
 * number got a `failed` message row claiming an attempt had been made to a
 * number that does not exist. The SMS path had it right all along; this is
 * WhatsApp being brought into line with it.
 */
export type WhatsAppSendOutcome =
  | { ok: true; messageId: string }
  | { ok: false; refusal: GateRefusal; reason: string }
  | { ok: false; refusal: "no_address" | "not_configured"; reason: string }
  | { ok: false; refusal: "send_failed"; reason: string; retryable: boolean };

export type SendTemplateInput = {
  tx: TenantDatabase;
  organizationId: string;
  contactId: string;
  template: TemplateName;
  /** Positional values for the template's variables. */
  values: string[];
  locale?: Locale;
  /** Overridden in tests; defaults to the env-configured client. */
  client?: WhatsAppClient;
  now?: Date;
};

function localeOf(value: string | null | undefined): Locale {
  return (LOCALES as readonly string[]).includes(value ?? "") ? (value as Locale) : DEFAULT_LOCALE;
}

/**
 * The configured client, or null when WhatsApp is not wired.
 *
 * Null rather than a throw: a deployment without WhatsApp credentials is the
 * normal state today, and every caller already has to handle a refusal.
 *
 * **`mock` mode returns a client that accepts and reaches nobody (P4-T3).**
 * Before that, an environment without a WhatsApp Business Account had no client
 * at all, so no conversation could round-trip anywhere — which made T3's
 * Definition of Done unreachable in every environment that has ever existed.
 * `CONNECTOR_WHATSAPP_MODE` already distinguished the two; this is what `mock`
 * now means. Credentials still win: a deployment that has them is talking to
 * Meta (or to `pnpm mock:platform`, which is a real socket), and a stray flag
 * must not silently divert live traffic into a stub.
 */
export function getWhatsAppClient(): WhatsAppClient | null {
  const env = getEnv();

  if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
    return createWhatsAppClient({
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      ...(env.WHATSAPP_BASE_URL ? { baseUrl: env.WHATSAPP_BASE_URL } : {}),
    });
  }

  return resolveMode(WHATSAPP_PROVIDER).mode === "mock" ? createMockWhatsAppClient() : null;
}

/**
 * The client for one organization, preferring its own connected account (W2.2).
 *
 * **Order matters and it is the opposite of `getWhatsAppClient`'s.** There, a
 * deployment credential beats the mock flag, because a deployment that has real
 * credentials is talking to Meta and must not be diverted into a stub. Here,
 * the *organization's* account beats the deployment's, because a business that
 * has connected its own WhatsApp number expects its messages to come from that
 * number — sending them from the deployment's instead would put one tenant's
 * conversations on another's phone, which is the worst failure this file could
 * have.
 *
 * Falls through to the deployment client when the organization has none, so a
 * single-tenant installation keeps working with no rows in
 * `channel_connections` at all.
 */
export async function whatsAppClientFor(
  tx: TenantDatabase,
  organizationId: string,
): Promise<WhatsAppClient | null> {
  const credentials = await channelCredentials(tx, organizationId, "whatsapp");

  if (credentials) {
    const env = getEnv();
    return createWhatsAppClient({
      accessToken: credentials.accessToken,
      phoneNumberId: credentials.externalId,
      ...(env.WHATSAPP_BASE_URL ? { baseUrl: env.WHATSAPP_BASE_URL } : {}),
    });
  }

  return getWhatsAppClient();
}

/**
 * Sends a pre-approved template to a contact, if the gate allows it.
 *
 * Templates are always business-initiated, so the intent is always
 * `commercial` — there is no path here that skips consent.
 */
export async function sendTemplateMessage(input: SendTemplateInput): Promise<WhatsAppSendOutcome> {
  const { tx, organizationId, contactId } = input;
  const env = getEnv();

  const decision = await checkSendAllowed(
    {
      tx,
      organizationId,
      contactId,
      intent: "commercial",
      channel: "whatsapp",
      ...(input.now ? { now: input.now } : {}),
    },
    env,
  );

  if (!decision.allowed) {
    log.info(
      { organizationId, contactId, template: input.template, refusal: decision.reason },
      "WhatsApp send refused by the compliance gate",
    );
    return { ok: false, refusal: decision.reason, reason: describeRefusal(decision.reason) };
  }

  return dispatch(input, "commercial");
}

export type SendReplyInput = Omit<SendTemplateInput, "template" | "values"> & { body: string };

/**
 * Sends free text as a reply inside the 24-hour customer service window.
 *
 * The gate proves the window is open; this function does not assume it. Sending
 * free text outside the window is not merely rejected by Meta — repeated
 * attempts damage the number's quality rating.
 */
export async function sendSessionReply(input: SendReplyInput): Promise<WhatsAppSendOutcome> {
  const { tx, organizationId, contactId } = input;
  const env = getEnv();

  const decision = await checkSendAllowed(
    {
      tx,
      organizationId,
      contactId,
      intent: "service",
      channel: "whatsapp",
      ...(input.now ? { now: input.now } : {}),
    },
    env,
  );

  if (!decision.allowed) {
    return { ok: false, refusal: decision.reason, reason: describeRefusal(decision.reason) };
  }

  // The organization's own account when it has connected one (W2.2), the
  // deployment's otherwise. Never the other way round: a business that
  // connected its number expects its messages to come from that number.
  const client = input.client ?? (await whatsAppClientFor(tx, organizationId));
  if (!client) {
    return {
      ok: false,
      refusal: "not_configured",
      reason: "WhatsApp is not configured in this environment.",
    };
  }

  const phone = await recipientPhone(tx, organizationId, contactId);
  if (!phone) {
    return {
      ok: false,
      refusal: "no_address",
      reason: "That contact has no usable phone number.",
    };
  }

  const result = await client.sendText({ to: phone, body: input.body });
  return toOutcome(result, { organizationId, contactId, kind: "session" });
}

async function dispatch(
  input: SendTemplateInput,
  intent: MessageIntent,
): Promise<WhatsAppSendOutcome> {
  const client = input.client ?? (await whatsAppClientFor(input.tx, input.organizationId));

  if (!client) {
    return {
      ok: false,
      refusal: "not_configured",
      reason: "WhatsApp is not configured in this environment.",
    };
  }

  const [contact] = await input.tx
    .select({ phone: schema.contacts.phone, locale: schema.contacts.locale })
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

  const template = TEMPLATES[input.template];
  if (!template) {
    return {
      ok: false,
      refusal: "send_failed",
      retryable: false,
      reason: `Unknown template "${input.template}".`,
    };
  }

  const result = await client.sendTemplate({
    to: phone,
    template,
    // The *recipient's* language. A Turkish customer must not get an English
    // template because the dashboard was in English when the campaign ran.
    locale: input.locale ?? localeOf(contact?.locale),
    values: input.values,
  });

  return toOutcome(result, {
    organizationId: input.organizationId,
    contactId: input.contactId,
    kind: intent,
  });
}

async function recipientPhone(
  tx: TenantDatabase,
  organizationId: string,
  contactId: string,
): Promise<string | null> {
  const [contact] = await tx
    .select({ phone: schema.contacts.phone })
    .from(schema.contacts)
    .where(
      and(eq(schema.contacts.organizationId, organizationId), eq(schema.contacts.id, contactId)),
    )
    .limit(1);

  return contact?.phone ? normalizePhone(contact.phone) : null;
}

function toOutcome(
  result: Awaited<ReturnType<WhatsAppClient["sendText"]>>,
  context: { organizationId: string; contactId: string; kind: string },
): WhatsAppSendOutcome {
  if (result.ok) {
    log.info({ ...context, messageId: result.messageId }, "WhatsApp message sent");
    return { ok: true, messageId: result.messageId };
  }

  log.warn({ ...context, reason: result.reason, kind: result.kind }, "WhatsApp send failed");
  return { ok: false, refusal: "send_failed", retryable: result.retryable, reason: result.reason };
}
