import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixtureConnector, FIXTURE_PROVIDER } from "@/connectors/fixture";
import { replyAffordanceOf, syncKindOf } from "@/connectors/capability-view";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  OAuthError,
  refreshAccessToken,
} from "@/connectors/oauth/client";
import {
  assertStateMatches,
  codeChallengeFor,
  generateCodeVerifier,
  generateNonce,
  openOAuthSession,
  OAuthStateError,
  sealOAuthSession,
  type OAuthSession,
} from "@/connectors/oauth/state";
import { PROVIDERS, resolveModeFor, type OAuthEndpoints } from "@/connectors/providers";
import {
  assertNotRateLimited,
  computeBackoffMs,
  parseRetryAfter,
  RateLimitError,
} from "@/connectors/throttle";
import { isExpired, mergeRefreshed } from "@/connectors/tokens";
import type { Connection, ConnectorError } from "@/connectors/types";
import { parseEnvForTesting } from "@/lib/env";
import type { Env } from "@/lib/env";
import {
  decryptSecret,
  encryptSecret,
  connectionContext,
  keyIdOf,
  needsRewrap,
  parseVaultKeys,
  resetVaultKeysForTesting,
  rewrapSecret,
  setVaultKeysForTesting,
  VaultError,
} from "@/lib/vault";

/**
 * P1b-T0 unit surface: the connector framework's crypto, OAuth, throttling and
 * capability mapping — everything that can be decided without a database.
 *
 * The security-relevant properties get explicit tests rather than trust:
 * ciphertext bound to its slot, state that cannot be forged, PKCE challenges
 * that match the RFC's own vector, and a `real` mode that refuses to engage
 * without both credentials and a vault.
 */

const KEY_A = "k1:" + Buffer.alloc(32, 1).toString("base64");
const KEY_B = "k2:" + Buffer.alloc(32, 2).toString("base64");

const ORG = "11111111-1111-4111-8111-111111111111";
const LOCATION = "22222222-2222-4222-8222-222222222222";

beforeAll(() => {
  setVaultKeysForTesting(KEY_A);
});

afterAll(() => {
  resetVaultKeysForTesting();
});

