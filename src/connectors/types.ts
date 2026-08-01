import { z } from "zod";

/**
 * The Connector interface — the core abstraction for every review and social
 * source. Google, Instagram, WhatsApp and first-party forms all arrive through
 * this shape, so nothing downstream of `normalize()` knows which source it came
 * from.
 *
 * Contract source: docs/09-phase-0-build-plan.md. Two deliberate refinements:
 *
 * 1. `connect()` returns a `NewConnection` (no `id`). Minting ids and writing
 *    rows is the data layer's job; a connector that persisted its own row would
 *    have to know about tenancy and RLS, which is exactly what it must not.
 * 2. `RawReview` carries the untouched provider response in `payload`. Every
 *    connector validates that payload with its own Zod schema inside
 *    `normalize()`, because a provider response is external input.
 */

export const capabilitySchema = z.object({
  read: z.enum(["full", "excerpt", "none"]),
  reply: z.enum(["api", "manual", "none"]),
  realtime: z.boolean(),
});

export type Capability = z.infer<typeof capabilitySchema>;

export type ConnectionStatus = "pending" | "active" | "error" | "disconnected";

/** A persisted source connection, as the connector sees it. */
export type Connection = {
  id: string;
  organizationId: string;
  locationId: string;
  provider: string;
  status: ConnectionStatus;
  capabilities: Capability;
  /** Non-secret, connector-specific settings. */
  config: Record<string, unknown>;
  encryptedTokens: string | null;
  /** Opaque provider sync position. The connector alone decides its meaning. */
  cursor: string | null;
  /**
   * When the connection was made. Connectors use it as a stable anchor: a
   * source's historical reviews must not shift in time just because they were
   * fetched again.
   */
  createdAt: Date;
};

/** What `connect()` hands back for the data layer to persist. */
export type NewConnection = Omit<Connection, "id" | "createdAt">;

/**
 * One review exactly as the provider returned it.
 * `payload` is stored verbatim in `reviews.raw_payload` and is never discarded:
 * it is the audit trail and the raw material for later re-normalization.
 */
export type RawReview = {
  /** The provider's own identifier — becomes `source_review_id`. */
  sourceReviewId: string;
  payload: Record<string, unknown>;
};

/**
 * A review in the canonical shape, ready for the `reviews` table.
 * `organizationId` is absent on purpose: it comes from the tenant context at
 * write time, never from the connector, so a connector cannot direct rows into
 * another tenant.
 */
export type CanonicalReview = {
  locationId: string;
  source: string;
  sourceReviewId: string;
  authorName: string | null;
  rating: number | null;
  text: string | null;
  /** BCP-47-ish language tag, e.g. "tr" or "en". */
  language: string | null;
  postedAt: Date | null;
  url: string | null;
  rawPayload: Record<string, unknown>;
};

export type ReplyResult =
  { ok: true; externalId: string | null } | { ok: false; reason: string; retryable: boolean };

/** Thrown for provider-side failures so the job layer can decide about retries. */
export class ConnectorError extends Error {
  // Written out as explicit fields rather than TypeScript parameter
  // properties: Node's strip-only type stripping — which is how scripts/ and
  // the worker process run — rejects parameter properties outright.
  readonly provider: string;
  readonly retryable: boolean;

  constructor(message: string, provider: string, retryable = true) {
    super(message);
    this.name = "ConnectorError";
    this.provider = provider;
    this.retryable = retryable;
  }
}

export interface Connector {
  readonly provider: string;
  readonly capabilities: Capability;

  /** Validates config and describes the connection to persist. */
  connect(organizationId: string, config: unknown): Promise<NewConnection>;

  /**
   * Reviews created or updated since `since`. When `since` is omitted the
   * connector returns its full backfill.
   */
  fetchReviews(connection: Connection, since?: Date): Promise<RawReview[]>;

  /** Present only when `capabilities.reply === "api"`. */
  postReply?(connection: Connection, sourceReviewId: string, text: string): Promise<ReplyResult>;

  /** Provider payload → canonical row. Pure, and must validate its input. */
  normalize(connection: Connection, raw: RawReview): CanonicalReview;

  /**
   * Where to resume next time, given what was just fetched. Returning null
   * leaves the cursor untouched.
   */
  nextCursor?(connection: Connection, fetched: RawReview[]): string | null;
}
