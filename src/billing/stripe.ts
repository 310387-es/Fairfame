// Type-only: erased at compile time, so importing the type here does not pull
// the SDK into any bundle. The dynamic import below is the only real load.
import type Stripe from "stripe";
import { PLAN_CATALOG, PLAN_KEYS } from "../lib/plans.ts";
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
 * **Checkout is wired for real as of W1.8**; what is still gated is having
 * credentials. `isConfigured()` is the only thing between an unconfigured
 * deployment and a payment path, and every method re-checks it rather than
 * trusting a caller to have asked.
 *
 * Prices come from `PLAN_CATALOG` as inline `price_data` rather than from
 * pre-created Stripe Price objects. That is a deliberate trade: it means
 * packaging stays "configuration, not code" in one file, and changing a price
 * does not require somebody to remember to mirror it in a dashboard — where the
 * two would eventually disagree and the customer would be charged the dashboard
 * one. The cost is that Stripe's own price analytics are less useful, which is
 * the cheaper thing to lose.
 *
 * What has *not* changed: assigning a plan still changes an organization's
 * entitlements with no provider involved. Money and access are separate
 * mechanisms, and a payment outage must not close an account.
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
  /**
   * TRY is here as a **fallback**, not as the answer for Türkiye.
   *
   * iyzico remains the preferred Turkish provider — `registry.ts` prefers it
   * the moment it is configured — because e-fatura is a legal obligation for a
   * Turkish business and Stripe does not discharge it. What this line buys is
   * that a Turkish organization can be charged *at all* while that adapter does
   * not exist, rather than meeting a screen that says we cannot take their
   * money.
   *
   * The trade is a real one and it is a business decision, not a technical one:
   * invoicing a Turkish customer through Stripe means handling e-fatura by some
   * other route. Removing TRY here is a one-word change if that turns out to be
   * unacceptable.
   */
  currencies: ["USD", "EUR", "TRY"],

  isConfigured(): boolean {
    return secretKey() !== undefined;
  },

  async ensureCustomer(input): Promise<BillingCustomer> {
    if (!stripeProvider.isConfigured()) throw new BillingNotConfiguredError("stripe");

    const client = await getClient();
    const customer = await client.customers.create(
      {
        name: input.name,
        ...(input.email ? { email: input.email } : {}),
        // Our own id on their record, so a support conversation that starts in
        // the Stripe dashboard can find the organization without a lookup
        // table — and so a webhook has a fallback when the session metadata is
        // missing.
        metadata: { organizationId: input.organizationId },
      },
      // Stripe deduplicates on this key for 24 hours, which covers the case
      // this is actually for: somebody double-clicking Upgrade.
      { idempotencyKey: `customer:${input.organizationId}` },
    );

    return { providerId: customer.id };
  },

  async createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession> {
    if (!stripeProvider.isConfigured()) throw new BillingNotConfiguredError("stripe");

    const plan = PLAN_CATALOG[request.planKey];
    if (plan.priceMonth === null) {
      // Agency is quoted per deal — there is no price to charge, and inventing
      // one would be the worst possible way to find that out.
      throw new BillingNotImplementedError("stripe", `checkout for the ${plan.key} plan`);
    }

    const client = await getClient();

    const session = await client.checkout.sessions.create({
      mode: "subscription",
      client_reference_id: request.organizationId,
      ...(request.customerId ? { customer: request.customerId } : {}),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: request.currency.toLowerCase(),
            unit_amount: plan.priceMonth,
            recurring: { interval: plan.interval },
            product_data: { name: `Fairfame ${plan.name}` },
          },
        },
      ],
      // On the *subscription*, not just the session: the session is gone in an
      // hour and every webhook afterwards is about the subscription. Without
      // this, a `subscription.updated` six months from now has no way home.
      subscription_data: {
        metadata: { organizationId: request.organizationId, planKey: request.planKey },
      },
      metadata: { organizationId: request.organizationId, planKey: request.planKey },
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
    });

    if (!session.url) {
      throw new BillingNotImplementedError("stripe", "checkout session without a URL");
    }

    return { id: session.id, url: session.url };
  },

  async parseWebhook(payload: string, signature: string): Promise<BillingEvent> {
    if (!stripeProvider.isConfigured()) throw new BillingNotConfiguredError("stripe");

    const secret = billingSecret("STRIPE_WEBHOOK_SECRET");
    if (!secret) throw new BillingNotConfiguredError("stripe");

    const client = await getClient();
    // Verification, not parsing. `constructEvent` throws on a bad signature,
    // and that throw is the whole security model of this endpoint: without it
    // anybody who knows the URL can grant themselves a plan.
    const event = client.webhooks.constructEvent(payload, signature, secret);

    return normalizeEvent(event);
  },
};

/** Stripe's event shape → the provider-agnostic one the app acts on. */
function normalizeEvent(event: Stripe.Event): BillingEvent {
  const type =
    event.type === "customer.subscription.created"
      ? ("subscription.created" as const)
      : event.type === "customer.subscription.updated"
        ? ("subscription.updated" as const)
        : event.type === "customer.subscription.deleted"
          ? ("subscription.canceled" as const)
          : ("unknown" as const);

  if (type === "unknown") {
    return {
      id: event.id,
      type,
      providerSubscriptionId: null,
      organizationId: null,
      planKey: null,
      status: null,
      currentPeriodEnd: null,
      raw: event,
    };
  }

  const subscription = event.data.object as Stripe.Subscription;
  const metadata = subscription.metadata ?? {};
  const planKey = PLAN_KEYS.find((key) => key === metadata["planKey"]) ?? null;

  // `current_period_end` moved onto the subscription item in Stripe's 2025
  // API versions; read both so the adapter works either side of that.
  const periodEnd =
    subscription.items?.data[0]?.current_period_end ??
    (subscription as unknown as { current_period_end?: number }).current_period_end ??
    null;

  return {
    id: event.id,
    type,
    providerSubscriptionId: subscription.id,
    organizationId: metadata["organizationId"] ?? null,
    planKey,
    status: normalizeStatus(subscription.status),
    currentPeriodEnd: periodEnd === null ? null : new Date(periodEnd * 1000),
    raw: event,
  };
}

/**
 * Stripe's statuses → ours.
 *
 * `unpaid` maps to `past_due` rather than to `canceled` on purpose: dunning is
 * a grace period, and `src/lib/entitlements.ts` already keeps the paid plan
 * through it. Cutting somebody off the moment a card bounces is how a business
 * loses a customer over an expired card.
 */
function normalizeStatus(status: Stripe.Subscription.Status): BillingEvent["status"] {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "canceled";
    default:
      return "incomplete";
  }
}

/**
 * Exposed for the eventual real implementation and for diagnostics.
 *
 * @public — the Stripe skeleton's seam; unused until billing is built.
 */
export { getClient as getStripeClient };
