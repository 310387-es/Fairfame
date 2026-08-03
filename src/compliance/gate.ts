import { and, eq, gt } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";

/**
 * The gate every outbound commercial message passes through (P1b-T3, completed
 * by P1b-T5).
 *
 * **This file is deny-by-default and must stay that way.** Türkiye's İYS regime
 * makes an unconsented commercial message a fineable act by the *business*, and
 * WhatsApp's own policy will suspend a number for it. The failure mode of a
 * permissive default is not a bug report — it is a customer's phone buzzing
 * with a message they never agreed to receive, which cannot be taken back.
 *
 * So the ordering here is inverted from the usual: the gate exists and refuses
 * *before* the İYS integration that will one day approve things. T5 replaces
 * `iysCheck` with a real gateway; until then every commercial send is refused
 * with `iys_not_configured` unless the environment explicitly opts out of the
 * İYS requirement (non-Türkiye deployments), and even then a local consent
 * record is still required.
 *
 * The distinction that does most of the work here is WhatsApp's own:
 *
 *   - a **business-initiated** message needs prior opt-in, full stop;
 *   - a **reply inside the 24-hour customer service window** does not, because
 *     the customer started the conversation and is expecting an answer.
 *
 * Conflating the two would either block legitimate support replies or wave
 * marketing through as "support".
 */

const log = childLogger({ module: "compliance/gate" });

/** WhatsApp's customer service window. Fixed by Meta, not by us. */
export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type MessageIntent =
  /**
   * Business-initiated: a review request, a campaign, a digest push. Needs
   * consent and, in Türkiye, an İYS record.
   */
  | "commercial"
  /**
   * A reply to a conversation the customer started, inside the 24-hour window.
   * Needs an open window, not consent.
   */
  | "service";

export type GateDecision =
  | { allowed: true; intent: MessageIntent; reason: "consented" | "open_session" }
  | { allowed: false; reason: GateRefusal; detail?: string };

export type GateRefusal =
  /** No local record that this person agreed to be contacted. */
  | "no_consent"
  /** They agreed once and have since opted out. */
  | "opted_out"
  /** Turkish law requires an İYS record and no gateway is wired yet. */
  | "iys_not_configured"
  /** The gateway answered, and the answer was no. */
  | "iys_rejected"
  /** A service reply with no inbound message inside the window. */
  | "no_open_session"
  /** The contact is not one of this organization's. */
  | "unknown_contact";

export type GateInput = {
  tx: TenantDatabase;
  organizationId: string;
  contactId: string;
  intent: MessageIntent;
  /** Channel, so a future SMS gate can share this code path. */
  channel: "whatsapp" | "sms" | "email";
  now?: Date;
};

/**
 * The İYS check, as a seam.
 *
 * T5 wires a real İYS-connected gateway here. The signature is deliberately
 * three-valued rather than boolean: "no gateway configured" is a different
 * answer from "the gateway said no", and only the first is a deployment
 * problem someone can fix.
 */
export type IysVerdict = "allowed" | "rejected" | "not_configured";

export type IysGateway = {
  readonly name: string;
  check(input: {
    organizationId: string;
    contactRef: string;
    channel: string;
  }): Promise<IysVerdict>;
};

let gateway: IysGateway | null = null;

/** Installs the İYS gateway. T5's job; tests use it too. */
export function setIysGateway(next: IysGateway | null): void {
  gateway = next;
}

/**
 * Whether İYS applies at all.
 *
 * İYS is Turkish law. A deployment serving another market should not be forced
 * to register with it — but the opt-out is explicit and environment-level, never
 * a per-send flag, because "this one message is exempt" is exactly the argument
 * that ends in a fine.
 */
export function iysRequired(env: { IYS_REQUIRED: boolean }): boolean {
  return env.IYS_REQUIRED;
}

/**
 * The consent record that authorises a commercial message.
 *
 * Keyed on the **contact id**, never the phone number. `consent_records` is
 * documented as holding "a pointer to the contact, not the PII itself", and
 * `contacts` is deliberately the only table where a customer's number lives —
 * so a KVKK erasure request is one row, not a hunt. The İYS gateway below still
 * receives the number, because the registry keys on it, but that is a transient
 * call rather than a second stored copy.
 *
 * **Which record counts depends on the market**, and the two types genuinely
 * mean different things. KVKK consent is permission to *process* someone's
 * data; İYS consent is permission to *send them a commercial message*, per
 * channel. Where İYS applies, the İYS record is the one that authorises a send —
 * treating a "I agree to my data being processed" tick on a review form as
 * marketing permission is precisely the conflation the registry exists to stop.
 *
 * **`revoked_at` is decisive.** An earlier version read only `granted_at`, so a
 * withdrawn consent still reported as granted and a person who had said stop
 * could be messaged again. Withdrawal never deletes the row — see
 * ./consent.ts — which is exactly why the read has to check both columns.
 */
