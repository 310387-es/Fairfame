// Type-only: erased at compile time, so importing the type here does not pull
// the SDK into any bundle. The dynamic import below is the only real load.
import type Stripe from "stripe";
import { billingSecret } from "./credentials.ts";
import {
  BillingNotConfiguredError,
  BillingNotImplementedError,
  type BillingCustomer,
  type BillingEvent,
  type BillingProvider,
  type CheckoutRequest,
  type CheckoutSession,
} from "./types.ts";

/**
 * Stripe adapter — international billing (USD/EUR).
 *
 * The SDK is imported dynamically and only when a secret key is present, so an
 * unconfigured deployment never loads it and the client bundle never sees it.
 *
 * Phase 0 wires the seam, not the money: customer creation and checkout throw
 * BillingNotImplementedError rather than quietly succeeding. What already
 * works end to end is the part that matters for the product — assigning a plan
 * changes an organization's entitlements, with no provider involved.
 */

let clientPromise: Promise<Stripe> | null = null;

function secretKey(): string | undefined {
  return billingSecret("STRIPE_SECRET_KEY");
}

/** Lazily constructs the SDK client. Only called once configured. */
async function getClient(): Promise<Stripe> {
  const key = secretKey();
  if (!key) throw new BillingNotConfiguredError("stripe");

  clientPromise ??= import("stripe").then((module) => new module.default(key));
  return clientPromise;
}

export const stripeProvider: BillingProvider = {
  key: "stripe",
  currencies: ["USD", "EUR"],

  isConfigured(): boolean {
    return secretKey() !== undefined;
  },

  async ensureCustomer(): Promise<BillingCustomer> {
    if (!stripeProvider.isConfigured()) throw new BillingNotConfiguredError("stripe");
    throw new BillingNotImplementedError("stripe", "ensureCustomer");
  },

  async createCheckoutSession(_request: CheckoutRequest): Promise<CheckoutSession> {
    if (!stripeProvider.isConfigured()) throw new BillingNotConfiguredError("stripe");
    throw new BillingNotImplementedError("stripe", "createCheckoutSession");
  },

  async parseWebhook(_payload: string, _signature: string): Promise<BillingEvent> {
    if (!stripeProvider.isConfigured()) throw new BillingNotConfiguredError("stripe");
    // Signature verification is the whole point of this method, so a stub that
    // returned an "event" would be a security hole wearing a placeholder's
    // clothes. Refuse until it is implemented properly.
    throw new BillingNotImplementedError("stripe", "parseWebhook");
  },
};

/** Exposed for the eventual real implementation and for diagnostics. */
export { getClient as getStripeClient };