describe("the token vault", () => {
  const context = connectionContext(ORG, LOCATION, "google");

  it("round-trips a secret", () => {
    const sealed = encryptSecret("refresh-token-value", context);
    expect(sealed).not.toContain("refresh-token-value");
    expect(decryptSecret(sealed, context)).toBe("refresh-token-value");
  });

  it("produces a different ciphertext every time", () => {
    // A fresh data key and IV per call: identical plaintexts must not be
    // recognisable as identical in the database.
    const first = encryptSecret("same", context);
    const second = encryptSecret("same", context);
    expect(first).not.toBe(second);
  });

  it("refuses a payload moved to another connection's slot", () => {
    const sealed = encryptSecret("token", context);
    const otherLocation = connectionContext(ORG, "33333333-3333-4333-8333-333333333333", "google");
    const otherProvider = connectionContext(ORG, LOCATION, "instagram");
    const otherOrg = connectionContext("44444444-4444-4444-8444-444444444444", LOCATION, "google");

    // This is the attack RLS cannot see: the row is legitimately the
    // attacker's, and only the AAD binding stops the tokens travelling with it.
    for (const wrong of [otherLocation, otherProvider, otherOrg]) {
      expect(() => decryptSecret(sealed, wrong)).toThrow(VaultError);
    }
  });

  it("refuses a tampered payload", () => {
    const sealed = encryptSecret("token", context);
    const parts = sealed.split(".");
    const body = Buffer.from(parts[5] ?? "", "base64url");
    body[0] = (body[0] ?? 0) ^ 0xff;
    parts[5] = body.toString("base64url");

    expect(() => decryptSecret(parts.join("."), context)).toThrow(VaultError);
  });

  it("rejects a malformed payload rather than guessing", () => {
    for (const bad of ["", "nonsense", "v1.k1.a.b.c", "v2.k1.a.b.c.d"]) {
      expect(() => decryptSecret(bad, context), bad).toThrow(VaultError);
    }
  });

  it("keeps reading payloads written under a retired key", () => {
    const underOldKey = encryptSecret("old-token", context);

    // Rotate: k2 becomes active, k1 stays available for decryption only.
    setVaultKeysForTesting(`${KEY_B},${KEY_A}`);

    expect(decryptSecret(underOldKey, context)).toBe("old-token");
    expect(needsRewrap(underOldKey)).toBe(true);
    expect(keyIdOf(underOldKey)).toBe("k1");

    const rewrapped = rewrapSecret(underOldKey, context);
    expect(keyIdOf(rewrapped)).toBe("k2");
    expect(needsRewrap(rewrapped)).toBe(false);
    expect(decryptSecret(rewrapped, context)).toBe("old-token");

    setVaultKeysForTesting(KEY_A);
  });

  it("cannot read a payload whose key has been removed entirely", () => {
    setVaultKeysForTesting(KEY_B);
    const sealed = encryptSecret("token", context);

    setVaultKeysForTesting(KEY_A);
    expect(() => decryptSecret(sealed, context)).toThrow(/not configured/);

    setVaultKeysForTesting(KEY_A);
  });

  it("validates key material", () => {
    expect(() => parseVaultKeys("")).toThrow(VaultError);
    expect(() => parseVaultKeys("nocolon")).toThrow(VaultError);
    // 16 bytes is the classic "AES-256" mistake, and it must not start.
    expect(() => parseVaultKeys("k1:" + Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => parseVaultKeys(`${KEY_A},${KEY_A}`)).toThrow(/more than once/);
    expect(parseVaultKeys(`${KEY_A},${KEY_B}`).map((key) => key.id)).toEqual(["k1", "k2"]);
  });
});

describe("provider modes", () => {
  const base: Record<string, string> = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    APP_DATABASE_URL: "postgres://u:p@localhost:5432/db",
    REDIS_URL: "redis://localhost:6379",
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "http://localhost:3000",
  };

  // Cast at the boundary: Next's ProcessEnv marks NODE_ENV required, which a
  // synthetic fixture has no reason to carry.
  const envWith = (extra: Record<string, string> = {}): Env =>
    parseEnvForTesting({ ...base, ...extra } as NodeJS.ProcessEnv);

  it("defaults every credentialed provider to mock", () => {
    const env = envWith();
    for (const key of ["google", "instagram", "whatsapp"]) {
      expect(resolveModeFor(env, key).mode, key).toBe("mock");
    }
  });

  it("leaves sources we own alone — they have no flag to get wrong", () => {
    const env = envWith();
    expect(resolveModeFor(env, "mock").mode).toBe("real");
    expect(resolveModeFor(env, "firstparty").mode).toBe("real");
  });

  it("demotes a live provider that has no credentials", () => {
    const resolution = resolveModeFor(envWith({ CONNECTOR_GOOGLE_MODE: "real" }), "google");
    expect(resolution).toMatchObject({
      mode: "mock",
      configured: "real",
      reason: "missing_credentials",
    });
  });

  it("demotes a live provider that has no vault to store tokens in", () => {
    const resolution = resolveModeFor(
      envWith({
        CONNECTOR_GOOGLE_MODE: "real",
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
      }),
      "google",
    );

    // Credentials without a vault means tokens would land in plaintext.
    expect(resolution).toMatchObject({ mode: "mock", reason: "missing_vault" });
  });

  it("goes live only when the flag, the credentials and the vault all agree", () => {
    const resolution = resolveModeFor(
      envWith({
        CONNECTOR_GOOGLE_MODE: "real",
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        TOKEN_VAULT_KEYS: KEY_A,
      }),
      "google",
    );
    expect(resolution.mode).toBe("real");
  });

  it("honours an explicit off switch", () => {
    expect(resolveModeFor(envWith({ CONNECTOR_WHATSAPP_MODE: "off" }), "whatsapp").mode).toBe(
      "off",
    );
  });

  it("treats an unparseable vault key as no vault at all", () => {
    const resolution = resolveModeFor(
      envWith({
        CONNECTOR_GOOGLE_MODE: "real",
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        TOKEN_VAULT_KEYS: "k1:too-short",
      }),
      "google",
    );
    expect(resolution.reason).toBe("missing_vault");
  });

  it("declares Google as full-read with API replies, and WhatsApp as outbound", () => {
    // These drive the UI, so they are worth pinning.
    expect(PROVIDERS.google?.capabilities).toEqual({
      read: "full",
      reply: "api",
      realtime: false,
    });
    expect(PROVIDERS.whatsapp?.capabilities.read).toBe("none");
  });
});

