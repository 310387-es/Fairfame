// Type-only: erased at compile time, so importing the type here does not pull
// the SDK into any bundle. The dynamic import below is the only real load.
import type Stripe from "stripe";
import { PLAN_CATALOG, PLAN_KEYS, type PlanKey } from "../lib/plans.ts";
import { billingSecret } from "./credentials.ts";
import {
  catalogAmount,
  priceLookupKey,
  type BillingInterval,
  type PriceKind,
} from "./lookup-keys.ts";
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
 * **Prices are pre-created Stripe objects, found by lookup key** (11 Aug 2026).
 * This used inline `price_data`, on the argument that one source of truth beats
 * a dashboard that can drift. The argument was right about drift and wrong about
 * the cost: an inline `product_data` makes Stripe mint a **new Product per
 * checkout session**, so the dashboard fills with duplicates and revenue
 * reporting — which groups by product — stops meaning anything.
 *
 * `PLAN_CATALOG` is still the source of truth. `pnpm stripe:sync` pushes it into
 * Stripe and **fails loudly** when the two disagree, so drift is caught by a
 * command somebody runs rather than by a customer's invoice.
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

/**
 * The Stripe Price id behind a catalog entry.
 *
 * ## This is also where a money bug was closed
 *
 * The inline version charged `unit_amount: plan.priceMonth` in
 * `request.currency` — and `PLAN_CATALOG` is **USD cents by decision** (see its
 * header). So an organization whose `currency` was TRY was charged
 * `22900` *lira units*: **₺229 instead of roughly ₺8,000**, silently, with a
 * correct-looking invoice. Looking the price up removes the possibility: a
 * price object carries its own currency, and there is nothing left for a caller
 * to get wrong.
 *
 * The catalog is USD-only on purpose — the provider presents local currency at
 * charge time rather than the product maintaining a second price list. If a
 * genuine second currency is ever wanted, it is `currency_options` on these
 * prices, not an amount reinterpreted at checkout.
 *
 * A missing price is a **loud** failure. The alternative — falling back to
 * inline `price_data` — would restore the duplicate-product problem and hide
 * the fact that `pnpm stripe:sync` has not been run against this account.
 */
async function priceIdFor(
  client: Stripe,
  planKey: PlanKey,
  interval: BillingInterval,
  kind: PriceKind = "base",
): Promise<string> {
  const lookupKey = priceLookupKey(planKey, interval, kind);

  const found = await client.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const price = found.data[0];

  if (!price) {
    throw new BillingNotImplementedError(
      "stripe",
      `price "${lookupKey}" (create it with \`pnpm stripe:sync --apply\`)`,
    );
  }

  return price.id;
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
    const interval = request.interval ?? "month";

    if (catalogAmount(request.planKey, interval) === null) {
      // Agency is quoted per deal — there is no price to charge, and inventing
      // one would be the worst possible way to find that out.
      throw new BillingNotImplementedError("stripe", `checkout for the ${plan.key} plan`);
    }

    const client = await getClient();

    /**
     * Prices are **looked up, not built inline** (11 Aug 2026).
     *
     * This used `price_data` with an inline `product_data: { name }`, which
     * reads as harmless and is not: Stripe mints a **new Product and Price for
     * every session** created that way. The archived "Revira Pro" in the sandbox
     * was not made by hand — a single checkout made it. At any volume the
     * dashboard fills with identical products and Stripe's revenue reporting,
     * which groups by product, stops meaning anything.
     *
     * `scripts/stripe-sync.mts` owns creating them and refuses to run if the
     * catalog and Stripe disagree, so the drift that inline pricing existed to
     * avoid is caught by a command rather than by a customer's invoice.
     */
    const lineItems = [{ price: await priceIdFor(client, request.planKey, interval), quantity: 1 }];

    /**
     * The per-location add-on, when the organization is over its allowance.
     *
     * `extraLocations` is computed by `startCheckout` from the live location
     * count — it is never taken from the caller, because a caller that could
     * send `0` could buy a fifty-branch chain at the one-branch price.
     */
    if (request.extraLocations && request.extraLocations > 0) {
      const extra = catalogAmount(request.planKey, interval, "extra_location");

      // A plan with no add-on price does not sell extra locations at all; the
      // ceiling is `max_locations`, which the entitlement layer already holds.
      if (extra !== null) {
        lineItems.push({
          price: await priceIdFor(client, request.planKey, interval, "extra_location"),
          quantity: request.extraLocations,
        });
      }
    }

    const session = await client.checkout.sessions.create({
      mode: "subscription",
      client_reference_id: request.organizationId,
      ...(request.customerId ? { customer: request.customerId } : {}),
      line_items: lineItems,
      // On the *subscription*, not just the session: the session is gone in an
      // hour and every webhook afterwards is about the subscription. Without
      // this, a `subscription.updated` six months from now has no way home.
      subscription_data: {
        metadata: {
          organizationId: request.organizationId,
          planKey: request.planKey,
          interval,
        },
      },
      metadata: { organizationId: request.organizationId, planKey: request.planKey, interval },
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
