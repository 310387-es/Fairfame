import { z } from "zod";
import { RateLimitError } from "../throttle.ts";
import { accessTokenForConnection } from "../tokens.ts";
import { ConnectorError, type Connection } from "../types.ts";
import {
  accountSchema,
  commentSchema,
  commentsPageSchema,
  conversationsPageSchema,
  errorSchema,
  mentionsPageSchema,
  type InstagramComment,
  type InstagramDirectMessage,
  type InstagramMention,
} from "./schemas.ts";

/**
 * The expanded media+comments shape.
 *
 * Instagram has no account-level comments edge, so the request asks for media
 * with their comments nested — one round trip instead of one per post.
 */
const mediaWithCommentsSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string(),
          permalink: z.string().optional(),
          timestamp: z.string().optional(),
          comments: z
            .object({ data: z.array(commentSchema) })
            .loose()
            .optional(),
        })
        .loose(),
    ),
  })
  .loose();

/**
 * The Instagram Graph API client (P1b-T4).
 *
 * Fixture-tested only — the permissions this needs come through Meta app
 * review, which needs business verification, which needs the company.
 *
 * Everything funnels through `request()` so auth, throttling and error
 * classification happen once. Instagram's failure modes are worth separating
 * because they mean genuinely different things to an operator: a permission
 * that was never granted is an app-review problem, a token that expired is a
 * reconnect, and a rate limit is neither.
 */

export const INSTAGRAM_PROVIDER = "instagram";

export type InstagramFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type InstagramClientOptions = {
  fetchImpl?: InstagramFetch;
  /** Resolves a live access token. Defaults to the vault-backed reader. */
  readToken?: (connection: Connection) => Promise<string>;
  baseUrl?: string;
};

const DEFAULT_BASE_URL = "https://graph.facebook.com/v21.0";

/**
 * Meta error codes worth branching on.
 *
 * As in the WhatsApp client, the keys *are* the returned kinds — a mismatch
 * there once meant a rate limit never triggered backoff.
 */
const ERROR_CODES = {
  rate_limit: [4, 17, 32, 613],
  /** The token is gone: expired, revoked, or the user changed their password. */
  auth: [190, 102, 463, 467],
  /** We are asking for something app review has not granted. */
  permission: [10, 200, 803],
} as const;

export type ErrorKind = keyof typeof ERROR_CODES | "unknown";

function classify(code: number | undefined): ErrorKind {
  if (code === undefined) return "unknown";
  for (const kind of Object.keys(ERROR_CODES) as (keyof typeof ERROR_CODES)[]) {
    if ((ERROR_CODES[kind] as readonly number[]).includes(code)) return kind;
  }
  return "unknown";
}

export type InstagramClient = {
  /** Confirms the connection and returns the account it points at. */
  getAccount(
    connection: Connection,
    accountId: string,
  ): Promise<{ id: string; username: string | null }>;
  /** Comments on the business's own media, newest first. */
  listComments(
    connection: Connection,
    accountId: string,
    since?: Date,
  ): Promise<InstagramComment[]>;
  /** Posts and comments elsewhere that tagged the business. */
  listMentions(
    connection: Connection,
    accountId: string,
    since?: Date,
  ): Promise<InstagramMention[]>;
  /**
   * Direct messages the business has received.
   *
   * Returns *inbound* messages only — the business's own replies are filtered
   * out here rather than downstream, because `accountId` is what identifies
   * them and this is the last place that is unambiguously in scope.
   */
  listDirectMessages(
    connection: Connection,
    accountId: string,
    since?: Date,
  ): Promise<InstagramDirectMessage[]>;
  /** Replies to a comment. Only comments — Instagram has no reply-to-mention. */
  replyToComment(connection: Connection, commentId: string, message: string): Promise<string>;
};

