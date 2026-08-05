import { and, desc, eq, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { LocationScope } from "../auth/scope.ts";
import { contactScopeClause } from "../contacts/scope.ts";
import { SESSION_WINDOW_MS, type MessageIntent } from "../compliance/gate.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";

/**
 * The message log (P4-T3).
 *
 * One row per message in either direction, and the only writer of `messages`.
 * Everything about *whether* a message may be sent lives in
 * `src/compliance/gate.ts`; this module records what happened, including when
 * the answer was no.
 *
 * **A conversation is not an entity here.** It is the messages with one
 * contact, in order — see the schema note. So the inbox is a `DISTINCT ON`
 * and there is no second row that can disagree with the first about who is
 * talking to whom.
 */

export type MessageChannel = "whatsapp" | "sms";

export type RecordInboundInput = {
  tx: TenantDatabase;
  organizationId: string;
  contactId: string;
  channel: MessageChannel;
  body: string | null;
  /** The platform's id. Null only when the payload genuinely carried none. */
  externalId: string | null;
  at?: Date;
};

/**
 * Records a message from the customer.
 *
 * Idempotent on `external_id`, because **Meta may deliver the same webhook more
 * than once** and a duplicated inbound message is indistinguishable from the
 * customer repeating themself. Returns false when the row was already there, so
 * a caller can tell a redelivery from a new message without guessing.
 */
export async function recordInbound(input: RecordInboundInput): Promise<boolean> {
  const at = input.at ?? new Date();

  const rows = await input.tx
    .insert(schema.messages)
    .values({
      organizationId: input.organizationId,
      contactId: input.contactId,
      channel: input.channel,
      direction: "inbound",
      status: "received",
      body: input.body,
      externalId: input.externalId,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
    .returning({ id: schema.messages.id });

  return rows.length > 0;
}

export type RecordOutboundInput = {
  tx: TenantDatabase;
  organizationId: string;
  contactId: string;
  channel: MessageChannel;
  body: string | null;
  /** The basis the gate approved this under. Stored, never recomputed. */
  intent: MessageIntent;
  templateName?: string | null;
  sentByUserId?: string | null;
  at?: Date;
} & (
  | { outcome: "sent"; externalId: string }
  | { outcome: "failed"; failureReason: string; externalId?: null }
);

/**
 * Records a message we sent — or tried to.
 *
 * A failure is a **row**, not a discarded return value. "We attempted to
 * message this person and the platform refused" is part of the conversation's
 * history and part of the answer to why somebody never heard back, and a log
 * line is not somewhere a support agent can look.
 *
 * A message the *gate* refused is deliberately **not** recorded here — see
 * `./outbound.ts`. Nothing left, nothing was attempted, and a thread showing
 * failed sends to somebody who never consented would read as harassment we did
 * not commit.
 */
export async function recordOutbound(input: RecordOutboundInput): Promise<string> {
  const at = input.at ?? new Date();

  const [row] = await input.tx
    .insert(schema.messages)
    .values({
      organizationId: input.organizationId,
      contactId: input.contactId,
      channel: input.channel,
      direction: "outbound",
      status: input.outcome === "sent" ? "sent" : "failed",
      body: input.body,
      templateName: input.templateName ?? null,
      externalId: input.outcome === "sent" ? input.externalId : null,
      sentByUserId: input.sentByUserId ?? null,
      intent: input.intent,
      failureReason: input.outcome === "failed" ? input.failureReason.slice(0, 500) : null,
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: schema.messages.id });

  if (!row) throw new Error("Could not record the message.");
  return row.id;
}

/**
 * Advances an outbound message on a delivery receipt.
 *
 * **Forwards only.** Receipts arrive out of order — `read` can land before
 * `delivered` — and a naive assignment would walk a message backwards and make
 * the thread lie about whether the customer saw it.
 */
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

export async function applyReceipt(
  tx: TenantDatabase,
  organizationId: string,
  externalId: string,
  status: "sent" | "delivered" | "read" | "failed",
  at = new Date(),
): Promise<boolean> {
  const rows = await tx
    .update(schema.messages)
    .set({ status, updatedAt: at })
    .where(
      and(
        eq(schema.messages.organizationId, organizationId),
        eq(schema.messages.externalId, externalId),
        eq(schema.messages.direction, "outbound"),
        // `failed` is allowed to overwrite anything, because Meta reports an
        // undeliverable number *after* accepting the send; everything else may
        // only move up the ladder.
        status === "failed"
          ? undefined
          : sql`case ${schema.messages.status}
                  when 'queued' then 0 when 'sent' then 1
                  when 'delivered' then 2 when 'read' then 3
                  else 99 end < ${STATUS_RANK[status] ?? 99}`,
      ),
    )
    .returning({ id: schema.messages.id });

  return rows.length > 0;
}

export type ThreadMessage = {
  id: string;
  channel: MessageChannel;
  direction: "inbound" | "outbound";
  status: string;
  body: string | null;
  templateName: string | null;
  intent: string | null;
  failureReason: string | null;
  sentByUserId: string | null;
  createdAt: Date;
};

/** One conversation, oldest first — the order a thread is read in. */
export async function listThread(
  tx: TenantDatabase,
  organizationId: string,
  contactId: string,
  limit = 200,
): Promise<ThreadMessage[]> {
  const rows = await tx
    .select({
      id: schema.messages.id,
      channel: schema.messages.channel,
      direction: schema.messages.direction,
      status: schema.messages.status,
      body: schema.messages.body,
      templateName: schema.messages.templateName,
      intent: schema.messages.intent,
      failureReason: schema.messages.failureReason,
      sentByUserId: schema.messages.sentByUserId,
      createdAt: schema.messages.createdAt,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.organizationId, organizationId),
        eq(schema.messages.contactId, contactId),
      ),
    )
    // Newest first for the limit, so a long thread keeps its *recent* end…
    .orderBy(desc(schema.messages.createdAt))
    .limit(limit);

  // …then reversed, because a conversation is read downwards.
  return rows.reverse();
}

export type ConversationRow = {
  contactId: string;
  contactName: string | null;
  phone: string | null;
  channel: MessageChannel;
  lastBody: string | null;
  lastDirection: "inbound" | "outbound";
  lastAt: Date;
  /** True while WhatsApp's 24-hour window is open. Null for a contact we have
   *  never heard from on WhatsApp — different from "closed". */
  windowOpen: boolean | null;
};

/**
 * The inbox: one row per contact, most recent first.
 *
 * `DISTINCT ON (contact_id)` rather than a window function or a group-by with a
 * correlated max — it is the one construct that returns the *whole row* of the
 * latest message without reading the table twice.
 *
 * Scoped by `contactScopeClause`, not by a rule of its own. A conversation is
 * with a person, and who a member may see is already decided in exactly one
 * place (`src/contacts/scope.ts`). A second interpretation here is how the
 * messages inbox ends up showing a branch manager somebody the contacts list
 * hides from them.
 */
export async function listConversations(
  tx: TenantDatabase,
  organizationId: string,
  scope: LocationScope,
  now = new Date(),
  limit = 100,
): Promise<ConversationRow[]> {
  const scoped = contactScopeClause(scope);
  const windowStart = new Date(now.getTime() - SESSION_WINDOW_MS);

  const { rows } = await tx.execute<{
    contact_id: string;
    contact_name: string | null;
    phone: string | null;
    channel: MessageChannel;
    last_body: string | null;
    last_direction: "inbound" | "outbound";
    last_at: string;
    window_open: boolean | null;
  }>(sql`
    select
      latest.contact_id,
      ${schema.contacts.name}  as contact_name,
      ${schema.contacts.phone} as phone,
      latest.channel,
      latest.body      as last_body,
      latest.direction as last_direction,
      latest.created_at as last_at,
      case
        when wc.last_inbound_at is null then null
        else wc.last_inbound_at > ${windowStart}
      end as window_open
    from (
      select distinct on (m.contact_id)
             m.contact_id, m.channel, m.body, m.direction, m.created_at
        from ${schema.messages} m
       where m.organization_id = ${organizationId}
       order by m.contact_id, m.created_at desc
    ) as latest
    join ${schema.contacts}
      on ${schema.contacts.id} = latest.contact_id
    left join ${schema.whatsappConversations} wc
      on wc.contact_id = latest.contact_id
     and wc.organization_id = ${organizationId}
     where ${scoped ?? sql`true`}
     order by latest.created_at desc
     limit ${limit}
  `);

  return rows.map((row) => ({
    contactId: row.contact_id,
    contactName: row.contact_name,
    phone: row.phone,
    channel: row.channel,
    lastBody: row.last_body,
    lastDirection: row.last_direction,
    lastAt: new Date(row.last_at),
    windowOpen: row.window_open,
  }));
}

/** Whether WhatsApp's 24-hour window is open for one contact right now. */
export async function windowState(
  tx: TenantDatabase,
  organizationId: string,
  contactId: string,
  now = new Date(),
): Promise<{ open: boolean; lastInboundAt: Date | null }> {
  const [row] = await tx
    .select({ lastInboundAt: schema.whatsappConversations.lastInboundAt })
    .from(schema.whatsappConversations)
    .where(
      and(
        eq(schema.whatsappConversations.organizationId, organizationId),
        eq(schema.whatsappConversations.contactId, contactId),
      ),
    )
    .limit(1);

  const lastInboundAt = row?.lastInboundAt ?? null;

  return {
    // Read from the *customer's* last message and nothing else. A business
    // cannot open its own window by messaging someone, which is the entire
    // point of the rule.
    open: lastInboundAt !== null && lastInboundAt.getTime() > now.getTime() - SESSION_WINDOW_MS,
    lastInboundAt,
  };
}
