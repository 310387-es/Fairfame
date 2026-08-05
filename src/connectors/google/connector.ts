import { z } from "zod";
import {
  ConnectorError,
  type CanonicalReview,
  type Capability,
  type Connection,
  type Connector,
  type NewConnection,
  type RawReview,
  type ReplyResult,
} from "../types.ts";
import {
  createGoogleClient,
  GOOGLE_PROVIDER,
  MAX_REPLY_LENGTH,
  type GoogleClientOptions,
} from "./client.ts";
import { googleReviewSchema, starsToNumber } from "./schemas.ts";

/**
 * The Google Business Profile connector (P1b-T2).
 *
 * Built against Google's documented response shapes with recorded fixtures, and
 * **not yet verified against the live API** — that is the second stage of the
 * Definition of Done and waits on an approved API access request. Expect a
 * rework pass at go-live: these APIs have quirks the reference does not mention,
 * and the honest thing is to say so here rather than discover it in production.
 *
 * What is deliberate rather than provisional:
 *
 * - **Two ids, not one.** The v4 reviews endpoint is addressed by account *and*
 *   location, while the Business Information API returns locations without an
 *   account prefix. Both are stored in `config` at mapping time.
 * - **Cursor by `updateTime`, not `createTime`.** An edited review, or one that
 *   gains an owner reply, moves in `updateTime` order and must be re-ingested;
 *   ordering by creation would miss every edit.
 * - **No language field.** Google does not return one. Rather than guess from
 *   the text, `language` is left null for the AI layer to fill in — a wrong
 *   language tag would route a Turkish review to an English prompt.
 */

export const googleCapabilities: Capability = {
  read: "full",
  reply: "api",
  // Reviews are polled. Google has no webhook for them.
  realtime: false,
};

/**
 * Config written at mapping time (see ./mapping.ts). `locationId` is ours;
 * `googleAccountId` and `googleLocationId` are Google's.
 */
export const googleConfigSchema = z.object({
  locationId: z.uuid(),
  googleAccountId: z.string().min(1).max(64),
  googleLocationId: z.string().min(1).max(64),
  /** Kept for display so the UI need not call Google to render a card. */
  googleLocationTitle: z.string().max(300).optional(),
});

export type GoogleConfig = z.infer<typeof googleConfigSchema>;

/** Config before mapping: the connection exists, the place is not chosen yet. */
export const googlePendingConfigSchema = z.object({ locationId: z.uuid() });

/** Stop paginating after this many pages, whatever Google says. */
const MAX_PAGES = 40;

/**
 * A Google timestamp, or null when it will not parse.
 *
 * The API's own schema types these as plain strings, so a malformed one is a
 * possibility rather than a contradiction. Null is the right answer: an
 * unparseable reply time must leave the review looking unanswered rather than
 * putting an `Invalid Date` into a column the whole inbox filters on.
 */
