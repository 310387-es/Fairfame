import { getEnv } from "../../lib/env.ts";
import { ConnectorError, type Connection } from "../types.ts";
import { assertNotRateLimited } from "../throttle.ts";
import { accessTokenForConnection } from "../tokens.ts";
import {
  googleAccountsPageSchema,
  googleErrorSchema,
  googleLocationsPageSchema,
  googleReplySchema,
  googleReviewsPageSchema,
} from "./schemas.ts";
import type { z } from "zod";

/**
 * The Google Business Profile HTTP client.
 *
 * Three base URLs, because Google splits this across three APIs and never
 * migrated reviews off v4 (see ./schemas.ts). They are constructor options so a
 * contract test — or the go-live suite in T6 — can point the whole client at a
 * local server without touching this file, and they fall back to
 * `GOOGLE_*_BASE_URL` so `pnpm mock:platform` can do the same from `.env`.
 *
 * Everything funnels through `request()`, so authentication, throttle handling
 * and error classification happen in exactly one place. That matters most for
 * the classification: a 403 from Google can mean "your app is not approved
 * yet", "the user revoked you", or "you asked for a scope you do not have", and
 * only the first is worth telling an operator about in those words.
 */

export const GOOGLE_PROVIDER = "google";

export type GoogleFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type GoogleClientOptions = {
  fetchImpl?: GoogleFetch;
  /** Resolves a live access token. Defaults to the vault-backed reader. */
  readToken?: (connection: Connection) => Promise<string>;
  accountManagementBaseUrl?: string;
  businessInformationBaseUrl?: string;
  /** Reviews still live on v4. */
  reviewsBaseUrl?: string;
};

const DEFAULTS = {
  accountManagement: "https://mybusinessaccountmanagement.googleapis.com/v1",
  businessInformation: "https://mybusinessbusinessinformation.googleapis.com/v1",
  reviews: "https://mybusiness.googleapis.com/v4",
};

/**
 * The read mask the Business Information API requires. Asking for everything is
 * not permitted; asking for less than this leaves the picker without a name.
 */
const LOCATION_READ_MASK = "name,title,storefrontAddress,metadata";

/** Google caps review pages at 50. */
export const REVIEWS_PAGE_SIZE = 50;

/** Replies are limited to 4096 characters by the API. */
export const MAX_REPLY_LENGTH = 4096;

export class GoogleAccessError extends ConnectorError {
  constructor(message: string) {
    super(message, GOOGLE_PROVIDER, false);
    this.name = "GoogleAccessError";
  }
}

