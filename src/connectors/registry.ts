import { mockConnector, MOCK_PROVIDER } from "./mock.ts";
import { ConnectorError, type Connector } from "./types.ts";

/**
 * Provider registry — the one place that maps a `provider` string to an
 * implementation.
 *
 * Adding Google or Instagram later means writing the connector and adding one
 * line here. Nothing else in the codebase branches on provider.
 */

const CONNECTORS: Record<string, Connector> = {
  [MOCK_PROVIDER]: mockConnector,
};

export function getConnector(provider: string): Connector {
  const connector = CONNECTORS[provider];
  if (!connector) {
    throw new ConnectorError(
      `Unknown connector provider "${provider}". Available: ${listProviders().join(", ")}.`,
      provider,
      false,
    );
  }
  return connector;
}

export function listProviders(): string[] {
  return Object.keys(CONNECTORS).sort();
}

export function hasConnector(provider: string): boolean {
  return provider in CONNECTORS;
}