describe("capability mapping", () => {
  it("labels a full-read source live and an excerpt source monitor-only", () => {
    expect(syncKindOf({ read: "full", reply: "api", realtime: false })).toBe("live");
    expect(syncKindOf({ read: "excerpt", reply: "none", realtime: false })).toBe("monitor");
    expect(syncKindOf({ read: "none", reply: "api", realtime: true })).toBe("outbound");
  });

  it("offers a composer only where the source can post a reply", () => {
    expect(replyAffordanceOf({ read: "full", reply: "api", realtime: false })).toBe("compose");
    expect(replyAffordanceOf({ read: "full", reply: "manual", realtime: false })).toBe(
      "open_on_platform",
    );
    expect(replyAffordanceOf({ read: "excerpt", reply: "none", realtime: false })).toBe(
      "open_on_platform",
    );
  });
});

describe("OAuth state and PKCE", () => {
  const secret = "s".repeat(32);

  const session: OAuthSession = {
    nonce: "nonce-value",
    provider: "google",
    organizationId: ORG,
    locationId: LOCATION,
    codeVerifier: "verifier",
    expiresAt: Date.now() + 60_000,
    returnTo: "/locations",
  };

  it("seals and opens a session", () => {
    const opened = openOAuthSession(sealOAuthSession(session, secret), secret);
    expect(opened).toMatchObject({ provider: "google", organizationId: ORG });
  });

  it("rejects a cookie signed with another secret", () => {
    const sealed = sealOAuthSession(session, "other-secret-that-is-long-enough");
    expect(() => openOAuthSession(sealed, secret)).toThrow(OAuthStateError);
  });

  it("rejects a tampered payload", () => {
    const sealed = sealOAuthSession(session, secret);
    const [payload, signature] = sealed.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...session, organizationId: "attacker" }),
      "utf8",
    ).toString("base64url");

    expect(payload).toBeDefined();
    expect(() => openOAuthSession(`${forged}.${signature}`, secret)).toThrow(OAuthStateError);
  });

  it("rejects an expired handshake", () => {
    const stale = sealOAuthSession({ ...session, expiresAt: Date.now() - 1 }, secret);
    expect(() => openOAuthSession(stale, secret)).toThrow(/expired/i);
  });

  it("requires the returned state to match the nonce", () => {
    expect(() => assertStateMatches(session, null)).toThrow(OAuthStateError);
    expect(() => assertStateMatches(session, "different")).toThrow(OAuthStateError);
    expect(() => assertStateMatches(session, session.nonce)).not.toThrow();
  });

  it("derives the S256 challenge exactly as RFC 7636 specifies", () => {
    // The RFC's own appendix-B vector — cheap insurance against a base64
    // variant slipping in.
    expect(codeChallengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates verifiers inside the RFC's length bounds", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(generateNonce()).not.toBe(generateNonce());
  });
});

