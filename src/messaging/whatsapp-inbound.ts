import { and, desc, eq, sql } from "drizzle-orm";
import { normalizePhone } from "../connectors/whatsapp/client.ts";
import { inboundText, type WebhookEvents } from "../connectors/whatsapp/schemas.ts";
import { revokeConsent } from "../compliance/consent.ts";
import { getAdminDb, schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant } from "../lib/tenancy.ts";

/**
 * What an inbound WhatsApp event does to our state (P1b-T3).
 *
 * Three things, in order of how much they matter:
 *
 *   1. **An opt-out stops everything.** "STOP" from a customer is a legal
 *      instruction, not a support ticket. It is honoured on the spot, before
 *      anything else in the payload is considered, and it is the one branch
 *      here that must never depend on matching a campaign or a request.
 *   2. **A customer message opens the 24-hour service window**, which is what
 *      lets us answer them at all. Recorded on `whatsapp_conversations`, which
 *      the gate in ../compliance/gate.ts reads — never on anything an outbound
 *      send writes.
 *   3. **A delivery status** updates the request that produced it.
 *
 * The webhook is cross-tenant by nature: Meta posts to one URL for one WhatsApp
 * number, and the number belongs to whichever organization connected it. So the
 * lookup starts from the phone number and *derives* the tenant — the one place
 * in this codebase where that direction is correct, and the reason every write
 * below re-enters `withTenant` with the organization it resolved.
 */

const log = childLogger({ module: "messaging/whatsapp-inbound" });

/**
 * Words that mean stop, in both launch languages.
 *
 * Matched on the whole trimmed message rather than as a substring: a review
 * reading "the service was a total stop-start mess" is not an opt-out, and
 * unsubscribing someone who did not ask is its own kind of failure.
 */
const OPT_OUT_WORDS = new Set([
  "stop",
  "dur",
  "iptal",
  "çık",
  "cik",
  "unsubscribe",
  "abonelikten çık",
  "abonelikten cik",
]);

export function isOptOut(text: string | null): boolean {
  if (!text) return false;
  const normalized = text.trim().toLocaleLowerCase("tr");
  return OPT_OUT_WORDS.has(normalized);
}

export type InboundOutcome = {
  /** Messages matched to a known contact. */
  matched: number;
  /** Messages from numbers we do not hold — logged, never stored. */
  unknown: number;
  optOuts: number;
  statuses: number;
};

/**
 * Finds the contact this number belongs to, across tenants.
 *
 * Admin-scoped on purpose and deliberately narrow: it reads `organization_id`
 * and `id` and nothing else. A webhook has no session, so the tenant has to be
 * derived from the payload — but the derivation must not become a way to read
 * contact data without a tenant context, so the caller re-enters `withTenant`
 * before touching anything.
 */
async function resolveContact(
  phone: string,
): Promise<{ organizationId: string; contactId: string } | null> {
  const [row] = await getAdminDb()
    .select({ organizationId: schema.contacts.organizationId, id: schema.contacts.id })
    .from(schema.contacts)
    .where(eq(schema.contacts.phone, phone))
    .limit(1);

  return row ? { organizationId: row.organizationId, contactId: row.id } : null;
}

export async function recordInboundEvents(
  events: WebhookEvents,
  now = new Date(),
): Promise<InboundOutcome> {
  const outcome: InboundOutcome = { matched: 0, unknown: 0, optOuts: 0, statuses: 0 };

  for (const { message } of events.messages) {
    const phone = normalizePhone(message.from);
    if (!phone) {
      outcome.unknown += 1;
      continue;
    }

    const found = await resolveContact(phone);
    if (!found) {
      // A message from a number we hold no contact for. Nothing is stored:
      // recording it would create a contact nobody consented to give us.
      outcome.unknown += 1;
      continue;
    }

    outcome.matched += 1;
    const text = inboundText(message);

    await withTenant({ organizationId: found.organizationId }, async (tx) => {
      if (isOptOut(text)) {
        await tx
          .update(schema.contacts)
          .set({ unsubscribedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.contacts.organizationId, found.organizationId),
              eq(schema.contacts.id, found.contactId),
              // Keep the original timestamp if they have already opted out —
              // the first refusal is the one that matters.
              sql`${schema.contacts.unsubscribedAt} is null`,
            ),
          );

        // Unsubscribing the contact stops *our* sends; revoking consent is
        // what makes the İYS record agree. Doing only the first would leave a
        // permission on file that the person has withdrawn — which is the
        // state İYS exists to prevent, and the one a regulator would ask about.
        await revokeConsent({
          tx,
          organizationId: found.organizationId,
          contactRef: found.contactId,
          now,
        });

        outcome.optOuts += 1;
        log.info({ organizationId: found.organizationId }, "WhatsApp opt-out honoured");
        return;
      }

      // Any other inbound message opens the customer service window. Recorded
      // on the conversation, which exists whether or not we ever sent this
      // person a campaign — replying to someone who messaged us first is the
      // case Meta explicitly permits.
      await tx
        .insert(schema.whatsappConversations)
        .values({
          organizationId: found.organizationId,
          contactId: found.contactId,
          waId: message.from,
          lastInboundAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.whatsappConversations.organizationId,
            schema.whatsappConversations.contactId,
          ],
          set: { waId: message.from, lastInboundAt: now, updatedAt: now },
        });

      // A campaign request that is still outstanding is also marked opened, so
      // the funnel on the Requests screen reflects the reply.
      const [request] = await tx
        .select({ id: schema.reviewRequests.id })
        .from(schema.reviewRequests)
        .where(
          and(
            eq(schema.reviewRequests.organizationId, found.organizationId),
            eq(schema.reviewRequests.contactId, found.contactId),
            eq(schema.reviewRequests.channel, "whatsapp"),
            sql`${schema.reviewRequests.openedAt} is null`,
          ),
        )
        .orderBy(desc(schema.reviewRequests.createdAt))
        .limit(1);

      if (request) {
        await tx
          .update(schema.reviewRequests)
          .set({ openedAt: now, status: "opened", updatedAt: now })
          .where(eq(schema.reviewRequests.id, request.id));
      }
    });
  }

  for (const status of events.statuses) {
    const applied = await applyStatus(status.id, status.status, now);
    if (applied) outcome.statuses += 1;
  }

  return outcome;
}

/**
 * Records a delivery receipt against the request that produced it.
 *
 * `failed` is the interesting one: Meta reports undeliverable numbers this way
 * rather than at send time, so a request that looked sent can turn out not to
 * have been.
 */
async function applyStatus(messageId: string, status: string, now: Date): Promise<boolean> {
  const [row] = await getAdminDb()
    .select({
      id: schema.reviewRequests.id,
      organizationId: schema.reviewRequests.organizationId,
    })
    .from(schema.reviewRequests)
    .where(eq(schema.reviewRequests.externalId, messageId))
    .limit(1);

  if (!row) return false;

  const next =
    status === "failed" ? "failed" : status === "read" || status === "delivered" ? "sent" : null;

  if (!next) return false;

  await withTenant({ organizationId: row.organizationId }, (tx) =>
    tx
      .update(schema.reviewRequests)
      .set({ status: next, updatedAt: now })
      .where(eq(schema.reviewRequests.id, row.id)),
  );

  return true;
}
