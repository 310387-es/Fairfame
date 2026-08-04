import { z } from "zod";
import { createInstagramClient, INSTAGRAM_PROVIDER, type InstagramClient } from "./client.ts";
import { commentSchema, directMessageSchema, mentionSchema } from "./schemas.ts";
import { RateLimitError } from "../throttle.ts";
import { childLogger } from "../../lib/logger.ts";
import {
  ConnectorError,
  type CanonicalReview,
  type Connection,
  type Connector,
  type RawReview,
} from "../types.ts";

/**
 * The Instagram connector (P1b-T4).
 *
 * Instagram is the first source whose items are **not reviews**. A comment has
 * no star rating, a mention is somebody else's post, and neither can be treated
 * as a rated opinion. They are still customer voice, so they normalize into the
 * canonical `reviews` table tagged with an `item_type` — `docs/03` §4 models
 * social sources as ordinary connectors for exactly this reason, and the
 * alternative (a second table) would mean a second inbox, a second analysis
 * path and a second digest for rows that differ in one column.
 *
 * Fixture-tested only. The permissions come through Meta app review.
 *
 * Two things this connector deliberately does not do:
 *
 *   - **It never invents a rating.** A comment arrives with `rating: null` and
 *     the database refuses anything else (`reviews_rating_only_on_reviews`).
 *     Mapping enthusiasm to stars would put a number nobody gave into the
 *     reputation pulse.
 *   - **It skips the business's own replies.** They come back in the same
 *     comments list, and ingesting them would have the product analysing its
 *     own words as customer feedback.
 */

const log = childLogger({ module: "connectors/instagram" });

const configSchema = z.object({
  locationId: z.uuid(),
  /** The Instagram Business account id this location maps to. */
  accountId: z.string().min(1),
  /** Cached for display; refreshed on connect. */
  username: z.string().optional(),
});

export type InstagramConfig = z.infer<typeof configSchema>;

/** Discriminates the three edges once they are in one list. */
type RawInstagramItem =
  | { kind: "comment"; payload: unknown }
  | { kind: "mention"; payload: unknown }
  | { kind: "dm"; payload: unknown };

export function createInstagramConnector(client?: InstagramClient): Connector {
  const api = client ?? createInstagramClient();

  return {
    provider: INSTAGRAM_PROVIDER,
    capabilities: { read: "full", reply: "api", realtime: true },

    async connect(organizationId, rawConfig) {
      const config = configSchema.parse(rawConfig);

      return {
        organizationId,
        locationId: config.locationId,
        provider: INSTAGRAM_PROVIDER,
        status: "pending",
        capabilities: { read: "full", reply: "api", realtime: true },
        config,
        encryptedTokens: null,
        cursor: null,
      };
    },

    async fetchReviews(connection: Connection, since?: Date): Promise<RawReview[]> {
      const config = configSchema.safeParse(connection.config);
      if (!config.success) {
        throw new ConnectorError(
          "This Instagram connection is not mapped to an account yet.",
          INSTAGRAM_PROVIDER,
          false,
        );
      }

      const [comments, mentions, messages] = [
        await api.listComments(connection, config.data.accountId, since),
        await api.listMentions(connection, config.data.accountId, since),
        // Separate permission from the other two (`instagram_manage_messages`),
        // so a business that has not been granted it still gets its comments
        // rather than an empty sync.
        await listDirectMessages(api, connection, config.data.accountId, since),
      ];

      const items: RawInstagramItem[] = [
        ...comments
          // Our own replies come back in the same list. Ingesting them would
          // have the product analysing its own words as customer feedback.
          .filter((comment) => comment.parent_id === undefined && comment.is_hidden !== true)
          .map((payload) => ({ kind: "comment" as const, payload })),
        ...mentions.map((payload) => ({ kind: "mention" as const, payload })),
        ...messages.map((payload) => ({ kind: "dm" as const, payload })),
      ];

      return items as unknown as RawReview[];
    },

    normalize(connection: Connection, raw: RawReview): CanonicalReview {
      const item = raw as unknown as RawInstagramItem;

      if (item.kind === "comment") return normalizeComment(connection, item.payload);
      if (item.kind === "dm") return normalizeDirectMessage(connection, item.payload);
      return normalizeMention(connection, item.payload);
    },

    async postReply(connection: Connection, sourceReviewId: string, text: string) {
      // `sourceReviewId` carries the item type as a prefix — see `itemId`.
      const [kind, id] = splitItemId(sourceReviewId);

      if (kind === "dm") {
        // Answering a DM is a *send*, not a reply to public content: it needs
        // the send gate, Meta's 24-hour customer-service window, and the
        // `instagram_manage_messages` scope. None of that is wired, and a
        // vague refusal here would read as a bug rather than a missing
        // feature. See `docs/13-go-live.md` §Instagram.
        return {
          ok: false,
          reason:
            "Answering Instagram direct messages is not built yet — messages can be read here " +
            "but must be replied to in the Instagram app.",
          retryable: false,
        };
      }

      if (kind !== "comment") {
        // Instagram offers no reply endpoint for a mention: the business does
        // not own the post. The capability view sends the owner to the platform
        // instead, and this is the backstop if that is bypassed.
        return {
          ok: false,
          reason: "Instagram only allows replying to comments on your own posts.",
          retryable: false,
        };
      }

      try {
        const replyId = await api.replyToComment(connection, id, text);
        return { ok: true, externalId: replyId };
      } catch (error) {
        const connectorError = error instanceof ConnectorError ? error : null;
        return {
          ok: false,
          reason: connectorError?.message ?? "Instagram rejected the reply.",
          retryable: connectorError?.retryable ?? false,
        };
      }
    },

    nextCursor(_connection, fetched) {
      // Newest timestamp seen, so the next sync asks Meta for anything after
      // it. Instagram's `since` is inclusive-ish and dedup makes an overlap
      // harmless, which is the safer direction to be wrong in.
      const times = (fetched as unknown as RawInstagramItem[])
        .map((item) => timestampOf(item.payload))
        .filter((value): value is string => value !== null);

      if (times.length === 0) return null;
      return times.sort().at(-1) ?? null;
    },
  };
}

