import { z } from "zod";
import { getFreshAccessToken } from "./tokens.ts";
import { assertNotRateLimited } from "./throttle.ts";
import {
  ConnectorError,
  type CanonicalReview,
  type Capability,
  type Connection,
  type Connector,
  type NewConnection,
  type RawReview,
} from "./types.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";

/**
 * A synthetic provider that behaves like a real HTTP one.
 *
 * P1b-T0's Definition of Done asks for the connector framework to be exercised
 * "via the mock + one fixture-backed provider", and this is that provider. It
 * is not a stand-in for Google — it is a test article for the *framework*:
 * OAuth token retrieval from the vault, refresh-on-expiry, bearer auth, cursor
 * pagination, 429 handling with `Retry-After`, and payload validation on the
 * way into the canonical model.
 *
 * Everything it needs from the outside arrives through two seams — an injected
 * `fetch` and an injected token reader — so a test can drive it against
 * recorded JSON without a network, and the same code would work unmodified
 * against a real server. When T2 writes the Google connector, this file is the
 * shape to copy.
 *
 * Capabilities are `read: 'excerpt'` and `reply: 'none'` on purpose: those are
 * the values that make the capability-driven UI show "Monitor only" and "Open
 * on platform", so the UI path is exercised too.
 */

export const FIXTURE_PROVIDER = "fixture";

export const fixtureCapabilities: Capability = {
  read: "excerpt",
  reply: "none",
  realtime: false,
};

export const fixtureConfigSchema = z.object({
  locationId: z.uuid(),
  /** The provider's own identifier for the place being monitored. */
  externalLocationId: z.string().min(1).max(120),
  /** Base URL of the provider's API. Points at a fixture server in tests. */
  apiBaseUrl: z.string().url().default("https://fixture.invalid/v1"),
});

export type FixtureConfig = z.infer<typeof fixtureConfigSchema>;

/** One review, in the provider's own shape. */
const fixtureReviewSchema = z.object({
  review_id: z.string().min(1),
  reviewer: z.object({ display_name: z.string().nullable() }),
  star_rating: z.number().int().min(1).max(5),
  /** Excerpt-only source: the provider truncates, and we store what we get. */
  excerpt: z.string().nullable(),
  locale: z.string().min(2).max(10).nullable(),
  created_at: z.iso.datetime(),
  permalink: z.string().url().nullable(),
});

const fixturePageSchema = z.object({
  reviews: z.array(fixtureReviewSchema),
  /** Absent or null on the last page. */
  next_page_token: z.string().nullable().optional(),
});

export type FixtureFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * How the connector gets a usable access token.
 *
 * Injected rather than imported so a contract test can exercise pagination
 * without standing up a vault, while the production path is the real
 * `getFreshAccessToken` — which locks the row, refreshes if needed, and
 * re-seals the result.
 */
export type TokenReader = (connection: Connection) => Promise<string>;

export type FixtureConnectorOptions = {
  fetchImpl?: FixtureFetch;
  readToken?: TokenReader;
};

/** The production token reader: vault-backed, refreshing, row-locked. */
export function vaultTokenReader(tx: TenantDatabase): TokenReader {
  return (connection) => getFreshAccessToken(tx, connection);
}

/** Pages are capped so a runaway `next_page_token` cannot loop forever. */
const MAX_PAGES = 20;

