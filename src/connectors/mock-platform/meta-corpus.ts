import { generateCorpus } from "../mock-data.ts";

/**
 * What the fake Instagram account is holding, and how it grows.
 *
 * Same idea as the Google corpus and a deliberately different shape, because
 * Instagram's is different: comments hang off *media* rather than standing
 * alone, timestamps are `+0000` rather than `Z`, and mentions arrive on a
 * separate edge entirely. A corpus that flattened those into one list would let
 * a connector pass here and fail against the real API on its first hour.
 *
 * The drip works as it does for Google — everything is generated once and dated,
 * and visibility is a function of the clock — so two processes agree and a test
 * can rewind time.
 */

export type InstagramComment = {
  id: string;
  text: string;
  timestamp: string;
  username: string;
  parent_id?: string;
};

export type InstagramMedia = {
  id: string;
  permalink: string;
  timestamp: string;
  comments?: { data: InstagramComment[] };
};

export type InstagramMention = {
  id: string;
  caption: string;
  timestamp: string;
  username: string;
  permalink: string;
  media_type: string;
};

/**
 * A DM, in Messenger Platform shape.
 *
 * `created_time` rather than `timestamp`, and a `from` that is always there —
 * the differences are the point. A connector that assumed the media-edge shape
 * would parse nothing here, and it would parse nothing against the real API too.
 */
export type InstagramDirectMessage = {
  id: string;
  message: string;
  created_time: string;
  from: { id: string; username: string };
};

export type InstagramConversation = {
  id: string;
  updated_time: string;
  messages: { data: InstagramDirectMessage[] };
};

export type MetaCorpusOptions = {
  accountId: string;
  username: string;
  backfill?: number;
  dripMs?: number;
  seed?: string;
  startedAt?: Date;
};

/** Instagram stamps `+0000`, not `Z`. Connectors that assume `Z` break on it. */
function metaTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "+0000");
}

/** Comments per post, so the media edge is not one-comment-per-media forever. */
const COMMENTS_PER_MEDIA = 3;