describe("the OAuth client", () => {
  const endpoints: OAuthEndpoints = {
    authorizeUrl: "https://provider.test/authorize",
    tokenUrl: "https://provider.test/token",
    scopes: ["reviews.read", "reviews.reply"],
    usePkce: true,
    authorizeParams: { access_type: "offline" },
  };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("builds an authorization URL with PKCE and provider extras", () => {
    const url = new URL(
      buildAuthorizationUrl({
        endpoints,
        clientId: "client",
        redirectUri: "https://app.test/api/connect/x/callback",
        state: "the-state",
        codeVerifier: "verifier",
      }),
    );

    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("reviews.read reviews.reply");
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("code_challenge")).toBe(codeChallengeFor("verifier"));
    // S256 only: `plain` would defeat the point of PKCE.
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    // The verifier itself must never appear in a URL.
    expect(url.toString()).not.toContain("verifier");
  });

  it("refuses to build a PKCE URL without a verifier", () => {
    expect(() =>
      buildAuthorizationUrl({
        endpoints,
        clientId: "client",
        redirectUri: "https://app.test/cb",
        state: "s",
      }),
    ).toThrow(OAuthError);
  });

  it("exchanges a code and normalizes the response", async () => {
    const now = new Date("2026-08-02T10:00:00Z");
    let sentBody = "";

    const tokens = await exchangeCodeForTokens(
      {
        endpoints,
        clientId: "client",
        clientSecret: "secret",
        code: "the-code",
        redirectUri: "https://app.test/cb",
        codeVerifier: "verifier",
      },
      async (_url, init) => {
        sentBody = String(init?.body ?? "");
        return jsonResponse({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          scope: "reviews.read",
          token_type: "Bearer",
        });
      },
      now,
    );

    expect(sentBody).toContain("grant_type=authorization_code");
    expect(sentBody).toContain("code_verifier=verifier");
    expect(tokens).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      // expires_in is turned into an absolute instant at exchange time.
      expiresAt: "2026-08-02T11:00:00.000Z",
      scope: "reviews.read",
      tokenType: "Bearer",
    });
  });

  it("marks invalid_grant permanent and a 500 retryable", async () => {
    const dead = await exchangeCodeForTokens(
      {
        endpoints,
        clientId: "c",
        clientSecret: "s",
        code: "x",
        redirectUri: "https://app.test/cb",
        codeVerifier: "v",
      },
      async () => jsonResponse({ error: "invalid_grant", error_description: "expired" }, 400),
    ).catch((error: unknown) => error as OAuthError);

    expect(dead).toBeInstanceOf(OAuthError);
    expect((dead as OAuthError).code).toBe("invalid_grant");
    // Retrying a dead grant just burns quota until someone notices.
    expect((dead as OAuthError).retryable).toBe(false);

    const transient = await refreshAccessToken(
      { endpoints, clientId: "c", clientSecret: "s", refreshToken: "r" },
      async () => jsonResponse({ error: "server_error" }, 500),
    ).catch((error: unknown) => error as OAuthError);

    expect((transient as OAuthError).retryable).toBe(true);
  });

  it("treats a network failure as retryable", async () => {
    const error = await refreshAccessToken(
      { endpoints, clientId: "c", clientSecret: "s", refreshToken: "r" },
      async () => {
        throw new Error("ECONNRESET");
      },
    ).catch((caught: unknown) => caught as OAuthError);

    expect((error as OAuthError).retryable).toBe(true);
  });

  it("rejects a 200 that is not a token response", async () => {
    const error = await refreshAccessToken(
      { endpoints, clientId: "c", clientSecret: "s", refreshToken: "r" },
      async () => jsonResponse({ nothing: "useful" }),
    ).catch((caught: unknown) => caught as OAuthError);

    expect((error as OAuthError).retryable).toBe(false);
  });
});

