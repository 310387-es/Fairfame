import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireActor } from "@/auth/session";
import { completeOAuthConnection, redirectUriFor } from "@/connectors/connect-flow";
import { exchangeCodeForTokens, OAuthError } from "@/connectors/oauth/client";
import {
  assertStateMatches,
  OAUTH_COOKIE,
  OAuthStateError,
  openOAuthSession,
} from "@/connectors/oauth/state";
import { oauthConfigFor } from "@/connectors/providers";
import { getEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import { withTenant } from "@/lib/tenancy";

/**
 * Step two: /api/connect/{provider}/callback.
 *
 * Four things must all hold before a single token is exchanged:
 *
 *   1. the signed session cookie is present, intact and unexpired;
 *   2. the `state` the provider echoed matches the nonce in that cookie;
 *   3. the cookie names the same provider as the URL;
 *   4. the *current session* belongs to the organization the cookie names.
 *
 * (4) is the one that is easy to leave out. Without it, an attacker who starts
 * a handshake in their own account can hand the resulting callback URL to a
 * victim and have their platform account attached to whichever organization the
 * victim happens to be signed into.
 */

const log = childLogger({ module: "api/connect/callback" });

function failure(origin: string, reason: string): NextResponse {
  // Errors go back to the UI as a query parameter rather than a raw page: the
  // customer should land somewhere that can explain itself.
  const target = new URL("/locations", origin);
  target.searchParams.set("connect_error", reason);
  return NextResponse.redirect(target, 302);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await params;
  const url = new URL(request.url);
  const origin = url.origin;

  const store = await cookies();
  const cookie = store.get(OAUTH_COOKIE)?.value;
  // One-shot: the handshake is over either way, so the cookie goes now rather
  // than lingering as a replayable artefact.
  store.delete({ name: OAUTH_COOKIE, path: "/api/connect" });

  if (!cookie) return failure(origin, "expired");

  // The customer declining at the consent screen is a normal outcome.
  const providerError = url.searchParams.get("error");
  if (providerError) {
    log.info({ provider, providerError }, "Authorization declined at the provider");
    return failure(origin, providerError === "access_denied" ? "declined" : "provider_error");
  }

  let session;
  try {
    session = openOAuthSession(cookie, getEnv().BETTER_AUTH_SECRET);
    assertStateMatches(session, url.searchParams.get("state"));
  } catch (error) {
    if (error instanceof OAuthStateError) {
      log.warn({ provider, reason: error.message }, "Rejected an OAuth callback");
      return failure(origin, "state_mismatch");
    }
    throw error;
  }

  if (session.provider !== provider) return failure(origin, "state_mismatch");

  const code = url.searchParams.get("code");
  if (!code) return failure(origin, "missing_code");

  // (4): the browser completing the handshake must still be the account that
  // started it, in the same organization.
  const actor = await requireActor().catch(() => null);
  if (!actor || actor.organizationId !== session.organizationId) {
    log.warn({ provider }, "OAuth callback did not match the signed-in organization");
    return failure(origin, "session_mismatch");
  }

  const config = oauthConfigFor(provider);
  if (!config) return failure(origin, "not_configured");

  try {
    const tokens = await exchangeCodeForTokens({
      endpoints: config.endpoints,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: redirectUriFor(provider),
      codeVerifier: session.codeVerifier,
    });

    await withTenant({ organizationId: actor.organizationId, userId: actor.userId }, (tx) =>
      completeOAuthConnection(tx, {
        organizationId: actor.organizationId,
        locationId: session.locationId,
        provider,
        tokens,
        actorUserId: actor.userId,
      }),
    );
  } catch (error) {
    // The provider's own words are useful to us and meaningless to the
    // customer, so they go to the log and a code goes to the screen.
    log.error(
      { provider, code: error instanceof OAuthError ? error.code : undefined, err: error },
      "Token exchange failed",
    );
    return failure(origin, "exchange_failed");
  }

  const target = new URL(session.returnTo, origin);
  target.searchParams.set("connected", provider);
  return NextResponse.redirect(target, 302);
}