export function createMetaCorpus(options: MetaCorpusOptions) {
  const backfill = options.backfill ?? 18;
  const dripMs = options.dripMs ?? 30_000;
  const startedAt = options.startedAt ?? new Date();

  // The same generator the rest of the product uses, so the words are the same
  // Turkish and English a reviewer would actually write.
  const pool = generateCorpus({
    locationId: options.accountId,
    count: backfill + 400,
    until: startedAt,
    seed: options.seed ?? "meta-platform",
    batchTag: "meta",
  });

  const mediaCount = Math.max(1, Math.ceil(backfill / COMMENTS_PER_MEDIA));

  const media: InstagramMedia[] = Array.from({ length: mediaCount }, (_, index) => {
    const at = new Date(startedAt.getTime() - (mediaCount - index) * 86_400_000);
    return {
      id: `1789${String(index).padStart(13, "0")}`,
      permalink: `https://www.instagram.com/p/MOCK${index}/`,
      timestamp: metaTime(at),
      comments: {
        data: pool
          .slice(index * COMMENTS_PER_MEDIA, (index + 1) * COMMENTS_PER_MEDIA)
          .map((payload, offset): InstagramComment => ({
            id: `1787${String(index * COMMENTS_PER_MEDIA + offset).padStart(13, "0")}`,
            text: payload.comment,
            timestamp: metaTime(new Date(payload.createdAt)),
            username: payload.author.name.toLowerCase().replace(/[^a-z]/g, "") || "misafir",
          })),
      },
    };
  });

  // Comments that have not been left yet, each on the newest post.
  const upcoming = pool.slice(backfill).map((payload, index) => {
    const at = new Date(startedAt.getTime() + (index + 1) * dripMs);
    return {
      at,
      comment: {
        id: `1799${String(index).padStart(13, "0")}`,
        text: payload.comment,
        timestamp: metaTime(at),
        username: payload.author.name.toLowerCase().replace(/[^a-z]/g, "") || "misafir",
      } satisfies InstagramComment,
    };
  });

  const mentions: InstagramMention[] = pool
    .slice(0, Math.max(2, Math.floor(backfill / 4)))
    .map((payload, index): InstagramMention => ({
      id: `1791${String(index).padStart(13, "0")}`,
      caption: `${payload.comment} @${options.username}`,
      timestamp: metaTime(new Date(payload.createdAt)),
      username: `gezgin${index}`,
      permalink: `https://www.instagram.com/p/MENTION${index}/`,
      media_type: "IMAGE",
    }));

  /**
   * DM threads, each mixing the customer's messages with the business's own.
   *
   * Both sides are present deliberately. A conversation on the real API
   * contains the business's replies too, and the only thing distinguishing
   * them is `from.id` — so a connector that forgot to filter would ingest its
   * own support answers as customer feedback and pass a test that only ever
   * returned inbound messages.
   */
  const conversations: InstagramConversation[] = pool
    .slice(0, Math.max(2, Math.floor(backfill / 3)))
    .map((payload, index): InstagramConversation => {
      const at = new Date(payload.createdAt);
      const customerId = `1780${String(index).padStart(13, "0")}`;
      const customerName = payload.author.name.toLowerCase().replace(/[^a-z]/g, "") || "misafir";

      return {
        id: `aWdfZG${String(index).padStart(10, "0")}`,
        updated_time: metaTime(at),
        messages: {
          data: [
            {
              id: `mid.${String(index).padStart(12, "0")}A`,
              message: payload.comment,
              created_time: metaTime(at),
              from: { id: customerId, username: customerName },
            },
            // The business's own answer, in the same thread.
            {
              id: `mid.${String(index).padStart(12, "0")}B`,
              message: "Merhaba, ilginiz için teşekkürler!",
              created_time: metaTime(new Date(at.getTime() + 3_600_000)),
              from: { id: options.accountId, username: options.username },
            },
          ],
        },
      };
    });

  /** Replies the account has posted, keyed by the comment they answer. */
  const replies = new Map<string, string>();

  function withinSince<T extends { timestamp: string }>(items: T[], since: Date | null): T[] {
    if (!since) return items;
    return items.filter((item) => new Date(item.timestamp) >= since);
  }

  return {
    mediaAt(now: Date, since: Date | null): InstagramMedia[] {
      const arrived = upcoming.filter((entry) => entry.at <= now).map((entry) => entry.comment);

      return media.map((post, index) => {
        // New comments land on the most recent post, which is where they land
        // in life too.
        const own =
          index === media.length - 1
            ? [...(post.comments?.data ?? []), ...arrived]
            : (post.comments?.data ?? []);

        return { ...post, comments: { data: withinSince(own, since) } };
      });
    },

    mentionsAt(_now: Date, since: Date | null): InstagramMention[] {
      return withinSince(mentions, since);
    },

    conversationsAt(_now: Date, since: Date | null): InstagramConversation[] {
      if (!since) return conversations;

      // Filtered on the thread's `updated_time`, as Meta does — a thread whose
      // last activity predates `since` is not returned at all, rather than
      // returned with an empty message list.
      return conversations.filter((thread) => new Date(thread.updated_time) >= since);
    },

    /** Returns the new reply's id, or null when the comment is unknown. */
    replyToComment(commentId: string, message: string, now: Date): string | null {
      const known =
        media.some((post) => post.comments?.data.some((comment) => comment.id === commentId)) ||
        upcoming.some((entry) => entry.comment.id === commentId);

      if (!known) return null;

      const replyId = `1788${String(replies.size).padStart(13, "0")}`;
      replies.set(commentId, message);
      void now;
      return replyId;
    },

    repliesGiven: replies,
  };
}

export type MetaCorpus = ReturnType<typeof createMetaCorpus>;
