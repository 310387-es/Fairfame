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

/**
 * In preference order, which is what makes TRY work correctly.
 *
 * iyzico first because it is the *right* provider for Türkiye — e-fatura is a
 * legal obligation there — and Stripe carries TRY only as a fallback. Ordering
 * alone is not enough, though: today iyzico is a stub with no credentials, so
 * `providerForCurrency` prefers whichever candidate is actually configured and
 * falls back to the first that claims the currency. The effect is that TRY goes
 * to Stripe now and moves to iyzico the day that adapter is real, with no code
 * change anywhere else.
 */
const PROVIDERS: Record<BillingProviderKey, BillingProvider> = {
  iyzico: iyzicoProvider,
  stripe: stripeProvider,
};

export function getBillingProvider(key: BillingProviderKey): BillingProvider {
  return PROVIDERS[key];
}

export function listBillingProviders(): BillingProvider[] {
  return Object.values(PROVIDERS);
}

/**
 * The provider responsible for a currency, or null when nothing handles it.
 *
 * Null is a legitimate answer — it means "we cannot charge in this currency
 * yet", which is better surfaced than papered over with a default.
 *
 * **A configured provider wins over a preferred one.** Two providers can claim
 * the same currency (TRY is claimed by iyzico by right and by Stripe as a
 * fallback), and returning the preferred-but-unbuilt one would mean a business
 * that we *can* charge is told we cannot. Falling back to the first claimant
 * when none is configured keeps the refusal specific: the caller still learns
 * which provider is missing rather than being told nothing handles the
 * currency, and those are different problems.
 */
export function providerForCurrency(currency: string): BillingProvider | null {
  const normalized = currency.trim().toUpperCase();
  const candidates = listBillingProviders().filter((provider) =>
    provider.currencies.includes(normalized),
  );

  return candidates.find((provider) => provider.isConfigured()) ?? candidates[0] ?? null;
}

/** Every currency the product can bill in today. */
export function supportedCurrencies(): string[] {
  return [...new Set(listBillingProviders().flatMap((provider) => provider.currencies))].sort();
}
