import { afterEach, describe, expect, it } from "vitest";
import { PROVIDERS, resolveModeFor } from "@/connectors/providers";
import { getEnv, resetEnvForTesting } from "@/lib/env";

/**
 * "Mock in dev, real only where credentials are present" (P1b-T6).
 *
 * The Definition of Done states it as a property of the whole system rather
 * than of any one connector, so it is tested that way: over **every** provider
 * in the registry, not the two that happen to have suites.
 *
 * The invariant that matters is the negative one. There must be no
 * configuration in which a missing credential results in an attempted live
 * call — because the first such call would go to a real business's account with
 * a half-configured client.
 */

const VAULT_KEY = `k1:${Buffer.alloc(32, 3).toString("base64")}`;

function envWith(overrides: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  resetEnvForTesting();
  return { env: getEnv(), previous };
}

afterEach(() => {
  resetEnvForTesting();
});

/**
 * The real OAuth providers.
 *
 * `fixture` is excluded deliberately: it is a synthetic provider that exists so
 * the OAuth framework itself can be tested against recorded HTTP, and it
 * supplies its own hard-coded credentials. Asserting it demotes without
 * credentials would be asserting something about a test double.
 */
const OAUTH_PROVIDERS = Object.values(PROVIDERS).filter(
  (descriptor) => descriptor.requiresOAuth && descriptor.key !== "fixture",
);

/** Every mode flag, so a test can start from a clean slate. */
const MODE_VARS = Object.values(PROVIDERS).map((descriptor) => String(descriptor.modeEnvVar));

function clearedModes(): Record<string, undefined> {
  return Object.fromEntries(MODE_VARS.map((name) => [name, undefined]));
}

describe("provider flags", () => {
  it("defaults every third-party provider to mock", () => {
    const { env } = envWith(clearedModes());

    // Not one provider, all of them. A new connector added without a default
    // would otherwise be discovered in production.
    for (const descriptor of Object.values(PROVIDERS)) {
      if (!descriptor.requiresOAuth) continue;
      expect(resolveModeFor(env, descriptor.key).mode).not.toBe("real");
    }
  });

  it("keeps the sources we own real, since there is nothing to demote to", () => {
    const { env } = envWith(clearedModes());

    // The mock source and the first-party page have no external credentials and
    // no third party to be approved by. Mocking them would mean mocking
    // ourselves — a first-party submission is always genuinely ours.
    for (const descriptor of Object.values(PROVIDERS)) {
      if (descriptor.requiresOAuth) continue;
      expect(resolveModeFor(env, descriptor.key).mode).toBe("real");
    }
  });

  it.each(OAUTH_PROVIDERS)(
    "$key demotes to mock when asked for real without credentials",
    (descriptor) => {
      const { env } = envWith({
        [String(descriptor.modeEnvVar)]: "real",
        TOKEN_VAULT_KEYS: VAULT_KEY,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        META_APP_ID: undefined,
        META_APP_SECRET: undefined,
      });

      const resolution = resolveModeFor(env, descriptor.key);

      // Demoted, and the reason recorded — the Locations screen shows it, so an
      // owner learns why a source is serving sample data.
      expect(resolution.mode).toBe("mock");
      expect(resolution.reason).toBe("missing_credentials");
    },
  );

  it.each(OAUTH_PROVIDERS)("$key demotes to mock without a usable vault", (descriptor) => {
    const { env } = envWith({
      [String(descriptor.modeEnvVar)]: "real",
      TOKEN_VAULT_KEYS: undefined,
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      META_APP_ID: "id",
      META_APP_SECRET: "secret",
    });

    const resolution = resolveModeFor(env, descriptor.key);

    // A live connection means holding a refresh token. Without somewhere safe
    // to put it, going live is refused rather than done insecurely.
    expect(resolution.mode).toBe("mock");
    expect(resolution.reason).toBe("missing_vault");
  });

  it.each(OAUTH_PROVIDERS)("$key goes real only with both", (descriptor) => {
    const { env } = envWith({
      [String(descriptor.modeEnvVar)]: "real",
      TOKEN_VAULT_KEYS: VAULT_KEY,
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      META_APP_ID: "id",
      META_APP_SECRET: "secret",
    });

    expect(resolveModeFor(env, descriptor.key).mode).toBe("real");
  });

  it("respects an explicit off", () => {
    const { env } = envWith({ CONNECTOR_GOOGLE_MODE: "off" });
    expect(resolveModeFor(env, "google").mode).toBe("off");
  });

  it("treats an unknown provider as off rather than guessing", () => {
    const { env } = envWith(clearedModes());
    expect(resolveModeFor(env, "tripadvisor").mode).toBe("off");
  });

  it("gives every provider a go-live note", () => {
    // `docs/13-go-live.md` is the long form; this is what the Locations screen
    // shows. A provider with no note leaves an owner guessing why it is mocked.
    for (const descriptor of OAUTH_PROVIDERS) {
      expect(descriptor.goLiveNote).toBeTruthy();
    }
  });
});
