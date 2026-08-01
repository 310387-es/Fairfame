import { iyzicoProvider } from "./iyzico.ts";
import { stripeProvider } from "./stripe.ts";
import type { BillingProvider, BillingProviderKey } from "./types.ts";

/**
 * Provider selection.
 *
 * Routing is by currency, not by country: an organization's `currency` column
 * already carries the decision, and inferring a payment provider from an IP or
 * a locale would be wrong for anyone billed outside where they happen to sit.
 */

const PROVIDERS: Record<BillingProviderKey, BillingProvider> = {
  stripe: stripeProvider,
  iyzico: iyzicoProvider,
};

export function getBillingProvider(key: BillingProviderKey): BillingProvider {
  return PROVIDERS[key];
}

export function listBillingProviders(): BillingProvider[] {
  return Object.values(PROVIDERS);
}

/**
 * The provider responsible for a currency, or null when nothing handles it.
 * Null is a legitimate answer — it means "we cannot charge in this currency
 * yet", which is better surfaced than papered over with a default.
 */
export function providerForCurrency(currency: string): BillingProvider | null {
  const normalized = currency.trim().toUpperCase();
  return (
    listBillingProviders().find((provider) => provider.currencies.includes(normalized)) ?? null
  );
}

/** Every currency the product can bill in today. */
export function supportedCurrencies(): string[] {
  return [...new Set(listBillingProviders().flatMap((provider) => provider.currencies))].sort();
}