export function createFixtureConnector(options: FixtureConnectorOptions = {}): Connector {
  const fetchImpl = options.fetchImpl ?? fetch;
  const readToken = options.readToken;

  function parseConfig(connection: Connection): FixtureConfig {
    const result = fixtureConfigSchema.safeParse(connection.config);
    if (!result.success) {
      throw new ConnectorError(
        `Invalid fixture connection config: ${result.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
        FIXTURE_PROVIDER,
        false,
      );
    }
    return result.data;
  }

  return {
    provider: FIXTURE_PROVIDER,
    capabilities: fixtureCapabilities,

    async connect(organizationId: string, config: unknown): Promise<NewConnection> {
      const parsed = fixtureConfigSchema.safeParse(config);
      if (!parsed.success) {
        throw new ConnectorError(
          `Cannot connect the fixture provider: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
          FIXTURE_PROVIDER,
          false,
        );
      }

      return {
        organizationId,
        locationId: parsed.data.locationId,
        provider: FIXTURE_PROVIDER,
        // Pending until the OAuth callback seals a token onto the row. A real
        // connector must never report itself active before it can authenticate.
        status: "pending",
        capabilities: fixtureCapabilities,
        config: parsed.data,
        encryptedTokens: null,
        cursor: null,
      };
    },

    async fetchReviews(connection: Connection, since?: Date): Promise<RawReview[]> {
      const config = parseConfig(connection);

      if (!readToken) {
        throw new ConnectorError(
          "The fixture connector was built without a token reader.",
          FIXTURE_PROVIDER,
          false,
        );
      }

      const accessToken = await readToken(connection);
      const collected: RawReview[] = [];
      let pageToken: string | null = null;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = new URL(`${config.apiBaseUrl}/locations/${config.externalLocationId}/reviews`);
        if (since) url.searchParams.set("updated_since", since.toISOString());
        if (pageToken) url.searchParams.set("page_token", pageToken);

        const response = await fetchImpl(url.toString(), {
          headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        });

        // Uniform 429/503 handling for every provider: the scheduler reads the
        // retry hint off the error and parks the connection.
        assertNotRateLimited(FIXTURE_PROVIDER, response);

        if (response.status === 401 || response.status === 403) {
          throw new ConnectorError(
            `The fixture provider rejected our credentials (${response.status}).`,
            FIXTURE_PROVIDER,
            // Reconnecting is a human action; retrying will not help.
            false,
          );
        }

        if (!response.ok) {
          throw new ConnectorError(
            `The fixture provider returned ${response.status}.`,
            FIXTURE_PROVIDER,
            response.status >= 500,
          );
        }

        const parsed = fixturePageSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new ConnectorError(
            `Unexpected fixture page payload: ${parsed.error.issues
              .map((issue) => `${issue.path.join(".")} ${issue.message}`)
              .join("; ")}`,
            FIXTURE_PROVIDER,
            false,
          );
        }

        for (const review of parsed.data.reviews) {
          collected.push({ sourceReviewId: review.review_id, payload: { ...review } });
        }

        pageToken = parsed.data.next_page_token ?? null;
        if (!pageToken) return collected;
      }

      throw new ConnectorError(
        `The fixture provider paginated past ${MAX_PAGES} pages; refusing to continue.`,
        FIXTURE_PROVIDER,
        false,
      );
    },

    normalize(connection: Connection, raw: RawReview): CanonicalReview {
      const parsed = fixtureReviewSchema.safeParse(raw.payload);
      if (!parsed.success) {
        throw new ConnectorError(
          `Unexpected fixture payload for review "${raw.sourceReviewId}": ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
          FIXTURE_PROVIDER,
          false,
        );
      }

      const payload = parsed.data;

      return {
        locationId: connection.locationId,
        source: FIXTURE_PROVIDER,
        sourceReviewId: payload.review_id,
        authorName: payload.reviewer.display_name,
        rating: payload.star_rating,
        text: payload.excerpt,
        // "tr-TR" → "tr": the canonical model stores the language, not the region.
        language: payload.locale ? (payload.locale.split("-")[0] ?? null) : null,
        postedAt: new Date(payload.created_at),
        url: payload.permalink,
        rawPayload: raw.payload,
      };
    },

    nextCursor(_connection: Connection, fetched: RawReview[]): string | null {
      if (fetched.length === 0) return null;

      const newest = fetched.reduce<number>((latest, raw) => {
        const value = (raw.payload as { created_at?: unknown }).created_at;
        const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
        return Number.isNaN(time) ? latest : Math.max(latest, time);
      }, Number.NEGATIVE_INFINITY);

      return newest === Number.NEGATIVE_INFINITY ? null : new Date(newest).toISOString();
    },
  };
}