function parseTimestamp(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseConfig(connection: Connection): GoogleConfig {
  const parsed = googleConfigSchema.safeParse(connection.config);

  if (!parsed.success) {
    throw new ConnectorError(
      "This Google connection has not been mapped to a business location yet. " +
        "Finish setup to choose which location to sync.",
      GOOGLE_PROVIDER,
      // A human has to pick a location; retrying changes nothing.
      false,
    );
  }

  return parsed.data;
}

export function createGoogleConnector(options: GoogleClientOptions = {}): Connector {
  const client = createGoogleClient(options);

  return {
    provider: GOOGLE_PROVIDER,
    capabilities: googleCapabilities,

    async connect(organizationId: string, config: unknown): Promise<NewConnection> {
      const parsed = googlePendingConfigSchema.safeParse(config);
      if (!parsed.success) {
        throw new ConnectorError(
          `Cannot connect Google: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
          GOOGLE_PROVIDER,
          false,
        );
      }

      return {
        organizationId,
        locationId: parsed.data.locationId,
        provider: GOOGLE_PROVIDER,
        // Authorized but unmapped. The OAuth callback creates the row; the
        // mapping step promotes it to active.
        status: "pending",
        capabilities: googleCapabilities,
        config: parsed.data,
        encryptedTokens: null,
        cursor: null,
      };
    },

    /**
     * Walks review pages newest-first, stopping at the cursor.
     *
     * `since` is compared against `updateTime` because that is what the pages
     * are ordered by. The comparison is `<=`, so a re-run with an unchanged
     * cursor fetches nothing rather than re-ingesting the boundary review on
     * every sync.
     */
    async fetchReviews(connection: Connection, since?: Date): Promise<RawReview[]> {
      const config = parseConfig(connection);
      const collected: RawReview[] = [];
      let pageToken: string | undefined;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await client.listReviews(connection, {
          accountId: config.googleAccountId,
          locationId: config.googleLocationId,
          ...(pageToken ? { pageToken } : {}),
        });

        for (const review of result.reviews ?? []) {
          if (since) {
            const updated = Date.parse(review.updateTime);
            // Ordered desc, so the first review at or before the cursor means
            // everything after it is older too.
            if (!Number.isNaN(updated) && updated <= since.getTime()) {
              return collected;
            }
          }

          collected.push({ sourceReviewId: review.reviewId, payload: { ...review } });
        }

        pageToken = result.nextPageToken;
        if (!pageToken) return collected;
      }

      throw new ConnectorError(
        `Google paginated past ${MAX_PAGES} pages of reviews; refusing to continue.`,
        GOOGLE_PROVIDER,
        false,
      );
    },

    async postReply(
      connection: Connection,
      sourceReviewId: string,
      text: string,
    ): Promise<ReplyResult> {
      const config = parseConfig(connection);
      const comment = text.trim();

      if (comment.length === 0) {
        return { ok: false, reason: "A reply cannot be empty.", retryable: false };
      }
      if (comment.length > MAX_REPLY_LENGTH) {
        // Checked here rather than letting Google reject it: the caller can
        // shorten the draft, and a 400 would otherwise look like an outage.
        return {
          ok: false,
          reason: `Google limits replies to ${MAX_REPLY_LENGTH} characters; this one is ${comment.length}.`,
          retryable: false,
        };
      }

      try {
        await client.updateReply(connection, {
          accountId: config.googleAccountId,
          locationId: config.googleLocationId,
          reviewId: sourceReviewId,
          comment,
        });

        // Google's reply has no id of its own — it is a property of the review,
        // and PUT replaces it. The review id is the only stable handle.
        return { ok: true, externalId: sourceReviewId };
      } catch (error) {
        if (error instanceof ConnectorError) {
          return { ok: false, reason: error.message, retryable: error.retryable };
        }
        return {
          ok: false,
          reason: error instanceof Error ? error.message : "Unknown error posting the reply.",
          retryable: true,
        };
      }
    },

    normalize(connection: Connection, raw: RawReview): CanonicalReview {
      const parsed = googleReviewSchema.safeParse(raw.payload);
      if (!parsed.success) {
        throw new ConnectorError(
          `Unexpected Google review payload for "${raw.sourceReviewId}": ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
          GOOGLE_PROVIDER,
          false,
        );
      }

      const review = parsed.data;
      const comment = review.comment?.trim() ?? "";

      return {
        locationId: connection.locationId,
        source: GOOGLE_PROVIDER,
        sourceReviewId: review.reviewId,
        // An anonymous reviewer has no name, and inventing one would be worse
        // than showing none.
        authorName: review.reviewer?.displayName ?? null,
        rating: starsToNumber(review.starRating),
        text: comment.length > 0 ? comment : null,
        // Google does not report the review's language. See the module comment.
        language: null,
        postedAt: new Date(review.createTime),
        // v4 exposes no per-review permalink. The location's Maps URI is the
        // closest thing and belongs on the connection, not on every row.
        url: null,
        /**
         * The owner's own reply, made in Google Business Profile (W1.2).
         *
         * This is the case the whole work package is about: most owners were
         * already answering in Google before they had us, and the Inbox used to
         * look for a key named `ownerReply` — which Google has never sent — so
         * every one of those reviews read as unanswered and went overdue.
         *
         * `updateTime` on the reply is optional in the API, so fall back to the
         * review's own: Google moves it when a reply is added, which makes it
         * the closest honest answer to "when". Only ever consulted when a reply
         * is actually present.
         */
        ownerRepliedAt: review.reviewReply
          ? parseTimestamp(review.reviewReply.updateTime ?? review.updateTime)
          : null,
        rawPayload: raw.payload,
      };
    },

    /**
     * Resume point for the next sync: the newest `updateTime` seen.
     *
     * Parsed defensively — one malformed timestamp must not poison the cursor
     * and stall the connection forever.
     */
    nextCursor(connection: Connection, fetched: RawReview[]): string | null {
      if (fetched.length === 0) return null;

      const newest = fetched.reduce<number>((latest, raw) => {
        const value = (raw.payload as { updateTime?: unknown }).updateTime;
        const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
        return Number.isNaN(time) ? latest : Math.max(latest, time);
      }, Number.NEGATIVE_INFINITY);

      return newest === Number.NEGATIVE_INFINITY
        ? connection.cursor
        : new Date(newest).toISOString();
    },
  };
}

/** The connector as registered in production. */
export const googleConnector = createGoogleConnector();
