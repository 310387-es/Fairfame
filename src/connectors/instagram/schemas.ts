import { z } from "zod";

/**
 * Instagram Graph API payload shapes (P1b-T4).
 *
 * Written against Meta's documented Graph contract and pinned with recorded
 * fixtures in `tests/fixtures/instagram/`. Nothing has been exercised against
 * the live API: the permissions this needs — `instagram_manage_comments` and
 * friends — come through Meta app review, which needs business verification,
 * which needs the company. See the two-stage Definition of Done in `docs/11`.
 *
 * Loose about extras, strict about what we use, for the same reason as the
 * WhatsApp schemas: Meta adds fields continuously, and rejecting an unknown key
 * would turn a harmless platform change into an outage.
 */

/** Meta's cursor pagination, shared by every list endpoint. */
const pagingSchema = z
  .object({
    cursors: z
      .object({ before: z.string().optional(), after: z.string().optional() })
      .loose()
      .optional(),
    next: z.string().optional(),
  })
  .loose();

/**
 * A comment on one of the business's own posts.
 *
 * `from` is present only when the commenter is reachable under the granted
 * permissions; Meta omits it for users who have not interacted with the app.
 * That is why the author is optional here and null-safe downstream — a comment
 * with no attributable author is still customer voice worth reading.
 */
export const commentSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().optional(),
    timestamp: z.string().optional(),
    username: z.string().optional(),
    from: z.object({ id: z.string(), username: z.string().optional() }).loose().optional(),
    /** Present when this comment is a reply to another. */
    parent_id: z.string().optional(),
    /** Our own replies come back in the same list; this is how we skip them. */
    is_hidden: z.boolean().optional(),
    media: z.object({ id: z.string(), permalink: z.string().optional() }).loose().optional(),
  })
  .loose();

export const commentsPageSchema = z
  .object({ data: z.array(commentSchema), paging: pagingSchema.optional() })
  .loose();

/**
 * A mention — someone else's post or comment that tagged the business.
 *
 * Meta exposes these through a separate edge and gives far less about them than
 * about a comment on your own media: often just the id and the caption.
 */
export const mentionSchema = z
  .object({
    id: z.string().min(1),
    caption: z.string().optional(),
    text: z.string().optional(),
    timestamp: z.string().optional(),
    username: z.string().optional(),
    permalink: z.string().optional(),
    media_type: z.string().optional(),
  })
  .loose();

export const mentionsPageSchema = z
  .object({ data: z.array(mentionSchema), paging: pagingSchema.optional() })
  .loose();

/** The business's own account, fetched once to confirm the connection. */
export const accountSchema = z
  .object({
    id: z.string().min(1),
    username: z.string().optional(),
    name: z.string().optional(),
  })
  .loose();

/** Meta's error envelope. Identical in shape to WhatsApp's. */
export const errorSchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
        type: z.string().optional(),
        code: z.number().optional(),
        error_subcode: z.number().optional(),
        fbtrace_id: z.string().optional(),
      })
      .loose(),
  })
  .loose();

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * A real-time comment or mention notification.
 *
 * The payload carries the id and, usually, the text — but Meta's own guidance
 * is to treat a webhook as a *signal* rather than a source of truth, because
 * fields vary by permission and by object type. The connector therefore uses it
 * to know something happened and re-reads through the Graph API.
 */
export const webhookSchema = z
  .object({
    object: z.string(),
    entry: z.array(
      z
        .object({
          id: z.string(),
          time: z.number().optional(),
          changes: z
            .array(
              z
                .object({
                  field: z.string(),
                  value: z
                    .object({
                      id: z.string().optional(),
                      text: z.string().optional(),
                      media_id: z.string().optional(),
                      comment_id: z.string().optional(),
                      from: z
                        .object({ id: z.string(), username: z.string().optional() })
                        .loose()
                        .optional(),
                    })
                    .loose(),
                })
                .loose(),
            )
            .optional(),
        })
        .loose(),
    ),
  })
  .loose();

export type InstagramComment = z.infer<typeof commentSchema>;
export type InstagramMention = z.infer<typeof mentionSchema>;
export type InstagramWebhook = z.infer<typeof webhookSchema>;

export type WebhookSignal = {
  /** The Instagram account the event belongs to. */
  accountId: string;
  field: string;
  objectId: string | null;
};

/** Flattens a webhook into "something changed on this account" signals. */
export function flattenWebhook(payload: InstagramWebhook): WebhookSignal[] {
  return payload.entry.flatMap((entry) =>
    (entry.changes ?? []).map((change) => ({
      accountId: entry.id,
      field: change.field,
      objectId: change.value.comment_id ?? change.value.id ?? null,
    })),
  );
}