export function createInstagramClient(options: InstagramClientOptions = {}): InstagramClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const readToken = options.readToken ?? accessTokenForConnection;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

  async function request<T>(
    connection: Connection,
    path: string,
    parse: (payload: unknown) => T,
    init?: RequestInit & { query?: Record<string, string | undefined> },
  ): Promise<T> {
    const token = await readToken(connection);
    const url = new URL(`${baseUrl}${path}`);

    for (const [key, value] of Object.entries(init?.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        ...init,
        headers: { ...init?.headers, authorization: `Bearer ${token}` },
      });
    } catch (error) {
      throw new ConnectorError(
        `Could not reach the Instagram API: ${error instanceof Error ? error.message : "unknown"}`,
        INSTAGRAM_PROVIDER,
        true,
      );
    }

    const payload: unknown = await response.json().catch(() => ({}));

    if (!response.ok) {
      const parsed = errorSchema.safeParse(payload);
      const code = parsed.success ? parsed.data.error.code : undefined;
      const kind = classify(code);
      const message = parsed.success ? (parsed.data.error.message ?? "") : "";

      if (kind === "rate_limit" || response.status === 429) {
        // Meta does not send Retry-After on Graph; their guidance is an hour
        // for an app-level throttle, which is what these codes indicate.
        throw new RateLimitError(
          INSTAGRAM_PROVIDER,
          60 * 60_000,
          `Instagram rate limit: ${message}`,
        );
      }

      throw new ConnectorError(
        describe(kind, code, message),
        INSTAGRAM_PROVIDER,
        // A missing permission and a revoked token will fail identically until
        // a human does something; a 5xx will not.
        kind === "unknown" && response.status >= 500,
        // Carried through rather than left in the prose: a missing scope can
        // affect one edge and not the others, and the connector needs to know
        // that without reading the message.
        kind === "permission" || kind === "auth" ? kind : undefined,
      );
    }

    return parse(payload);
  }

  /** Meta's `since` is Unix seconds, not milliseconds or ISO. */
  const sinceParam = (since?: Date): string | undefined =>
    since ? String(Math.floor(since.getTime() / 1_000)) : undefined;

  return {
    async getAccount(connection, accountId) {
      const account = await request(
        connection,
        `/${encodeURIComponent(accountId)}`,
        (payload) => accountSchema.parse(payload),
        { query: { fields: "id,username,name" } },
      );

      return { id: account.id, username: account.username ?? null };
    },

    async listComments(connection, accountId, since) {
      // One hop: media, then each media's comments. Instagram has no
      // account-level comments edge, which is why the field expansion below
      // does the join for us rather than N requests.
      const page = await request(
        connection,
        `/${encodeURIComponent(accountId)}/media`,
        (payload) => {
          const parsed = mediaWithCommentsSchema.parse(payload);
          return parsed.data.flatMap((media) =>
            (media.comments?.data ?? []).map((comment) => ({
              ...comment,
              media: { id: media.id, permalink: media.permalink },
            })),
          );
        },
        {
          query: {
            fields:
              "id,permalink,timestamp,comments{id,text,timestamp,username,from,parent_id,is_hidden}",
            since: sinceParam(since),
            limit: "50",
          },
        },
      );

      return page;
    },

    async listMentions(connection, accountId, since) {
      const page = await request(
        connection,
        `/${encodeURIComponent(accountId)}/tags`,
        (payload) => mentionsPageSchema.parse(payload).data,
        {
          query: {
            fields: "id,caption,timestamp,username,permalink,media_type",
            since: sinceParam(since),
            limit: "50",
          },
        },
      );

      return page;
    },

    async listDirectMessages(connection, accountId, since) {
      // The Messenger Platform edge, not an Instagram media one — hence
      // `platform=instagram`, which is what stops this returning Facebook Page
      // threads for a business that runs both.
      const conversations = await request(
        connection,
        `/${encodeURIComponent(accountId)}/conversations`,
        (payload) => conversationsPageSchema.parse(payload).data,
        {
          query: {
            platform: "instagram",
            fields: "id,updated_time,messages{id,message,created_time,from}",
            since: sinceParam(since),
            limit: "50",
          },
        },
      );

      return conversations.flatMap((conversation) =>
        (conversation.messages?.data ?? [])
          // The business's own replies live in the same thread. Ingesting them
          // would have the product analysing its own support answers as
          // customer feedback — the same trap as our own comment replies.
          .filter((message) => message.from?.id !== accountId)
          .map((message) => ({ ...message, conversation_id: conversation.id })),
      );
    },

    async replyToComment(connection, commentId, message) {
      const result = await request(
        connection,
        `/${encodeURIComponent(commentId)}/replies`,
        (payload) => accountSchema.pick({ id: true }).parse(payload),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        },
      );

      return result.id;
    },
  };
}

function describe(kind: ErrorKind, code: number | undefined, message: string): string {
  switch (kind) {
    case "permission":
      return (
        `Instagram refused the request for lack of a permission (code ${code}). The Meta app ` +
        `most likely has not been granted instagram_manage_comments through app review yet.`
      );
    case "auth":
      return (
        `Instagram rejected the credentials (code ${code}). The token has expired or been ` +
        `revoked; the owner needs to reconnect the account.`
      );
    default:
      return `Instagram request failed${code === undefined ? "" : ` (code ${code})`}: ${message}`;
  }
}

export { commentsPageSchema };
