import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * CSRF state and PKCE for the OAuth handshake.
 *
 * Two secrets travel between `/start` and `/callback`, and they travel
 * differently on purpose:
 *
 * - The **state** goes through the provider and back in the query string. It is
 *   a nonce plus an HMAC, and it is public — anything secret in a URL ends up in
 *   browser history, `Referer` headers and access logs.
 * - The **PKCE verifier** must never leave our server, so it rides in an
 *   httpOnly cookie alongside a copy of the nonce. Only the code challenge —
 *   its SHA-256 — is sent to the provider.
 *
 * The callback is trusted only when the signed nonce in the query matches the
 * nonce in the cookie. That is what stops an attacker from feeding a victim's
 * browser their own authorization code and quietly attaching their platform
 * account to the victim's organization.
 */

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthStateError";
  }
}

/** What the cookie remembers while the customer is away at the provider. */
export type OAuthSession = {
  nonce: string;
  provider: string;
  organizationId: string;
  locationId: string;
  /** Absent when the provider does not support PKCE. */
  codeVerifier?: string;
  /** Epoch milliseconds. A handshake that takes longer than this is abandoned. */
  expiresAt: number;
  /** Where to send the user once the connection is made. */
  returnTo: string;
};

/** Ten minutes: long enough to read a consent screen, short enough to be useless later. */
export const OAUTH_SESSION_TTL_MS = 10 * 60 * 1_000;

export const OAUTH_COOKIE = "fairfame_oauth";

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Encodes and signs the cookie payload. */
export function sealOAuthSession(session: OAuthSession, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function openOAuthSession(cookie: string, secret: string, now = Date.now()): OAuthSession {
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) throw new OAuthStateError("Malformed OAuth session cookie.");

  const expected = sign(payload, secret);
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and a forged cookie should be rejected, not crash.
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    throw new OAuthStateError("OAuth session cookie failed signature verification.");
  }

  let session: OAuthSession;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthSession;
  } catch {
    throw new OAuthStateError("OAuth session cookie is not readable.");
  }

  if (typeof session.expiresAt !== "number" || session.expiresAt < now) {
    throw new OAuthStateError("The connection attempt expired. Please try again.");
  }

  return session;
}

/**
 * Verifies the `state` the provider handed back against the cookie.
 *
 * Compared in constant time — the nonce is the only thing standing between a
 * legitimate callback and a forged one.
 */
export function assertStateMatches(session: OAuthSession, state: string | null): void {
  if (!state) throw new OAuthStateError("The provider did not return a state parameter.");

  const a = Buffer.from(session.nonce);
  const b = Buffer.from(state);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new OAuthStateError("OAuth state did not match. The connection attempt was abandoned.");
  }
}

/** 256 bits of nonce. */
export function generateNonce(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A PKCE verifier: RFC 7636 allows 43–128 unreserved characters, and 32 random
 * bytes in base64url lands at 43.
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** The S256 challenge derived from a verifier. */
export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