export function createGoogleClient(options: GoogleClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const readToken = options.readToken ?? ((connection) => accessTokenForConnection(connection));

  /*
    Option, then environment, then Google.

    The middle step is what `pnpm mock:platform` needs: it serves a fake Google
    and prints three base URLs to copy into `.env`, and until 12 Aug 2026
    nothing read them — the option existed, only tests passed it, and a
    developer following the documented instructions pointed nothing anywhere.

    Read here rather than at module load so a test that sets the variable and
    resets the cache is answered, and so importing this module never depends on
    a validated environment.
  */
  const env = getEnv();
  const bases = {
    accountManagement:
      options.accountManagementBaseUrl ??
      env.GOOGLE_ACCOUNT_MANAGEMENT_BASE_URL ??
      DEFAULTS.accountManagement,
    businessInformation:
      options.businessInformationBaseUrl ??
      env.GOOGLE_BUSINESS_INFORMATION_BASE_URL ??
      DEFAULTS.businessInformation,
    reviews: options.reviewsBaseUrl ?? env.GOOGLE_REVIEWS_BASE_URL ?? DEFAULTS.reviews,
  };

  async function request<T>(
    connection: Connection,
    url: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
  ): Promise<T> {
    const accessToken = await readToken(connection);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new ConnectorError(
        `Could not reach Google: ${error instanceof Error ? error.message : "unknown error"}`,
        GOOGLE_PROVIDER,
        true,
      );
    }

    // 429/503 become a RateLimitError carrying Google's own Retry-After, which
    // the scheduler turns into a deferral rather than a failure.
    assertNotRateLimited(GOOGLE_PROVIDER, response);

    if (!response.ok) throw await classify(response);

    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ConnectorError(
        `Unexpected Google response from ${url}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
        GOOGLE_PROVIDER,
        false,
      );
    }

    return parsed.data;
  }

  /** Turns Google's error envelope into something a human can act on. */
  async function classify(response: Response): Promise<ConnectorError> {
    const body = await response.text();
    let message = `Google returned ${response.status}.`;
    let status: string | undefined;

    try {
      const parsed = googleErrorSchema.safeParse(JSON.parse(body));
      if (parsed.success) {
        message = parsed.data.error.message;
        status = parsed.data.error.status;
      }
    } catch {
      // A non-JSON error body is unusual but not worth failing differently on.
    }

    if (response.status === 401) {
      return new GoogleAccessError(
        `Google rejected our credentials (${message}). The connection needs to be reconnected.`,
      );
    }

    if (response.status === 403) {
      // The single most likely 403 before go-live, and the one an operator
      // will otherwise spend an afternoon on.
      const looksUnapproved = /not have permission|insufficient|has not been used|disabled/i.test(
        message,
      );

      return new GoogleAccessError(
        looksUnapproved
          ? `Google denied access (${message}). This usually means the Business Profile API ` +
              `access request has not been approved for this Cloud project yet, or the signed-in ` +
              `account does not manage this location.`
          : `Google denied access (${message}).`,
      );
    }

    if (response.status === 404) {
      return new ConnectorError(
        `Google could not find that resource (${message}). The location may have been removed ` +
          `or transferred to another account.`,
        GOOGLE_PROVIDER,
        false,
      );
    }

    return new ConnectorError(
      `Google error ${response.status}${status ? ` (${status})` : ""}: ${message}`,
      GOOGLE_PROVIDER,
      // 5xx is Google's problem and usually transient; 4xx is ours.
      response.status >= 500,
    );
  }

  return {
    /** Accounts the authorized user administers. */
    async listAccounts(connection: Connection) {
      const page = await request(
        connection,
        `${bases.accountManagement}/accounts?pageSize=100`,
        googleAccountsPageSchema,
      );
      return page.accounts ?? [];
    },

    /** Locations under one account. */
    async listLocations(connection: Connection, accountId: string) {
      const url = new URL(`${bases.businessInformation}/accounts/${accountId}/locations`);
      url.searchParams.set("readMask", LOCATION_READ_MASK);
      url.searchParams.set("pageSize", "100");

      const page = await request(connection, url.toString(), googleLocationsPageSchema);
      return page.locations ?? [];
    },

    /**
     * One page of reviews, newest update first.
     *
     * `orderBy=updateTime desc` is what makes incremental sync possible: the v4
     * API has no "changed since" filter, so the connector walks pages until it
     * reaches something older than its cursor and stops.
     */
    async listReviews(
      connection: Connection,
      args: { accountId: string; locationId: string; pageToken?: string | undefined },
    ) {
      const url = new URL(
        `${bases.reviews}/accounts/${args.accountId}/locations/${args.locationId}/reviews`,
      );
      url.searchParams.set("pageSize", String(REVIEWS_PAGE_SIZE));
      url.searchParams.set("orderBy", "updateTime desc");
      if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);

      return request(connection, url.toString(), googleReviewsPageSchema);
    },

    /**
     * Creates or replaces the owner's reply. Google has no separate "create" —
     * PUT is both, which also makes it idempotent.
     */
    async updateReply(
      connection: Connection,
      args: { accountId: string; locationId: string; reviewId: string; comment: string },
    ) {
      const url =
        `${bases.reviews}/accounts/${args.accountId}/locations/${args.locationId}` +
        `/reviews/${args.reviewId}/reply`;

      return request(connection, url, googleReplySchema, {
        method: "PUT",
        body: JSON.stringify({ comment: args.comment }),
      });
    },
  };
}

export type GoogleClient = ReturnType<typeof createGoogleClient>;
