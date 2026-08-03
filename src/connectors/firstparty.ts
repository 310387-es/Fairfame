import { z } from "zod";
import { LOCALES } from "../i18n/config.ts";
import {
  ConnectorError,
  type CanonicalReview,
  type Capability,
  type Connection,
  type Connector,
  type NewConnection,
  type RawReview,
} from "./types.ts";

/**
 * FirstPartyConnector — reviews collected on our own hosted pages.
 *
 * The first *push* source, and the template for every webhook-driven connector
 * that follows (Instagram comments, WhatsApp messages in P1b-T3/T4). Where the
 * mock and Google are polled, this one is handed its data: the public
 * submission endpoint builds a `RawReview` and calls `normalize()` directly,
 * then writes through the same `upsertReviews()` path everything else uses.
 *
 * `fetchReviews()` therefore returns nothing, and that is the honest answer
 * rather than a stub — there is no upstream to poll. The scheduled sync still
 * visits the connection; it simply finds no new work, which keeps the
 * connection's status fresh at zero cost.
 *
 * No credentials, no OAuth, no provider flag: the source is ours, so unlike
 * T2–T4 this connector is live from the moment it is registered.
 */

export const FIRST_PARTY_PROVIDER = "firstparty";

export const firstPartyCapabilities: Capability = {
  // We hold the full text — it is submitted to us.
  read: "full",
  /**
   * `none`, not `api`. A public response to a first-party review needs a place
   * to appear, and the showcase widget that would display one is Phase 3. The
   * capability flips to `api` when that surface exists; declaring it now would
   * make the UI offer a reply box that posts into a void.
   */
  reply: "none",
  // Submissions land the moment they are made. Nothing to wait for.
  realtime: true,
};

export const firstPartyConfigSchema = z.object({
  locationId: z.uuid(),
});

export type FirstPartyConfig = z.infer<typeof firstPartyConfigSchema>;

/**
 * The payload the submission endpoint stores verbatim in `raw_payload`.
 *
 * Note what is *not* here: the submitter's email or phone. Those live once, on
 * `contacts`, and the payload keeps only `contactId`. A KVKK erasure request
 * then deletes one row instead of rewriting every jsonb blob that ever
 * mentioned the person.
 */
export const firstPartyPayloadSchema = z.object({
  submissionId: z.uuid(),
  rating: z.number().int().min(1).max(5),
  /** May be empty: a rating on its own is a legitimate review. */
  comment: z.string(),
  authorName: z.string().nullable(),
  language: z.enum(LOCALES),
  submittedAt: z.iso.datetime(),
  campaign: z.object({
    id: z.uuid(),
    slug: z.string(),
    channel: z.enum(["email", "sms", "whatsapp", "link"]),
  }),
  /** The ask this answers, when there was one. Null for a walk-in QR scan. */
  requestId: z.uuid().nullable(),
  contactId: z.uuid().nullable(),
  /**
   * Evidence about the KVKK notice. `shownAt` is always true of the page;
   * `accepted` records the explicit tick, which is only required when the
   * visitor left contact details. Keeping both apart avoids claiming consent
   * that was never given.
   */
  kvkkNotice: z.object({
    version: z.string(),
    shownAt: z.iso.datetime(),
    accepted: z.boolean(),
  }),
});

export type FirstPartyPayload = z.infer<typeof firstPartyPayloadSchema>;

/** Wraps a validated submission as the `RawReview` the ingest path expects. */
export function toRawReview(payload: FirstPartyPayload): RawReview {
  return { sourceReviewId: payload.submissionId, payload: { ...payload } };
}

export const firstPartyConnector: Connector = {
  provider: FIRST_PARTY_PROVIDER,
  capabilities: firstPartyCapabilities,

  async connect(organizationId: string, config: unknown): Promise<NewConnection> {
    const parsed = firstPartyConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConnectorError(
        `Cannot connect first-party collection: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
        FIRST_PARTY_PROVIDER,
        false,
      );
    }

    return {
      organizationId,
      locationId: parsed.data.locationId,
      provider: FIRST_PARTY_PROVIDER,
      // Active immediately: there is no handshake to wait for.
      status: "active",
      capabilities: firstPartyCapabilities,
      config: parsed.data,
      encryptedTokens: null,
      cursor: null,
    };
  },

  /** A push source has nothing to pull. See the module comment. */
  async fetchReviews(): Promise<RawReview[]> {
    return [];
  },

  normalize(connection: Connection, raw: RawReview): CanonicalReview {
    const parsed = firstPartyPayloadSchema.safeParse(raw.payload);
    if (!parsed.success) {
      throw new ConnectorError(
        `Unexpected first-party payload for submission "${raw.sourceReviewId}": ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
        FIRST_PARTY_PROVIDER,
        false,
      );
    }

    const payload = parsed.data;
    const comment = payload.comment.trim();

    return {
      locationId: connection.locationId,
      source: FIRST_PARTY_PROVIDER,
      sourceReviewId: payload.submissionId,
      authorName: payload.authorName,
      rating: payload.rating,
      // A rating with no words is stored as a rating with no text, not as "".
      text: comment.length > 0 ? comment : null,
      language: payload.language,
      postedAt: new Date(payload.submittedAt),
      // No public permalink yet — first-party reviews get one when the showcase
      // widget ships (Phase 3).
      url: null,
      rawPayload: raw.payload,
    };
  },
};