describe("token lifecycle helpers", () => {
  const tokens = {
    accessToken: "a",
    refreshToken: "r",
    expiresAt: "2026-08-02T11:00:00.000Z",
    scope: "s",
    tokenType: "Bearer",
  };

  it("treats a token inside the skew window as expired", () => {
    expect(isExpired(tokens, new Date("2026-08-02T10:00:00Z"))).toBe(false);
    // 30s before expiry, inside the 60s skew: refresh now rather than race.
    expect(isExpired(tokens, new Date("2026-08-02T10:59:30Z"))).toBe(true);
    expect(isExpired(tokens, new Date("2026-08-02T12:00:00Z"))).toBe(true);
  });

  it("treats an unknown expiry as live", () => {
    expect(isExpired({ ...tokens, expiresAt: null }, new Date())).toBe(false);
  });

  it("keeps the refresh token when a provider omits it", () => {
    // Google returns no refresh token on refresh; storing the response verbatim
    // would blank the only credential that outlives the hour.
    const merged = mergeRefreshed(tokens, {
      accessToken: "new",
      refreshToken: null,
      expiresAt: "2026-08-02T12:00:00.000Z",
      scope: null,
      tokenType: "Bearer",
    });

    expect(merged.accessToken).toBe("new");
    expect(merged.refreshToken).toBe("r");
    expect(merged.scope).toBe("s");
  });

  it("takes a rotated refresh token when one is issued", () => {
    const merged = mergeRefreshed(tokens, { ...tokens, refreshToken: "rotated" });
    expect(merged.refreshToken).toBe("rotated");
  });
});

