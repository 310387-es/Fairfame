import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertRoleAtLeast,
  ForbiddenError,
  NoActiveOrganizationError,
  requireActor,
  UnauthenticatedError,
} from "@/auth/session";
import { redirectUriFor } from "@/connectors/connect-flow";
import { buildAuthorizationUrl } from "@/connectors/oauth/client";
import {
  generateCodeVerifier,
  generateNonce,
  OAUTH_COOKIE,
  OAUTH_SESSION_TTL_MS,
  sealOAuthSession,
} from "@/connectors/oauth/state";
import { oauthConfigFor, resolveMode } from "@/connectors/providers";
import { getEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";

/**
 * Step one of connecting a real source: /api/connect/{provider}/start.
 *
 * Mints the CSRF nonce and the PKCE verifier, parks them in an httpOnly cookie,
 * and sends the customer to the provider's consent screen. Only the nonce and
 * the derived code *challenge* travel in the URL — the verifier never leaves
 * the server, which is the whole point of PKCE in a confidential client.
 *
 * A provider on mock mode has no consent screen to visit; the UI connects those
 * directly, so reaching this route for one is a bug worth a clear message.
 */

const log = childLogger({ module: "api/connect/start" });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await params;
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId") ?? "";

  if (!z.uuid().safeParse(locationId).success) {
    return NextResponse.json({ error: "A valid locationId is required." }, { status: 400 });
  }

  let actor;
  try {
    actor = await requireActor();
    // Connecting a source is an administrative act: it grants us standing
    // access to the customer's platform account.
    assertRoleAtLeast(actor, "admin");
  } catch (error) {
    if (error instanceof UnauthenticatedError || error instanceof NoActiveOrganizationError) {
      return NextResponse.redirect(new URL("/sign-in", url.origin), 302);
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }

  const config = oauthConfigFor(provider);
  if (!config) {
    const resolution = resolveMode(provider);
    return NextResponse.json(
      {
        error: `"${provider}" is not available for a live connection here.`,
        mode: resolution.mode,
        reason: resolution.reason ?? "not_configured",
      },
      { status: 409 },
    );
  }

  const nonce = generateNonce();
  const codeVerifier = config.endpoints.usePkce ? generateCodeVerifier() : undefined;

  const session = {
    nonce,
    provider,
    organizationId: actor.organizationId,
    locationId,
    ...(codeVerifier ? { codeVerifier } : {}),
    expiresAt: Date.now() + OAUTH_SESSION_TTL_MS,
    returnTo: "/locations",
  };

  const store = await cookies();
  store.set(OAUTH_COOKIE, sealOAuthSession(session, getEnv().BETTER_AUTH_SECRET), {
    httpOnly: true,
    // Lax, not Strict: the provider redirects back with a top-level GET, and
    // Strict would withhold the cookie on exactly that navigation.
    sameSite: "lax",
    secure: getEnv().NODE_ENV === "production",
    path: "/api/connect",
    maxAge: Math.floor(OAUTH_SESSION_TTL_MS / 1_000),
  });

  const authorizeUrl = buildAuthorizationUrl({
    endpoints: config.endpoints,
    clientId: config.clientId,
    redirectUri: redirectUriFor(provider),
    state: nonce,
    codeVerifier,
  });

  log.info(
    { organizationId: actor.organizationId, provider, locationId },
    "Starting OAuth authorization",
  );

  return NextResponse.redirect(authorizeUrl, 302);
}
