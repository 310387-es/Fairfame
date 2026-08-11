import { count, eq } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";
import { PLAN_CATALOG, type PlanKey } from "../lib/plans.ts";
import type { BillingInterval } from "./lookup-keys.ts";
import { providerForCurrency } from "./registry.ts";
import { assignPlan } from "./subscriptions.ts";
import { BillingNotConfiguredError, type BillingEvent } from "./types.ts";

/**
 * Taking money, and what happens after (W1.8).
 *
 * **The rule this file is built around: money and access are separate
 * mechanisms.** `assignPlan` changes what an organization can do and has never
 * needed a payment provider; this adds a way for a customer to *ask* to be on a
 * plan and pay for it. A billing outage must never close an account, and a
 * provider that is not configured must produce a clear refusal rather than a
 * dead button — which is why `canCheckout` exists and the screen asks it before
 * offering anything.
 *
 * Routing is by currency, in `registry.ts`: Türkiye is billed in TRY through
 * iyzico for e-fatura, and everything else goes through Stripe. That is a legal
 * constraint rather than a preference, and it means a Turkish organization
 * cannot check out until the iyzico adapter is built — reported honestly rather
 * than papered over by sending them to Stripe in the wrong currency.
 */

const log = childLogger({ module: "billing/checkout" });

export type CheckoutOutcome =
  | { ok: true; url: string }
  | { ok: false; reason: "not_configured" | "no_provider" | "not_purchasable" | "failed" };

/**
 * Can this organization actually pay us today?
 *
 * Asked by the plan screen *before* it renders an upgrade button, so a customer
 * never meets a control that cannot work. Never throws: an unconfigured
 * deployment is the normal state of this repository, not an error.
 */
export function canCheckout(currency: string): boolean {
  const provider = providerForCurrency(currency);
  return provider !== null && provider.isConfigured();
}

/** Whether a plan is something a customer can buy without talking to anyone. */
export function isPurchasable(planKey: PlanKey): boolean {
  return PLAN_CATALOG[planKey].priceMonth !== null;
}

/**
 * Locations this organization must pay extra for, counted here and nowhere else.
 *
 * **Server-side by construction.** The number never crosses a wire from a
 * screen: a request that could name its own quantity could name `0`, and a
 * fifty-branch chain would check out at the one-branch price. It is read from
 * the same `locations` table the entitlement layer counts, so the figure a
 * customer is billed for is the figure the product enforces against.
 *
 * Floored at zero — an organization inside its allowance buys no add-on, and a
 * negative quantity is not a discount.
 *
 * `getAdminDb` rather than a tenant transaction because checkout runs outside a
 * request's tenant context, and the organization id is the one this function was
 * called about rather than anything a caller chose.
 */
async function extraLocationsFor(organizationId: string, planKey: PlanKey): Promise<number> {
  const included = PLAN_CATALOG[planKey].includedLocations;

  const [row] = await getAdminDb()
    .select({ value: count() })
    .from(schema.locations)
    .where(eq(schema.locations.organizationId, organizationId));

  return Math.max(0, (row?.value ?? 0) - included);
}

/**
 * Starts a hosted checkout for one organization and plan.
 *
 * The customer record is created once and remembered on the organization, so a
 * business that cancels and comes back is the same customer with one invoice
 * history rather than two.
 */
export async function startCheckout(input: {
  organizationId: string;
  planKey: PlanKey;
  /** Monthly unless asked otherwise. */
  interval?: BillingInterval;
  successUrl: string;
  cancelUrl: string;
}): Promise<CheckoutOutcome> {
  if (!isPurchasable(input.planKey)) return { ok: false, reason: "not_purchasable" };

  const [organization] = await getAdminDb()
    .select({
      name: schema.organizations.name,
      currency: schema.organizations.currency,
      billingProvider: schema.organizations.billingProvider,
      billingCustomerId: schema.organizations.billingCustomerId,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, input.organizationId))
    .limit(1);

  if (!organization) return { ok: false, reason: "failed" };

  const provider = providerForCurrency(organization.currency);
  if (!provider) return { ok: false, reason: "no_provider" };
  if (!provider.isConfigured()) return { ok: false, reason: "not_configured" };

  try {
    // Reuse the stored customer only when the *same* provider minted it: an id
    // from iyzico handed to Stripe is not a near-miss, it is a 404 at best and
    // somebody else's customer at worst.
    let customerId =
      organization.billingProvider === provider.key
        ? (organization.billingCustomerId ?? undefined)
        : undefined;

    if (!customerId) {
      const customer = await provider.ensureCustomer({
        organizationId: input.organizationId,
        name: organization.name,
      });
      customerId = customer.providerId;

      await getAdminDb()
        .update(schema.organizations)
        .set({ billingProvider: provider.key, billingCustomerId: customerId })
        .where(eq(schema.organizations.id, input.organizationId));
    }

    const session = await provider.createCheckoutSession({
      organizationId: input.organizationId,
      planKey: input.planKey,
      currency: organization.currency,
      ...(input.interval ? { interval: input.interval } : {}),
      extraLocations: await extraLocationsFor(input.organizationId, input.planKey),
      customerId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });

    return { ok: true, url: session.url };
  } catch (error) {
    if (error instanceof BillingNotConfiguredError) return { ok: false, reason: "not_configured" };

    log.error({ err: error, organizationId: input.organizationId }, "Checkout failed to start");
    return { ok: false, reason: "failed" };
  }
}

/**
 * Applies a verified billing event.
 *
 * **Deliberately narrow.** It moves a subscription's plan, status and period
 * end, and it does nothing else — no side effects, no mail, no provisioning.
 * Everything downstream already reads entitlements from the subscription, so
 * this one write is the whole integration.
 *
 * An event we cannot attribute to an organization is dropped rather than
 * guessed at: `organizationId` comes from metadata we set ourselves on the
 * subscription, so its absence means the subscription was created outside this
 * flow — by hand in a dashboard, most likely — and applying it to whichever
 * organization looked closest would be worse than ignoring it.
 */
export async function applyBillingEvent(event: BillingEvent): Promise<"applied" | "ignored"> {
  if (event.type === "unknown" || !event.organizationId) return "ignored";

  const status = event.type === "subscription.canceled" ? "canceled" : (event.status ?? "active");

  /**
   * A cancellation keeps the plan and only moves the status.
   *
   * `src/lib/entitlements.ts` decides what a cancelled subscription still
   * grants — a lapsed account keeps its published pages, per P3-T7 — and it
   * needs to know *which* plan it was. So a cancellation reads the current plan
   * back rather than inventing one; without a subscription there is nothing to
   * cancel and the event is dropped.
   */
  const planKey = event.planKey ?? (await currentPlanKey(event.organizationId));
  if (!planKey) return "ignored";

  await assignPlan({
    organizationId: event.organizationId,
    planKey,
    status,
    currentPeriodEnd: event.currentPeriodEnd,
    providerRef: event.providerSubscriptionId,
  });

  log.info(
    { organizationId: event.organizationId, planKey, status, eventId: event.id },
    "Billing event applied",
  );

  return "applied";
}

/** The plan an organization is on now, or null when it has no subscription. */
async function currentPlanKey(organizationId: string): Promise<PlanKey | null> {
  const [row] = await getAdminDb()
    .select({ key: schema.plans.key })
    .from(schema.subscriptions)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
    .where(eq(schema.subscriptions.organizationId, organizationId))
    .limit(1);

  return (row?.key as PlanKey | undefined) ?? null;
}
