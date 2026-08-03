import { z } from "zod";
import type { OAuthEndpoints } from "../providers.ts";
import { codeChallengeFor } from "./state.ts";

/**
 * A small, boring OAuth 2.0 client (RFC 6749 authorization code + RFC 7636
 * PKCE), shared by every credentialed provider.
 *
 * Deliberately not a library: what Google, Meta and the rest actually need is
 * the authorization-code grant with a refresh, which is two POSTs. A dependency
 * would bring an abstraction over provider quirks we have not met yet, and the
 * quirks we *have* met (Google needs `access_type=offline`, Meta returns no
 * refresh token at all) live in provider descriptors where they can be read.
 *
 * `fetch` is injected so the whole handshake is testable against recorded
 * fixtures — the same seam the fixture-backed provider uses.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class OAuthError extends Error {
  /** The provider's own `error` code, when it sent one. */
  readonly code: string | undefined;
  /**
   * False for the errors that will never fix themselves: `invalid_grant` means
   * the refresh token is dead and the customer must reconnect, and retrying it
   * on a schedule just burns quota until someone notices.
   */
  readonly retryable: boolean;

  constructor(message: string, options: { code?: string | undefined; retryable?: boolean } = {}) {
    super(message);
    this.name = "OAuthError";
    this.code = options.code;
    this.retryable = options.retryable ?? true;
  }
}

/** Tokens as this codebase carries them. Provider-shaped fields are normalized away. */
export type TokenSet = {
  accessToken: string;
  /** Null when the provider issues none (Meta long-lived tokens, for example). */
  refreshToken: string | null;
  /** ISO 8601. Null when the provider does not say, which we treat as "unknown". */
  expiresAt: string | null;
  scope: string | null;
  tokenType: string;
};

/** RFC 6749 §5.1, plus the fields real providers actually send. */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("Bearer"),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

/** RFC 6749 §5.2. */
const errorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

/** Codes that mean "this grant is gone" rather than "try again later". */
const PERMANENT_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_scope",
  "access_denied",
]);

export type AuthorizationUrlArgs = {
  endpoints: OAuthEndpoints;
  clientId: string;
  redirectUri: string;
  state: string;
  /** Required when `endpoints.usePkce`. */
  codeVerifier?: string | undefined;
};

export function buildAuthorizationUrl(args: AuthorizationUrlArgs): string {
  const url = new URL(args.endpoints.authorizeUrl);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);

  if (args.endpoints.scopes.length > 0) {
    url.searchParams.set("scope", args.endpoints.scopes.join(" "));
  }

  if (args.endpoints.usePkce) {
    if (!args.codeVerifier) {
      throw new OAuthError("This provider requires PKCE, but no code verifier was supplied.", {
        retryable: false,
      });
    }
    url.searchParams.set("code_challenge", codeChallengeFor(args.codeVerifier));
    // S256 only. `plain` is allowed by the RFC and defeats the purpose.
    url.searchParams.set("code_challenge_method", "S256");
  }

  for (const [key, value] of Object.entries(args.endpoints.authorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

function toTokenSet(raw: z.infer<typeof tokenResponseSchema>, now: Date): TokenSet {
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    expiresAt:
      raw.expires_in === undefined
        ? null
        : new Date(now.getTime() + raw.expires_in * 1_000).toISOString(),
    scope: raw.scope ?? null,
    tokenType: raw.token_type,
  };
}

async function postToTokenEndpoint(
  endpoints: OAuthEndpoints,
  body: URLSearchParams,
  fetchImpl: FetchLike,
  now: Date,
): Promise<TokenSet> {
  let response: Response;
  try {
    response = await fetchImpl(endpoints.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (error) {
    // A network failure is not an authorization failure: worth retrying.
    throw new OAuthError(
      `Could not reach the token endpoint: ${error instanceof Error ? error.message : "unknown"}`,
      { retryable: true },
    );
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OAuthError(
      `The token endpoint returned ${response.status} with a non-JSON body.`,
      // 5xx is theirs to fix and worth retrying; a malformed 2xx is not.
      { retryable: response.status >= 500 },
    );
  }

  if (!response.ok) {
    const failure = errorResponseSchema.safeParse(parsed);
    const code = failure.success ? failure.data.error : undefined;

    throw new OAuthError(
      failure.success
        ? `${failure.data.error}${failure.data.error_description ? `: ${failure.data.error_description}` : ""}`
        : `The token endpoint returned ${response.status}.`,
      {
        code,
        retryable: code ? !PERMANENT_ERRORS.has(code) : response.status >= 500,
      },
    );
  }

  const success = tokenResponseSchema.safeParse(parsed);
  if (!success.success) {
    throw new OAuthError(
      `The token endpoint returned an unexpected body: ${success.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
      { retryable: false },
    );
  }

  return toTokenSet(success.data, now);
}

export type ExchangeArgs = {
  endpoints: OAuthEndpoints;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string | undefined;
};

/** Authorization code → tokens. */
export async function exchangeCodeForTokens(
  args: ExchangeArgs,
  fetchImpl: FetchLike = fetch,
  now = new Date(),
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });

  if (args.endpoints.usePkce) {
    if (!args.codeVerifier) {
      throw new OAuthError("Missing PKCE verifier for the code exchange.", { retryable: false });
    }
    body.set("code_verifier", args.codeVerifier);
  }

  return postToTokenEndpoint(args.endpoints, body, fetchImpl, now);
}

export type RefreshArgs = {
  endpoints: OAuthEndpoints;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

/**
 * Refresh token → a new access token.
 *
 * Providers vary on whether they return a fresh refresh token; when they do not,
 * the caller must keep the existing one. Returning `refreshToken: null` here and
 * having the caller blindly store it would silently destroy the connection, so
 * the merge is the caller's job and is done in ../tokens.ts.
 */
export async function refreshAccessToken(
  args: RefreshArgs,
  fetchImpl: FetchLike = fetch,
  now = new Date(),
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });

  return postToTokenEndpoint(args.endpoints, body, fetchImpl, now);
}
