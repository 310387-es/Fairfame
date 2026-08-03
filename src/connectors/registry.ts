import { firstPartyConnector, FIRST_PARTY_PROVIDER } from "./firstparty.ts";
import { GOOGLE_PROVIDER } from "./google/client.ts";
import { googleConnector } from "./google/connector.ts";
import { INSTAGRAM_PROVIDER } from "./instagram/client.ts";
import { instagramConnector } from "./instagram/connector.ts";
import { createMockConnector, mockConnector, MOCK_PROVIDER } from "./mock.ts";
import { getProvider, PROVIDERS, resolveMode } from "./providers.ts";
import { ConnectorError, type Connector } from "./types.ts";

/**
 * Provider key → implementation, resolved through the environment's flags.
 *
 * This is where "MockConnector is the dev default" is actually enforced. A
 * provider in `mock` mode resolves to a mock wearing that provider's identity
 * and declared capabilities, so the rest of the system — ingestion, dedup, the
 * Inbox, the capability-driven UI — runs the same code path it will run against
 * the real API. Going live swaps the object returned here and nothing else.
 *
 * Real implementations register themselves in `REAL_CONNECTORS` as they land
 * (T2 Google, T4 Instagram). WhatsApp has no entry: it is outbound messaging
 * with `read: "none"`, so it is never synced and never resolved here — its send
 * path lives in `src/messaging/whatsapp.ts`. A provider forced to `real`
 * without an implementation fails loudly rather than pretending.
 */

const REAL_CONNECTORS: Record<string, Connector> = {
  [MOCK_PROVIDER]: mockConnector,
  [FIRST_PARTY_PROVIDER]: firstPartyConnector,
  // Reached only when CONNECTOR_GOOGLE_MODE=real *and* credentials and a vault
  // are present; otherwise `resolveMode` hands back a mocked Google instead.
  [GOOGLE_PROVIDER]: googleConnector,
  // Same conditions: reached only when CONNECTOR_INSTAGRAM_MODE=real *and*
  // Meta credentials and a vault are present.
  [INSTAGRAM_PROVIDER]: instagramConnector,
};

/**
 * Registers a real implementation. Used by the connector modules themselves and
 * by tests that need the fixture-backed provider in `real` mode.
 */
export function registerConnector(connector: Connector): void {
  REAL_CONNECTORS[connector.provider] = connector;
}

/** Test seam: forget a registration so a suite cannot leak into the next. */
export function unregisterConnector(provider: string): void {
  if (provider === MOCK_PROVIDER || provider === FIRST_PARTY_PROVIDER) return;
  delete REAL_CONNECTORS[provider];
}

/** One mock instance per provider identity — they are stateless and reusable. */
const mockedProviders = new Map<string, Connector>();

function mockedProvider(key: string): Connector {
  const descriptor = getProvider(key);
  if (!descriptor) throw unknownProvider(key);

  let connector = mockedProviders.get(key);
  if (!connector) {
    connector = createMockConnector({ provider: key, capabilities: descriptor.capabilities });
    mockedProviders.set(key, connector);
  }
  return connector;
}

function unknownProvider(provider: string): ConnectorError {
  return new ConnectorError(
    `Unknown connector provider "${provider}". Available: ${listProviders().join(", ")}.`,
    provider,
    false,
  );
}

export function getConnector(provider: string): Connector {
  const descriptor = getProvider(provider);
  if (!descriptor) throw unknownProvider(provider);

  /**
   * Sources we own have no flag, no credentials and no consent screen, so
   * resolving one must not require a validated environment. Reading `getEnv()`
   * here would make the mock connector — the thing everything else is built and
   * tested against — unusable in any context without a full configuration.
   */
  if (!descriptor.requiresOAuth) {
    return REAL_CONNECTORS[provider] ?? mockedProvider(provider);
  }

  const { mode } = resolveMode(provider);

  if (mode === "off") {
    throw new ConnectorError(
      `Provider "${provider}" is switched off in this environment.`,
      provider,
      false,
    );
  }

  if (mode === "mock") return mockedProvider(provider);

  const real = REAL_CONNECTORS[provider];
  if (!real) {
    // Configured live, but the connector has not been written yet. Better a
    // clear error at resolution than a half-working source in production.
    throw new ConnectorError(
      `Provider "${provider}" is set to real mode, but no implementation is registered yet.`,
      provider,
      false,
    );
  }

  return real;
}

/** Every provider key known to the catalogue. */
export function listProviders(): string[] {
  return Object.keys(PROVIDERS).sort();
}

export function hasConnector(provider: string): boolean {
  return getProvider(provider) !== null;
}
