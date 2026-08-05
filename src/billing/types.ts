import type { PlanKey } from "../lib/plans.ts";

/**
 * The billing provider seam.
 *
 * Türkiye is billed in TRY through a local PSP (iyzico) for e-fatura, while
 * international billing goes through Stripe in USD/EUR — so there was never
 * going to be one provider. Putting the interface in first means the second
 * provider is an adapter rather than a refactor.
 *
 * Phase 0 ships no live payment flow. Adapters exist, are selected by
 * currency, and report honestly that checkout is not wired up. Crucially,
 * entitlements do not depend on any of this: assigning a plan changes what an
 * organization can do whether or not money ever moves.
 */

export type BillingProviderKey = "stripe" | "iyzico";

export type BillingCustomer = {
  /** The provider's own customer identifier. */
  providerId: string;
};

export type CheckoutRequest = {
  organizationId: string;
  planKey: PlanKey;
  /** ISO 4217, e.g. "TRY". */
  currency: string;
  /**
   * The provider's existing customer for this organization, when there is one
   * (W1.8).
   *
   * Passing it is what keeps a business to *one* customer record across
   * cancellations and restarts. Omitted the first time, when the provider mints
   * one during checkout.
   */
  customerId?: string | undefined;
  successUrl: string;
  cancelUrl: string;
};

export type CheckoutSession = {
  id: string;
  url: string;
};

/** The provider-agnostic shape a webhook is normalized into. */
export type BillingEvent = {
  id: string;
  type: "subscription.created" | "subscription.updated" | "subscription.canceled" | "unknown";
  /**
   * The provider's id for the subscription this event is about (W1.8).
   *
   * Stored on our row so a later question — "which Stripe subscription is this
   * organization actually being charged on" — has an answer that does not
   * involve searching a dashboard by name.
   */
  providerSubscriptionId: string | null;
  organizationId: string | null;
  planKey: PlanKey | null;
  status: "trialing" | "active" | "past_due" | "canceled" | "incomplete" | null;
  currentPeriodEnd: Date | null;
  raw: unknown;
};

export interface BillingProvider {
  readonly key: BillingProviderKey;
  /** Currencies this provider is responsible for. */
  readonly currencies: readonly string[];

  /**
   * Whether credentials are present. Never throws — callers use this to decide
   * whether to offer a payment path at all, rather than discovering the gap
   * mid-checkout.
   */
  isConfigured(): boolean;

  ensureCustomer(input: {
    organizationId: string;
    name: string;
    email?: string;
  }): Promise<BillingCustomer>;

  createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession>;

  /** Verifies the signature and normalizes the payload. */
  parseWebhook(payload: string, signature: string): Promise<BillingEvent>;
}

export class BillingNotConfiguredError extends Error {
  readonly provider: BillingProviderKey;

  constructor(provider: BillingProviderKey) {
    super(`Billing provider "${provider}" is not configured.`);
    this.name = "BillingNotConfiguredError";
    this.provider = provider;
  }
}

/**
 * Thrown by anything that would move money. Phase 0 is explicitly skeleton
 * only, and a stub that silently pretended to succeed would be far worse than
 * one that refuses.
 */
export class BillingNotImplementedError extends Error {
  readonly provider: BillingProviderKey;
  readonly operation: string;

  constructor(provider: BillingProviderKey, operation: string) {
    super(`${provider}.${operation}() is not implemented in Phase 0 — billing is skeleton only.`);
    this.name = "BillingNotImplementedError";
    this.provider = provider;
    this.operation = operation;
  }
}