async function currentConsent(
  tx: TenantDatabase,
  organizationId: string,
  contactRef: string,
  requiredType: "kvkk" | "iys",
  channel: ConsentChannelFor,
): Promise<{ granted: boolean } | null> {
  const [row] = await tx
    .select({
      grantedAt: schema.consentRecords.grantedAt,
      revokedAt: schema.consentRecords.revokedAt,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.organizationId, organizationId),
        eq(schema.consentRecords.contactRef, contactRef),
        eq(schema.consentRecords.type, requiredType),
        // A KVKK record has no channel; an İYS one is per channel.
        requiredType === "iys" ? eq(schema.consentRecords.channel, channel) : undefined,
      ),
    )
    .limit(1);

  if (!row) return null;
  return { granted: row.grantedAt !== null && row.revokedAt === null };
}

type ConsentChannelFor = "message" | "call" | "email";

/** Our send channels map onto İYS's three. */
function consentChannelFor(channel: GateInput["channel"]): ConsentChannelFor {
  return channel === "email" ? "email" : "message";
}

/**
 * Is there an inbound message from this contact inside the window?
 *
 * Read from `whatsapp_conversations.last_inbound_at` — **the customer's** most
 * recent message, never ours. A business cannot open its own window by
 * messaging someone, which is the entire point of the rule, so nothing this
 * function reads is written by an outbound send.
 */
async function hasOpenSession(
  tx: TenantDatabase,
  organizationId: string,
  contactId: string,
  now: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ lastInboundAt: schema.whatsappConversations.lastInboundAt })
    .from(schema.whatsappConversations)
    .where(
      and(
        eq(schema.whatsappConversations.organizationId, organizationId),
        eq(schema.whatsappConversations.contactId, contactId),
        gt(schema.whatsappConversations.lastInboundAt, new Date(now.getTime() - SESSION_WINDOW_MS)),
      ),
    )
    .limit(1);

  return row !== undefined;
}

/**
 * May we send this?
 *
 * Every refusal is a named reason, because "send failed" tells an operator
 * nothing and the difference between "they opted out" and "we have not wired
 * İYS yet" is the difference between correct behaviour and a broken deployment.
 */
export async function checkSendAllowed(
  input: GateInput,
  env: { IYS_REQUIRED: boolean },
): Promise<GateDecision> {
  const { tx, organizationId, contactId, intent, now = new Date() } = input;

  const [contact] = await tx
    .select({
      id: schema.contacts.id,
      phone: schema.contacts.phone,
      unsubscribedAt: schema.contacts.unsubscribedAt,
    })
    .from(schema.contacts)
    .where(
      and(eq(schema.contacts.organizationId, organizationId), eq(schema.contacts.id, contactId)),
    )
    .limit(1);

  // RLS already hides another tenant's contact; this names the problem.
  if (!contact) return { allowed: false, reason: "unknown_contact" };

  // An opt-out beats everything, including an open session. Someone who said
  // stop has said stop.
  if (contact.unsubscribedAt !== null) return { allowed: false, reason: "opted_out" };

  if (intent === "service") {
    const open = await hasOpenSession(tx, organizationId, contactId, now);
    return open
      ? { allowed: true, intent, reason: "open_session" }
      : { allowed: false, reason: "no_open_session" };
  }

  // Where İYS applies, the İYS permission is what authorises a commercial
  // message; elsewhere the KVKK record is the local basis.
  const requiredType = iysRequired(env) ? "iys" : "kvkk";
  const consent = await currentConsent(
    tx,
    organizationId,
    contact.id,
    requiredType,
    consentChannelFor(input.channel),
  );

  if (!consent) return { allowed: false, reason: "no_consent" };
  if (!consent.granted) return { allowed: false, reason: "opted_out" };

  if (!iysRequired(env)) {
    // A non-Türkiye deployment still needs local consent — only the İYS
    // registry check is skipped.
    return { allowed: true, intent, reason: "consented" };
  }

  if (!gateway) {
    log.warn(
      { organizationId, channel: input.channel },
      "Commercial send refused: İYS is required but no gateway is configured",
    );
    return {
      allowed: false,
      reason: "iys_not_configured",
      detail:
        "İYS is required in this environment and no gateway is wired yet (P1b-T5). " +
        "Set IYS_REQUIRED=false only for deployments outside Türkiye.",
    };
  }

  const verdict = await gateway.check({
    organizationId,
    // The registry is keyed on the phone number; the contact id is ours.
    contactRef: contact.phone ?? contact.id,
    channel: input.channel,
  });

  if (verdict === "allowed") return { allowed: true, intent, reason: "consented" };
  if (verdict === "not_configured") {
    return { allowed: false, reason: "iys_not_configured", detail: `gateway ${gateway.name}` };
  }
  return { allowed: false, reason: "iys_rejected" };
}

/** Human-readable, for logs and operator-facing errors. */
export function describeRefusal(reason: GateRefusal): string {
  switch (reason) {
    case "no_consent":
      return "No consent record for this contact.";
    case "opted_out":
      return "This contact has opted out.";
    case "iys_not_configured":
      return "İYS is required here and no gateway is configured.";
    case "iys_rejected":
      return "İYS rejected this recipient.";
    case "no_open_session":
      return "No customer-initiated message in the last 24 hours.";
    case "unknown_contact":
      return "That contact does not exist.";
  }
}
