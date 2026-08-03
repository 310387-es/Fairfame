import { getEnv, type Env } from "../lib/env.ts";
import { parseVaultKeys } from "../lib/vault.ts";
import { FIRST_PARTY_PROVIDER, firstPartyCapabilities } from "./firstparty.ts";
import { MOCK_PROVIDER, mockCapabilities } from "./mock.ts";
import type { Capability } from "./types.ts";

/**
 * The provider catalogue: what sources exist, what each can do, how it
 * authenticates, and how fast it may be polled.
 *
 * One descriptor per source, in one file, so that "which providers does this
 * environment have, and are they live?" is a single lookup rather than a grep
 * through connect flows. Adding Google in T2 means filling in a descriptor and
 * writing the connector — nothing else in the app branches on provider.
 *
 * ## Modes, and why the default is mock
 *
 * Every credentialed provider is `mock` unless an environment explicitly says
 * otherwise *and* can back it up. `resolveMode()` demotes `real` to `mock`
 * whenever the credentials or the token vault are missing, because the
 * alternative — a connect button that throws at the OAuth callback — is worse
 * than seeded data. Going live is therefore a deliberate act in three parts:
 * set the flag, set the credentials, configure the vault.
 *
 * Providers that need no credentials (`mock`, `firstparty`) are always
 * available and have no flag to get wrong.
 */

export type ProviderMode = "mock" | "real" | "off";

/**
 * Polling budget for a provider, enforced by src/connectors/throttle.ts.
 *
 * Numbers here are the *documented* platform limits, deliberately conservative:
 * we would rather sync a location a minute later than have a quota strike
 * against an app whose approval took three months to obtain.
 */
export type RateLimitPolicy = {
  /** Requests per minute across the whole deployment, per provider. */
  requestsPerMinute: number;
  /** Smallest gap between two syncs of the *same* connection. */
  minSyncIntervalMs: number;
  /** Ceiling on exponential backoff after repeated failures. */
  maxBackoffMs: number;
};

export type OAuthEndpoints = {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** RFC 7636. Required by Google; harmless everywhere else. */
  usePkce: boolean;
  /** Provider-specific authorize parameters (Google's offline access, etc.). */
  authorizeParams?: Record<string, string>;
};

export type ProviderDescriptor = {
  key: string;
  label: string;
  capabilities: Capability;
  /** False for sources we own — nothing to authorize, nothing to gate. */
  requiresOAuth: boolean;
  oauth?: OAuthEndpoints;
  rateLimit: RateLimitPolicy;
  /**
   * Reads the client credentials out of a validated environment. Taking `env`
   * as an argument rather than calling `getEnv()` keeps mode resolution a pure
   * function, which is what makes "would this provider go live here?" testable
   * without a configured process.
   */
  credentials?: (env: Env) => { clientId?: string | undefined; clientSecret?: string | undefined };
  /** Which env flag governs this provider, for diagnostics. */
  modeEnvVar?: string;
  /** What blocks go-live, shown in the UI while the provider is on mock. */
  goLiveNote?: string;
};

const DEFAULT_RATE_LIMIT: RateLimitPolicy = {
  requestsPerMinute: 60,
  minSyncIntervalMs: 60_000,
  maxBackoffMs: 6 * 60 * 60 * 1_000,
};

export const PROVIDERS: Record<string, ProviderDescriptor> = {
  [MOCK_PROVIDER]: {
    key: MOCK_PROVIDER,
    label: "Mock source",
    capabilities: mockCapabilities,
    requiresOAuth: false,
    // Generated in-process: the only limit that matters is not spinning.
    rateLimit: { requestsPerMinute: 600, minSyncIntervalMs: 30_000, maxBackoffMs: 300_000 },
  },

  [FIRST_PARTY_PROVIDER]: {
    key: FIRST_PARTY_PROVIDER,
    label: "First-party page",
    capabilities: firstPartyCapabilities,
    requiresOAuth: false,
    // A push source is never polled; the scan finds nothing and moves on.
    rateLimit: { requestsPerMinute: 600, minSyncIntervalMs: 300_000, maxBackoffMs: 300_000 },
  },

  google: {
    key: "google",
    label: "Google Business Profile",
    // Full read and API replies, once access is granted (docs/03 §4).
    capabilities: { read: "full", reply: "api", realtime: false },
    requiresOAuth: true,
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/business.manage"],
      usePkce: true,
      authorizeParams: {
        // Without both of these Google returns no refresh token on re-consent,
        // and the connection silently dies an hour later.
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
      },
    },
    rateLimit: {
      // The Business Profile API's default quota is famously tight and is
      // raised only on request; 30/min leaves headroom under a 300/min project
      // quota shared with reply traffic.
      requestsPerMinute: 30,
      minSyncIntervalMs: 5 * 60_000,
      maxBackoffMs: 6 * 60 * 60 * 1_000,
    },
    credentials: (env) => ({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    }),
    modeEnvVar: "CONNECTOR_GOOGLE_MODE",
    goLiveNote: "Needs a verified business and an approved Business Profile API access request.",
  },

  instagram: {
    key: "instagram",
    label: "Instagram",
    // Comments and mentions arrive by webhook; replies only where permitted.
    capabilities: { read: "full", reply: "api", realtime: true },
    requiresOAuth: true,
    oauth: {
      authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
      scopes: ["instagram_basic", "instagram_manage_comments", "pages_show_list"],
      usePkce: false,
    },
    rateLimit: {
      requestsPerMinute: 60,
      minSyncIntervalMs: 5 * 60_000,
      maxBackoffMs: 6 * 60 * 60 * 1_000,
    },
    credentials: (env) => ({
      clientId: env.META_APP_ID,
      clientSecret: env.META_APP_SECRET,
    }),
    modeEnvVar: "CONNECTOR_INSTAGRAM_MODE",
    goLiveNote: "Needs Meta business verification and app review for the listed permissions.",
  },

  whatsapp: {
    key: "whatsapp",
    label: "WhatsApp Business",
    // Outbound messaging and inbound webhooks — not a review source to read.
    capabilities: { read: "none", reply: "api", realtime: true },
    requiresOAuth: true,
    oauth: {
      authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
      scopes: ["whatsapp_business_messaging", "whatsapp_business_management"],
      usePkce: false,
    },
    rateLimit: {
      requestsPerMinute: 60,
      minSyncIntervalMs: 5 * 60_000,
      maxBackoffMs: 6 * 60 * 60 * 1_000,
    },
    credentials: (env) => ({
      clientId: env.META_APP_ID,
      clientSecret: env.META_APP_SECRET,
    }),
    modeEnvVar: "CONNECTOR_WHATSAPP_MODE",
    goLiveNote: "Needs a WhatsApp Business Account, an approved template, and İYS registration.",
  },

  /**
   * A deliberately synthetic OAuth provider that speaks real HTTP against
   * recorded fixtures. It exists so this framework — authorize, exchange,
   * vault, refresh, throttle, backoff — is exercised end to end without
   * waiting on anyone's approval queue. See ./fixture.ts.
   */
  fixture: {
    key: "fixture",
    label: "Fixture provider",
    capabilities: { read: "excerpt", reply: "none", realtime: false },
    requiresOAuth: true,
    oauth: {
      authorizeUrl: "https://fixture.invalid/oauth/authorize",
      tokenUrl: "https://fixture.invalid/oauth/token",
      scopes: ["reviews.read"],
      usePkce: true,
    },
    rateLimit: { requestsPerMinute: 10, minSyncIntervalMs: 1_000, maxBackoffMs: 60_000 },
    credentials: () => ({ clientId: "fixture-client", clientSecret: "fixture-secret" }),
    modeEnvVar: "CONNECTOR_FIXTURE_MODE",
  },
};

