import { z } from "zod";

/**
 * WhatsApp Cloud API payload shapes (P1b-T3).
 *
 * Written against Meta's published Cloud API contract and pinned with recorded
 * fixtures in `tests/fixtures/whatsapp/`. Nothing here has been exercised
 * against the live API — a WhatsApp Business Account, a verified phone number
 * and an approved template are all gated on the company existing, so these
 * schemas are a documented reading of the contract, not a verified one.
 *
 * They are deliberately **loose about extras and strict about what we use**.
 * Meta adds fields continuously; a schema that rejected an unknown key would
 * turn a harmless platform change into an outage, while one that shrugged at a
 * missing `wamid` would let us record a send that never happened.
 */

/** Everything Meta sends back on a successful send. */
export const sendResponseSchema = z
  .object({
    messaging_product: z.literal("whatsapp"),
    contacts: z.array(z.object({ input: z.string(), wa_id: z.string() }).loose()).optional(),
    messages: z
      .array(z.object({ id: z.string().min(1) }).loose())
      .min(1, "a successful send always returns at least one message id"),
  })
  .loose();

export type WhatsAppSendResponse = z.infer<typeof sendResponseSchema>;

/**
 * Meta's error envelope.
 *
 * `code` and `error_subcode` are the parts worth branching on; `message` is
 * prose that changes without notice and must never be parsed.
 */
export const errorSchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
        type: z.string().optional(),
        code: z.number().optional(),
        error_subcode: z.number().optional(),
        error_data: z.object({ details: z.string().optional() }).loose().optional(),
        fbtrace_id: z.string().optional(),
      })
      .loose(),
  })
  .loose();

export type WhatsAppError = z.infer<typeof errorSchema>;

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * An inbound message from a customer.
 *
 * Only the kinds we act on are modelled. An unmodelled type (sticker, location,
 * order) parses as its base shape and is ignored rather than rejected — a
 * customer sending a sticker must not fail a webhook delivery, because Meta
 * retries failures and will eventually disable the endpoint.
 */
export const inboundMessageSchema = z
  .object({
    from: z.string().min(1),
    id: z.string().min(1),
    /** Unix seconds, as a string. Meta's choice, not ours. */
    timestamp: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).loose().optional(),
    button: z.object({ text: z.string(), payload: z.string() }).loose().optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ id: z.string(), title: z.string() }).loose().optional(),
        list_reply: z.object({ id: z.string(), title: z.string() }).loose().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

/** A delivery receipt for something we sent. */
export const statusSchema = z
  .object({
    id: z.string().min(1),
    status: z.string(),
    timestamp: z.string(),
    recipient_id: z.string().optional(),
    errors: z
      .array(z.object({ code: z.number().optional(), title: z.string().optional() }).loose())
      .optional(),
  })
  .loose();

export const webhookSchema = z
  .object({
    object: z.string(),
    entry: z.array(
      z
        .object({
          id: z.string(),
          changes: z.array(
            z
              .object({
                field: z.string(),
                value: z
                  .object({
                    messaging_product: z.string().optional(),
                    metadata: z
                      .object({
                        display_phone_number: z.string().optional(),
                        phone_number_id: z.string().optional(),
                      })
                      .loose()
                      .optional(),
                    contacts: z
                      .array(
                        z
                          .object({
                            wa_id: z.string(),
                            profile: z.object({ name: z.string() }).loose().optional(),
                          })
                          .loose(),
                      )
                      .optional(),
                    messages: z.array(inboundMessageSchema).optional(),
                    statuses: z.array(statusSchema).optional(),
                  })
                  .loose(),
              })
              .loose(),
          ),
        })
        .loose(),
    ),
  })
  .loose();

export type WhatsAppWebhook = z.infer<typeof webhookSchema>;
export type InboundMessage = z.infer<typeof inboundMessageSchema>;
export type MessageStatus = z.infer<typeof statusSchema>;

/** The text a customer actually sent, whatever shape it arrived in. */
export function inboundText(message: InboundMessage): string | null {
  if (message.text?.body) return message.text.body;
  if (message.button?.text) return message.button.text;
  if (message.interactive?.button_reply?.title) return message.interactive.button_reply.title;
  if (message.interactive?.list_reply?.title) return message.interactive.list_reply.title;
  return null;
}

/**
 * A normalized view of one webhook, flattened out of Meta's nesting.
 *
 * The payload arrives as entry[] → changes[] → value → messages[], which is
 * four levels of array for what is almost always one message. Flattening it
 * here keeps that shape out of every caller.
 */
export type WebhookEvents = {
  phoneNumberId: string | null;
  messages: { message: InboundMessage; profileName: string | null }[];
  statuses: MessageStatus[];
};

export function flattenWebhook(payload: WhatsAppWebhook): WebhookEvents {
  const messages: WebhookEvents["messages"] = [];
  const statuses: MessageStatus[] = [];
  let phoneNumberId: string | null = null;

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const value = change.value;
      phoneNumberId ??= value.metadata?.phone_number_id ?? null;

      const nameByWaId = new Map(
        (value.contacts ?? []).map((contact) => [contact.wa_id, contact.profile?.name ?? null]),
      );

      for (const message of value.messages ?? []) {
        messages.push({ message, profileName: nameByWaId.get(message.from) ?? null });
      }

      statuses.push(...(value.statuses ?? []));
    }
  }

  return { phoneNumberId, messages, statuses };
}
