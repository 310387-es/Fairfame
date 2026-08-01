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
 * iyzico adapter — Türkiye billing in TRY.
 *
 * A stub, deliberately. Türkiye needs a local PSP for TRY collection and
 * e-fatura, which Stripe does not cover, so the seam exists now to keep that
 * assumption visible; the integration itself belongs to a later phase.
 *
 * No SDK dependency yet: adding one for a stub would commit us to a client
 * before the integration is designed.
 */

function credentials(): { apiKey: string; secretKey: string } | null {
  const apiKey = billingSecret("IYZICO_API_KEY");
  const secretKey = billingSecret("IYZICO_SECRET_KEY");
  if (!apiKey || !secretKey) return null;
  return { apiKey, secretKey };
}

export const iyzicoProvider: BillingProvider = {
  key: "iyzico",
  currencies: ["TRY"],

  isConfigured(): boolean {
    return credentials() !== null;
  },

  async ensureCustomer(): Promise<BillingCustomer> {
    if (!iyzicoProvider.isConfigured()) throw new BillingNotConfiguredError("iyzico");
    throw new BillingNotImplementedError("iyzico", "ensureCustomer");
  },

  async createCheckoutSession(_request: CheckoutRequest): Promise<CheckoutSession> {
    if (!iyzicoProvider.isConfigured()) throw new BillingNotConfiguredError("iyzico");
    throw new BillingNotImplementedError("iyzico", "createCheckoutSession");
  },

  async parseWebhook(_payload: string, _signature: string): Promise<BillingEvent> {
    if (!iyzicoProvider.isConfigured()) throw new BillingNotConfiguredError("iyzico");
    throw new BillingNotImplementedError("iyzico", "parseWebhook");
  },
};