export function getProvider(key: string): ProviderDescriptor | null {
  return PROVIDERS[key] ?? null;
}

export function rateLimitFor(key: string): RateLimitPolicy {
  return PROVIDERS[key]?.rateLimit ?? DEFAULT_RATE_LIMIT;
}

function configuredMode(env: Env, descriptor: ProviderDescriptor): ProviderMode {
  switch (descriptor.key) {
    case "google":
      return env.CONNECTOR_GOOGLE_MODE;
    case "instagram":
      return env.CONNECTOR_INSTAGRAM_MODE;
    case "whatsapp":
      return env.CONNECTOR_WHATSAPP_MODE;
    case "fixture":
      return env.CONNECTOR_FIXTURE_MODE;
    default:
      // Sources we own are always themselves.
      return "real";
  }
}

export type ResolvedMode = {
  mode: ProviderMode;
  /** What the environment asked for, before any demotion. */
  configured: ProviderMode;
  /** Why `real` was refused, when it was. */
  reason?: "missing_credentials" | "missing_vault";
};

/**
 * The effective mode for a provider in this environment.
 *
 * `real` is granted only when the provider has both halves of what going live
 * requires: client credentials, and a vault to keep the resulting tokens in.
 * Otherwise it is demoted to `mock` with the reason recorded, so the UI can say
 * *why* a source is still on sample data instead of leaving someone to guess.
 */
export function resolveModeFor(env: Env, key: string): ResolvedMode {
  const descriptor = getProvider(key);
  if (!descriptor) return { mode: "off", configured: "off" };

  const configured = configuredMode(env, descriptor);
  if (configured !== "real" || !descriptor.requiresOAuth) {
    return { mode: configured, configured };
  }

  const credentials = descriptor.credentials?.(env) ?? {};
  if (!credentials.clientId || !credentials.clientSecret) {
    return { mode: "mock", configured, reason: "missing_credentials" };
  }
  if (!vaultUsable(env)) {
    return { mode: "mock", configured, reason: "missing_vault" };
  }

  return { mode: "real", configured };
}

/** Can this environment keep a token safely? Mirrors lib/vault's own check. */
function vaultUsable(env: Env): boolean {
  if (!env.TOKEN_VAULT_KEYS) return false;
  try {
    parseVaultKeys(env.TOKEN_VAULT_KEYS);
    return true;
  } catch {
    return false;
  }
}

export function resolveMode(key: string): ResolvedMode {
  return resolveModeFor(getEnv(), key);
}

/** Providers an organization may connect, in a stable order. */
export function listConnectableProviders(): ProviderDescriptor[] {
  return Object.values(PROVIDERS)
    .filter((descriptor) => resolveMode(descriptor.key).mode !== "off")
    .sort((left, right) => left.key.localeCompare(right.key));
}

/** OAuth configuration for a provider that is actually live. Null otherwise. */
export function oauthConfigFor(key: string): {
  descriptor: ProviderDescriptor;
  endpoints: OAuthEndpoints;
  clientId: string;
  clientSecret: string;
} | null {
  const env = getEnv();
  const descriptor = getProvider(key);
  if (!descriptor?.oauth || resolveModeFor(env, key).mode !== "real") return null;

  const credentials = descriptor.credentials?.(env) ?? {};
  if (!credentials.clientId || !credentials.clientSecret) return null;

  return {
    descriptor,
    endpoints: descriptor.oauth,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  };
}
