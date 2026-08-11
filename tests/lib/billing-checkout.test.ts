import { afterEach, describe, expect, it, vi } from "vitest";
import { canCheckout, isPurchasable } from "@/billing/checkout";
import { getBillingProvider, providerForCurrency, supportedCurrencies } from "@/billing/registry";
import { stripeProvider } from "@/billing/stripe";
import { PLAN_CATALOG, PLAN_KEYS } from "@/lib/plans";
import { CATALOG_CURRENCY, expectedPrices, priceLookupKey } from "@/billing/lookup-keys";

/**
 * Taking money, and refusing to pretend we can (W1.8).
 *
 * The audit's P0-7: Settings promised billing and had none — an amber "Choose a
 * plan" call to action that linked to a page with no plans on it. The fix is a
 * plan screen and a real Stripe checkout, and the thing worth testing without a
 * live Stripe account is the half that decides **whether to offer a payment
 * path at all**. A dead upgrade button is the failure this replaces; a button
 * that leads to a provider with no credentials would be the same failure
 * wearing a nicer coat.
 */

const KEY = "STRIPE_SECRET_KEY";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("whether to offer checkout at all", () => {
  it("says no when the provider has no credentials", () => {
    delete process.env[KEY];

    // The normal state of this repository, and it must never read as an error.
    expect(stripeProvider.isConfigured()).toBe(false);
    expect(canCheckout("USD")).toBe(false);
  });

  it("says yes once it does", () => {
    process.env[KEY] = "sk_test_stub";
    expect(canCheckout("USD")).toBe(true);
  });

  it("says no for a currency nobody handles", () => {
    process.env[KEY] = "sk_test_stub";

    // Not an error — it means "we cannot charge in this currency yet", which is
    // a sentence the screen can show. A default provider here would take a
    // payment in the wrong currency.
    expect(canCheckout("JPY")).toBe(false);
    expect(providerForCurrency("JPY")).toBeNull();
  });

  it("prefers iyzico for TRY, and falls back to Stripe while it is a stub", () => {
    process.env[KEY] = "sk_test_stub";

    // Two providers claim TRY: iyzico by right — e-fatura is a legal
    // obligation in Türkiye — and Stripe as a fallback so a Turkish business
    // can be charged at all before that adapter exists. Configured wins, and
    // today only Stripe is.
    expect(providerForCurrency("TRY")?.key).toBe("stripe");
    expect(canCheckout("TRY")).toBe(true);
  });

  it("still names iyzico as the TRY provider when nothing is configured", () => {
    delete process.env[KEY];

    // The refusal has to stay specific. "iyzico is not configured" and "nothing
    // handles this currency" are different problems with different fixes, and
    // collapsing them would hide which one this is.
    expect(providerForCurrency("TRY")?.key).toBe("iyzico");
    expect(canCheckout("TRY")).toBe(false);
  });

  it("gives TRY back to iyzico the day that adapter is real", () => {
    process.env[KEY] = "sk_test_stub";

    // The whole point of preferring a *configured* provider rather than merely
    // the first one: this flips with no code change anywhere else. Simulated by
    // standing in for the credentials check, since iyzico is still a stub.
    const iyzico = getBillingProvider("iyzico");
    const spy = vi.spyOn(iyzico, "isConfigured").mockReturnValue(true);

    expect(providerForCurrency("TRY")?.key).toBe("iyzico");

    spy.mockRestore();
  });

  it("is case- and whitespace-tolerant about a currency", () => {
    process.env[KEY] = "sk_test_stub";
    expect(canCheckout(" usd ")).toBe(true);
  });
});

describe("what can be bought without talking to anyone", () => {
  it("excludes the plan that is quoted per deal", () => {
    // Agency has no price, and a checkout that invented one would be the worst
    // possible way for a customer to discover that.
    expect(PLAN_CATALOG.agency.priceMonth).toBeNull();
    expect(isPurchasable("agency")).toBe(false);
  });

  it("includes every plan that has a price", () => {
    for (const key of PLAN_KEYS) {
      expect(isPurchasable(key)).toBe(PLAN_CATALOG[key].priceMonth !== null);
    }
  });
});

