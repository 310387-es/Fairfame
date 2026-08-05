import { describe, expect, it } from "vitest";
import { iyzicoProvider } from "@/billing/iyzico";
import {
  getBillingProvider,
  listBillingProviders,
  providerForCurrency,
  supportedCurrencies,
} from "@/billing/registry";
import { stripeProvider } from "@/billing/stripe";
import {
  BillingNotConfiguredError,
  BillingNotImplementedError,
  type CheckoutRequest,
} from "@/billing/types";
import { PLAN_CATALOG, PLAN_KEYS } from "@/lib/plans";

const checkout: CheckoutRequest = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  planKey: "growth",
  currency: "TRY",
  successUrl: "https://example.test/ok",
  cancelUrl: "https://example.test/cancel",
};

describe("provider registry", () => {
  it("routes TRY to iyzico — Türkiye needs a local PSP for e-fatura", () => {
    expect(providerForCurrency("TRY")?.key).toBe("iyzico");
  });

  it("routes USD and EUR to Stripe", () => {
    expect(providerForCurrency("USD")?.key).toBe("stripe");
    expect(providerForCurrency("EUR")?.key).toBe("stripe");
  });

  it("normalizes currency casing and whitespace", () => {
    expect(providerForCurrency(" try ")?.key).toBe("iyzico");
    expect(providerForCurrency("usd")?.key).toBe("stripe");
  });

  it("returns null for a currency nobody handles, rather than a default", () => {
    // Silently falling back to a provider that cannot settle the currency
    // would surface as a failed charge much later.
    expect(providerForCurrency("GBP")).toBeNull();
    expect(providerForCurrency("")).toBeNull();
  });

  /**
   * This used to assert that each currency belonged to exactly one provider,
   * and that invariant was deliberately given up in W1.8.
   *
   * TRY is now claimed twice — by iyzico, which is the right provider for
   * Türkiye because e-fatura is a legal obligation there, and by Stripe as a
   * fallback so a Turkish business can be charged at all while that adapter is
   * a stub. What has to hold instead is that the *resolution* is unambiguous:
   * one provider comes back, the same one every time, and a configured one is
   * preferred over a merely preferred one.
   */
  it("resolves every claimed currency to exactly one provider", () => {
    const claimed = [...new Set(listBillingProviders().flatMap((provider) => provider.currencies))];

    expect(claimed.length).toBeGreaterThan(0);

    for (const currency of claimed) {
      const resolved = providerForCurrency(currency);
      expect(resolved, `${currency} resolves to nothing`).not.toBeNull();
      // Stable: asking twice must not depend on iteration order or on which
      // module happened to load first.
      expect(providerForCurrency(currency)?.key).toBe(resolved?.key);
    }
  });

  it("covers the currency the plan catalog is priced in", () => {
    // The catalog is TRY today; if pricing moved to a currency no provider
    // handles, checkout would be impossible.
    for (const key of PLAN_KEYS) {
      expect(supportedCurrencies()).toContain(PLAN_CATALOG[key].currency);
    }
  });

  it("resolves providers by key", () => {
    expect(getBillingProvider("stripe").key).toBe("stripe");
    expect(getBillingProvider("iyzico").key).toBe("iyzico");
  });
});

describe("configuration reporting", () => {
  it("reports unconfigured without throwing", () => {
    // Callers use this to decide whether to offer a payment path at all,
    // instead of discovering the gap mid-checkout.
    expect(() => stripeProvider.isConfigured()).not.toThrow();
    expect(() => iyzicoProvider.isConfigured()).not.toThrow();
    expect(typeof stripeProvider.isConfigured()).toBe("boolean");
  });

  it("treats absent credentials as unconfigured in this environment", () => {
    // The test environment sets no billing credentials.
    expect(iyzicoProvider.isConfigured()).toBe(false);
  });
});

describe("Phase 0 refuses to move money", () => {
  const cases = [
    ["stripe", stripeProvider],
    ["iyzico", iyzicoProvider],
  ] as const;

  it.each(cases)("%s.createCheckoutSession() does not silently succeed", async (_key, provider) => {
    // A stub that returned a fake session would be far worse than one that
    // refuses: the caller would believe payment was collected.
    await expect(provider.createCheckoutSession(checkout)).rejects.toThrow(
      expect.objectContaining({
        name: expect.stringMatching(/BillingNot(Configured|Implemented)Error/),
      }) as Error,
    );
  });

  it.each(cases)("%s.ensureCustomer() does not silently succeed", async (_key, provider) => {
    await expect(
      provider.ensureCustomer({ organizationId: "org", name: "Test" }),
    ).rejects.toThrow();
  });

  it.each(cases)(
    "%s.parseWebhook() never accepts an unverified payload",
    async (_key, provider) => {
      // Returning a parsed "event" without signature verification would be a
      // security hole dressed as a placeholder.
      await expect(provider.parseWebhook("{}", "sig")).rejects.toThrow();
    },
  );
});

describe("error types", () => {
  it("names the provider and operation, so failures are actionable", () => {
    const error = new BillingNotImplementedError("iyzico", "createCheckoutSession");

    expect(error.provider).toBe("iyzico");
    expect(error.operation).toBe("createCheckoutSession");
    expect(error.message).toContain("skeleton only");
  });

  it("distinguishes unconfigured from unimplemented", () => {
    expect(new BillingNotConfiguredError("stripe").name).toBe("BillingNotConfiguredError");
    expect(new BillingNotImplementedError("stripe", "x").name).toBe("BillingNotImplementedError");
  });
});
