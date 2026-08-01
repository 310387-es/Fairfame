import { z } from "zod";
import { generateCorpus, type MockReviewPayload } from "./mock-data.ts";
import {
  ConnectorError,
  type CanonicalReview,
  type Capability,
  type Connection,
  type Connector,
  type NewConnection,
  type RawReview,
  type ReplyResult,
} from "./types.ts";

/**
 * MockConnector — the reference implementation of the Connector contract.
 *
 * Everything downstream (sync jobs, the Inbox, dedup) is built and tested
 * against this, so the real Google and Meta connectors can swap in later with
 * no changes outside their own module.
 *
 * Behaviour is a pure function of (location id, config, clock). There is no
 * hidden state, which means a worker process and a web request generate the
 * same reviews for the same connection, and tests are reproducible.
 */

export const MOCK_PROVIDER = "mock";

export const mockCapabilities: Capability = {
  read: "full",
  reply: "api",
  realtime: false,
};

export const mockConfigSchema = z.object({
  locationId: z.uuid(),
  /** Size of the initial backfill. The plan calls for 30–50 per location. */
  backfillCount: z.number().int().min(0).max(500).default(40),
  /** How far back the backfill reaches. */
  spanDays: z.number().int().min(1).max(3650).default(180),
  /**
   * Emit one new review per interval so the scheduled sync in T8 has something
   * to discover. Null disables the drip.
   */
  dripIntervalMinutes: z.number().int().min(1).max(10_080).nullable().default(null),
  /** Varies the corpus without changing the location. */
  seed: z.string().max(64).default(""),
  /** Deterministic failure injection for exercising retry and error paths. */
  simulate: z
    .object({
      failFetch: z.boolean().default(false),
      failReply: z.boolean().default(false),
      retryable: z.boolean().default(true),
    })
    .default({ failFetch: false, failReply: false, retryable: true }),
});

export type MockConfig = z.infer<typeof mockConfigSchema>;

/** The payload shape the mock puts in `raw_payload`, re-validated on the way out. */
const mockPayloadSchema = z.object({
  id: z.string(),
  author: z.object({ name: z.string() }),
  rating: z.number().int().min(1).max(5),
  comment: z.string(),
  language: z.enum(["tr", "en"]),
  createdAt: z.iso.datetime(),
  permalink: z.string(),
  themes: z.array(z.string()),
  ownerReply: z.object({ text: z.string(), repliedAt: z.iso.datetime() }).optional(),
});

function parseConfig(connection: Connection): MockConfig {
  const result = mockConfigSchema.safeParse(connection.config);
  if (!result.success) {
    throw new ConnectorError(
      `Invalid mock connection config: ${result.error.issues.map((i) => i.message).join("; ")}`,
      MOCK_PROVIDER,
      false, // a bad config will not fix itself on retry
    );
  }
  return result.data;
}

function toRaw(payload: MockReviewPayload): RawReview {
  return { sourceReviewId: payload.id, payload: { ...payload } };
}

/**
 * Drip batches are derived from the clock rather than stored, so any process
 * computing them at the same moment produces the same reviews. Each elapsed
 * interval since the connection's epoch contributes one review.
 */
function dripReviews(config: MockConfig, now: Date): MockReviewPayload[] {
  if (config.dripIntervalMinutes === null) return [];

  const intervalMs = config.dripIntervalMinutes * 60_000;
  const bucket = Math.floor(now.getTime() / intervalMs);

  // Only the most recent handful matter; older drips are already ingested.
  const buckets = [bucket - 2, bucket - 1, bucket];

  return buckets.flatMap((current) =>
    generateCorpus({
      locationId: config.locationId,
      count: 1,
      until: new Date(current * intervalMs),
      spanDays: 1,
      seed: config.seed,
      batchTag: `drip${current}`,
    }),
  );
}

export const mockConnector: Connector = {
  provider: MOCK_PROVIDER,
  capabilities: mockCapabilities,

  async connect(organizationId: string, config: unknown): Promise<NewConnection> {
    const parsed = mockConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConnectorError(
        `Cannot connect the mock source: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
        MOCK_PROVIDER,
        false,
      );
    }

    return {
      organizationId,
      locationId: parsed.data.locationId,
      provider: MOCK_PROVIDER,
      status: "active",
      capabilities: mockCapabilities,
      config: parsed.data,
      // A real connector stores an encrypted credential here. The mock has none,
      // and storing a placeholder would only invite someone to trust it.
      encryptedTokens: null,
      cursor: null,
    };
  },

  async fetchReviews(connection: Connection, since?: Date): Promise<RawReview[]> {
    const config = parseConfig(connection);

    if (config.simulate.failFetch) {
      throw new ConnectorError(
        "Simulated upstream failure while fetching reviews.",
        MOCK_PROVIDER,
        config.simulate.retryable,
      );
    }

    const now = new Date();

    // Anchored to the connection, never to `now`. Anchoring to the wall clock
    // would slide every historical review forward on each fetch, so an
    // incremental sync would rediscover the entire backfill as "new" every run.
    const backfill = generateCorpus({
      locationId: config.locationId,
      count: config.backfillCount,
      until: connection.createdAt,
      spanDays: config.spanDays,
      seed: config.seed,
      batchTag: "bf",
    });

    const all = [...backfill, ...dripReviews(config, now)];

    // An incremental sync asks only for what is new. Dedup still protects the
    // canonical table, but there is no reason to ship 40 rows every run.
    const filtered =
      since === undefined
        ? all
        : all.filter((review) => new Date(review.createdAt).getTime() > since.getTime());

    return filtered.map(toRaw);
  },

  async postReply(
    connection: Connection,
    sourceReviewId: string,
    text: string,
  ): Promise<ReplyResult> {
    const config = parseConfig(connection);

    if (config.simulate.failReply) {
      return { ok: false, reason: "Simulated reply rejection.", retryable: true };
    }
    if (text.trim().length === 0) {
      return { ok: false, reason: "Reply text is empty.", retryable: false };
    }

    // Replies are not persisted in Phase 0 — there is no replies table yet.
    // Returning the external id keeps the contract honest for when there is.
    return { ok: true, externalId: `mock_reply_${sourceReviewId}` };
  },

  normalize(connection: Connection, raw: RawReview): CanonicalReview {
    const parsed = mockPayloadSchema.safeParse(raw.payload);
    if (!parsed.success) {
      throw new ConnectorError(
        `Unexpected mock payload for review "${raw.sourceReviewId}": ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
        MOCK_PROVIDER,
        false,
      );
    }

    const payload = parsed.data;

    return {
      locationId: connection.locationId,
      source: MOCK_PROVIDER,
      sourceReviewId: payload.id,
      authorName: payload.author.name,
      rating: payload.rating,
      text: payload.comment,
      language: payload.language,
      postedAt: new Date(payload.createdAt),
      url: payload.permalink,
      // Always keep the provider response verbatim.
      rawPayload: raw.payload,
    };
  },

  nextCursor(_connection: Connection, fetched: RawReview[]): string | null {
    if (fetched.length === 0) return null;

    // Resume from the newest item seen. Parsed defensively: a malformed
    // createdAt must not poison the cursor and stall every future sync.
    const newest = fetched.reduce<number>((latest, raw) => {
      const value = raw.payload.createdAt;
      const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
      return Number.isNaN(time) ? latest : Math.max(latest, time);
    }, Number.NEGATIVE_INFINITY);

    return newest === Number.NEGATIVE_INFINITY ? null : new Date(newest).toISOString();
  },
};