describe("the catalog the screen renders", () => {
  it("prices every plan in a currency somebody can bill", () => {
    // A plan priced in a currency no provider handles is a plan nobody can
    // buy — which the screen would show as a normal, clickable tier.
    const billable = supportedCurrencies();

    for (const key of PLAN_KEYS) {
      const plan = PLAN_CATALOG[key];
      if (plan.priceMonth === null) continue;
      expect(billable).toContain(plan.currency);
    }
  });

  it("states prices in minor units, so nobody charges a hundredth of the fee", () => {
    // $29.00 is 2_900 cents. The screen divides by 100; a catalog that held
    // major units would render $0.29 and charge it too.
    expect(PLAN_CATALOG.starter.priceMonth).toBe(2_900);
    expect(PLAN_CATALOG.growth.priceMonth).toBeGreaterThan(PLAN_CATALOG.starter.priceMonth!);
    expect(PLAN_CATALOG.pro.priceMonth).toBeGreaterThan(PLAN_CATALOG.growth.priceMonth!);
  });
});

/**
 * **Every price the catalog implies has a name, and the name is built once**
 * (11 Aug 2026).
 *
 * Checkout resolves Stripe prices by lookup key rather than building
 * `price_data` inline, because an inline `product_data` makes Stripe mint a new
 * Product on **every session** — that is where the orphaned "Revira Pro" in the
 * sandbox came from. The cost of pre-created prices is a second place a price
 * can live, and the thing that stops it drifting is `pnpm stripe:sync`.
 *
 * These are the invariants that command relies on. They are unit tests rather
 * than a call to Stripe on purpose: the question is whether the *derivation* is
 * right, and asking Stripe would test the network.
 */
describe("the Stripe price catalog derived from PLAN_CATALOG", () => {
  it("prices exactly what the catalog says is sold, and nothing it does not", () => {
    const keys = expectedPrices().map((p) => p.lookupKey);

    // Agency has no self-serve base price — `priceMonth` is null because it is
    // quoted per deal, and inventing one is the failure this guards.
    expect(keys).not.toContain("fairfame_agency_monthly");
    expect(keys).not.toContain("fairfame_agency_yearly");

    // Starter includes one location and sells no extras, so there is no add-on
    // price to create. Absent, not zero.
    expect(keys).not.toContain("fairfame_starter_extra_location_monthly");

    // The ones that are genuinely sold.
    expect(keys).toContain("fairfame_starter_monthly");
    expect(keys).toContain("fairfame_pro_yearly");
    expect(keys).toContain("fairfame_agency_extra_location_monthly");
  });

  it("carries the catalog's own amounts, so the script compares like with like", () => {
    const byKey = new Map(expectedPrices().map((p) => [p.lookupKey, p.amount]));

    expect(byKey.get("fairfame_starter_monthly")).toBe(PLAN_CATALOG.starter.priceMonth);
    expect(byKey.get("fairfame_pro_yearly")).toBe(PLAN_CATALOG.pro.priceYear);
    expect(byKey.get("fairfame_growth_extra_location_monthly")).toBe(
      PLAN_CATALOG.growth.priceExtraLocationMonth,
    );
  });

  it("never emits a zero amount, because absence is null and not free", () => {
    // A `0` here would create a real Stripe price charging nothing — the exact
    // shape `docs/15`'s "absence is null, never 0" rule exists to prevent, with
    // money attached.
    for (const price of expectedPrices()) {
      expect(price.amount, price.lookupKey).toBeGreaterThan(0);
    }
  });

  it("builds each key one way, so the writer and the reader cannot disagree", () => {
    // `stripe-sync` writes these and `stripe.ts` reads them. If the two ever
    // built the string differently the symptom would be a checkout that 500s on
    // a price that exists.
    expect(priceLookupKey("pro", "month")).toBe("fairfame_pro_monthly");
    expect(priceLookupKey("pro", "year")).toBe("fairfame_pro_yearly");
    expect(priceLookupKey("growth", "month", "extra_location")).toBe(
      "fairfame_growth_extra_location_monthly",
    );

    // And the keys are unique — two catalog entries sharing one lookup key
    // would silently bill one as the other.
    const keys = expectedPrices().map((p) => p.lookupKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("prices only in the catalog's currency", () => {
    // The bug this replaced charged `unit_amount` from a USD catalog labelled
    // with the organization's own currency: a TRY account was billed ₺229
    // instead of roughly ₺8,000.
    expect(CATALOG_CURRENCY).toBe("usd");
  });
});