/**
 * A stable id that survives all three edges sharing a namespace.
 *
 * A comment id, a mention id and a message id are all opaque Meta strings and
 * could in principle collide; prefixing keeps the dedup key in `reviews`
 * (organization, source, source_review_id) unambiguous, and lets `postReply`
 * know what it is replying to without another lookup.
 */
export function itemId(kind: "comment" | "mention" | "dm", id: string): string {
  return `${kind}:${id}`;
}

function splitItemId(value: string): [string, string] {
  const index = value.indexOf(":");
  return index === -1 ? ["comment", value] : [value.slice(0, index), value.slice(index + 1)];
}

/**
 * Fetches DMs, degrading this edge alone rather than the whole sync.
 *
 * Messages are additive to a connector whose main job is comments and mentions,
 * and `instagram_manage_messages` goes through app review *separately* — so the
 * ordinary state for a new business is comments granted, messages not. Letting
 * that fail the sync would cost them the ingestion they do have.
 *
 * The same reasoning covers a shape change on this edge: Meta altering the
 * conversations payload should not stop reviews arriving. So anything short of
 * a rate limit is logged and skipped.
 *
 * **A rate limit still propagates.** Swallowing it would drop the backoff the
 * throttle exists to apply, and the next sync would hammer an API that has
 * already said stop.
 */
async function listDirectMessages(
  api: InstagramClient,
  connection: Connection,
  accountId: string,
  since?: Date,
) {
  try {
    return await api.listDirectMessages(connection, accountId, since);
  } catch (error) {
    if (error instanceof RateLimitError) throw error;

    log.warn(
      {
        connectionId: connection.id,
        reason: error instanceof Error ? error.message : String(error),
        // The expected case before app review, and worth distinguishing in a
        // log from "Meta changed the payload", which is not expected at all.
        permission: error instanceof ConnectorError && error.kind === "permission",
      },
      "Instagram direct messages skipped this sync; comments and mentions are unaffected",
    );

    return [];
  }
}

/**
 * The posting time, whichever field this edge calls it.
 *
 * Comments and mentions carry `timestamp`; a DM comes from the Messenger
 * Platform and carries `created_time`. The cursor is built from this, so
 * missing the second name would mean a sync of only DMs never advanced.
 */
function timestampOf(payload: unknown): string | null {
  const item = payload as { timestamp?: unknown; created_time?: unknown };
  if (typeof item.timestamp === "string") return item.timestamp;
  return typeof item.created_time === "string" ? item.created_time : null;
}

function parseTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

function normalizeComment(connection: Connection, payload: unknown): CanonicalReview {
  const comment = commentSchema.parse(payload);

  return {
    locationId: connection.locationId,
    source: INSTAGRAM_PROVIDER,
    itemType: "comment",
    sourceReviewId: itemId("comment", comment.id),
    authorName: comment.from?.username ?? comment.username ?? null,
    // Never invented. A comment has no rating and the database enforces it.
    rating: null,
    text: comment.text ?? null,
    language: null,
    postedAt: parseTimestamp(comment.timestamp),
    url: comment.media?.permalink ?? null,
    rawPayload: comment,
  };
}

function normalizeMention(connection: Connection, payload: unknown): CanonicalReview {
  const mention = mentionSchema.parse(payload);

  return {
    locationId: connection.locationId,
    source: INSTAGRAM_PROVIDER,
    itemType: "mention",
    sourceReviewId: itemId("mention", mention.id),
    authorName: mention.username ?? null,
    rating: null,
    // A mention is usually a post, so the caption is the text. `text` covers
    // the case where the mention was itself a comment on someone else's post.
    text: mention.caption ?? mention.text ?? null,
    language: null,
    postedAt: parseTimestamp(mention.timestamp),
    url: mention.permalink ?? null,
    rawPayload: mention,
  };
}

/**
 * A direct message from a customer.
 *
 * The one item type here that is **private**. A comment and a mention are
 * public and the author published them; a DM was sent to the business alone,
 * and it lands in the same inbox because it is the same customer voice. It
 * carries no `url`, because there is nothing a colleague could open — which is
 * also the honest signal that this one is not on the record anywhere.
 */
function normalizeDirectMessage(connection: Connection, payload: unknown): CanonicalReview {
  const message = directMessageSchema.parse(payload);

  return {
    locationId: connection.locationId,
    source: INSTAGRAM_PROVIDER,
    itemType: "dm",
    sourceReviewId: itemId("dm", message.id),
    authorName: message.from?.username ?? null,
    rating: null,
    text: message.message ?? null,
    language: null,
    postedAt: parseTimestamp(message.created_time),
    // Deliberately null: a DM thread has no public permalink, and pointing at
    // the Instagram inbox would be a link to "somewhere in here".
    url: null,
    rawPayload: message,
  };
}

export const instagramConnector = createInstagramConnector();