describe("throttling and backoff", () => {
  const policy = { requestsPerMinute: 30, minSyncIntervalMs: 60_000, maxBackoffMs: 3_600_000 };

  it("grows the delay with each consecutive failure", () => {
    const delays = [1, 2, 3, 4].map((n) => computeBackoffMs(n, policy, () => 1));
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(delays[0]).toBeLessThan(delays[3] ?? 0);
  });

  it("never exceeds the provider's ceiling", () => {
    expect(computeBackoffMs(50, policy, () => 1)).toBeLessThanOrEqual(policy.maxBackoffMs);
  });

  it("never collapses to zero, even at the low end of the jitter", () => {
    // Full jitter with no floor would turn a backoff into a retry storm.
    expect(computeBackoffMs(1, policy, () => 0)).toBeGreaterThanOrEqual(30_000);
  });

  it("reads Retry-After in both of its forms", () => {
    const now = new Date("2026-08-02T10:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Sun, 02 Aug 2026 10:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it("turns a 429 into a RateLimitError carrying the provider's own hint", () => {
    const response = { status: 429, headers: { get: () => "45" } };

    try {
      assertNotRateLimited("google", response);
      throw new Error("expected a rate limit error");
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBe(45_000);
      // Flow control, not a fault: this must not burn the retry budget.
      expect((error as RateLimitError).retryable).toBe(true);
    }
  });

  it("passes anything that is not a throttle response", () => {
    expect(() =>
      assertNotRateLimited("google", { status: 200, headers: { get: () => null } }),
    ).not.toThrow();
  });
});

describe("the fixture-backed provider", () => {
  const connection: Connection = {
    id: "55555555-5555-4555-8555-555555555555",
    organizationId: ORG,
    locationId: LOCATION,
    provider: FIXTURE_PROVIDER,
    status: "active",
    capabilities: { read: "excerpt", reply: "none", realtime: false },
    config: {
      locationId: LOCATION,
      externalLocationId: "loc-42",
      apiBaseUrl: "https://fixture.test/v1",
    },
    encryptedTokens: null,
    cursor: null,
    lastSyncedAt: null,
    firstSyncedAt: null,
    nextSyncAt: null,
    failureCount: 0,
    createdAt: new Date("2026-08-01T00:00:00Z"),
  };

  function page(reviews: unknown[], nextPageToken: string | null): Response {
    return new Response(JSON.stringify({ reviews, next_page_token: nextPageToken }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const review = (id: string) => ({
    review_id: id,
    reviewer: { display_name: "Ayşe" },
    star_rating: 4,
    excerpt: "Kahve iyiydi",
    locale: "tr-TR",
    created_at: "2026-07-30T12:00:00.000Z",
    permalink: "https://fixture.test/r/" + id,
  });

  it("follows pagination and sends the bearer token", async () => {
    const seen: string[] = [];
    const connector = createFixtureConnector({
      readToken: async () => "access-token",
      fetchImpl: async (url, init) => {
        seen.push(url);
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer access-token");
        return url.includes("page_token=p2")
          ? page([review("r3")], null)
          : page([review("r1"), review("r2")], "p2");
      },
    });

    const raw = await connector.fetchReviews(connection);

    expect(raw.map((item) => item.sourceReviewId)).toEqual(["r1", "r2", "r3"]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("/locations/loc-42/reviews");
  });

  it("passes the incremental cursor to the provider", async () => {
    let requested = "";
    const connector = createFixtureConnector({
      readToken: async () => "t",
      fetchImpl: async (url) => {
        requested = url;
        return page([], null);
      },
    });

    await connector.fetchReviews(connection, new Date("2026-07-01T00:00:00Z"));
    expect(requested).toContain("updated_since=2026-07-01T00%3A00%3A00.000Z");
  });

  it("surfaces a 429 as a RateLimitError with the provider's delay", async () => {
    const connector = createFixtureConnector({
      readToken: async () => "t",
      fetchImpl: async () => new Response("", { status: 429, headers: { "retry-after": "30" } }),
    });

    const error = await connector
      .fetchReviews(connection)
      .catch((caught: unknown) => caught as RateLimitError);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(30_000);
  });

  it("treats a rejected credential as permanent", async () => {
    const connector = createFixtureConnector({
      readToken: async () => "t",
      fetchImpl: async () => new Response("", { status: 401 }),
    });

    const error = await connector
      .fetchReviews(connection)
      .catch((caught: unknown) => caught as ConnectorError);

    // Reconnecting is a human action; retrying will not help.
    expect((error as ConnectorError).retryable).toBe(false);
  });

  it("retries a server error but not a malformed page", async () => {
    const server = await createFixtureConnector({
      readToken: async () => "t",
      fetchImpl: async () => new Response("", { status: 503 }),
    })
      .fetchReviews(connection)
      .catch((caught: unknown) => caught as ConnectorError);
    // 503 is handled as throttling: the provider is asking us to wait.
    expect(server).toBeInstanceOf(RateLimitError);

    const malformed = await createFixtureConnector({
      readToken: async () => "t",
      fetchImpl: async () => page([{ review_id: 12 }], null),
    })
      .fetchReviews(connection)
      .catch((caught: unknown) => caught as ConnectorError);
    expect((malformed as ConnectorError).retryable).toBe(false);
  });

  it("stops rather than following pagination forever", async () => {
    const connector = createFixtureConnector({
      readToken: async () => "t",
      // A provider that always offers another page would otherwise spin.
      fetchImpl: async () => page([review("r")], "always-more"),
    });

    await expect(connector.fetchReviews(connection)).rejects.toThrow(/paginated past/);
  });

  it("normalizes into the canonical shape and trims the locale's region", () => {
    const connector = createFixtureConnector({ readToken: async () => "t" });
    const canonical = connector.normalize(connection, {
      sourceReviewId: "r1",
      payload: review("r1"),
    });

    expect(canonical).toMatchObject({
      locationId: LOCATION,
      source: FIXTURE_PROVIDER,
      sourceReviewId: "r1",
      authorName: "Ayşe",
      rating: 4,
      text: "Kahve iyiydi",
      // "tr-TR" → "tr": the canonical model stores the language, not the region.
      language: "tr",
    });
  });

  it("connects as pending, because a connection with no token is not usable", async () => {
    const connector = createFixtureConnector({ readToken: async () => "t" });
    const draft = await connector.connect(ORG, {
      locationId: LOCATION,
      externalLocationId: "loc-42",
      apiBaseUrl: "https://fixture.test/v1",
    });

    expect(draft.status).toBe("pending");
    expect(draft.encryptedTokens).toBeNull();
  });

  it("declares no reply path, so the contract omits postReply", () => {
    expect(createFixtureConnector().postReply).toBeUndefined();
  });
});
