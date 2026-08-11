import { PLAN_CATALOG, type PlanKey } from "../lib/plans.ts";

/**
 * The name a Stripe Price is found by, and the only place that name is built.
 *
 * ## Why lookup keys at all
 *
 * Checkout used to pass `price_data` with an inline `product_data: { name }`,
 * which reads as harmless and is not: **Stripe mints a new Product and Price
 * for every session built that way**. One archived "Revira Pro" in the sandbox
 * is the evidence — it was not created by hand, it was created by a checkout.
 * At any volume the dashboard fills with hundreds of identical products, and
 * Stripe's own revenue reporting — which groups by product — becomes noise.
 *
 * A lookup key is a stable string we choose, so the price is created **once**
 * and found by name forever after. It also survives the thing an id does not:
 * a price is immutable in Stripe, so changing an amount means creating a new
 * price and moving the key to it (`transfer_lookup_key`), which every caller
 * picks up with no deploy.
 *
 * ## Why this is its own module
 *
 * Two things build these strings — the checkout that reads them and
 * `scripts/stripe-sync.mts` that writes them — and if they ever disagreed the
 * symptom would be a checkout that 500s because the price it asked for does not
 * exist. One function, imported by both.
 *
 * Deliberately db-free and dependency-free beyond the catalog, so the script can
 * import it without pulling in a database client.
 */

/** Billing period. The catalog prices both; `interval` decides which is charged. */
export type BillingInterval = "month" | "year";

/**
 * What is being charged for.
 *
 * `base` is the plan itself; `extra_location` is the per-location add-on that
 * the catalog prices separately for Growth, Pro and Agency. They are separate
 * Stripe products rather than one product with two prices, because they are two
 * different things being sold and an invoice should say so.
 */
export type PriceKind = "base" | "extra_location";

/** The catalog's currency, and therefore every price's. See `PLAN_CATALOG`. */
export const CATALOG_CURRENCY = "usd";

export function priceLookupKey(
  planKey: PlanKey,
  interval: BillingInterval,
  kind: PriceKind = "base",
): string {
  const period = interval === "month" ? "monthly" : "yearly";
  return kind === "base"
    ? `fairfame_${planKey}_${period}`
    : `fairfame_${planKey}_extra_location_${period}`;
}

/** The catalog amount a given key is supposed to carry, or null if there is none. */
export function catalogAmount(
  planKey: PlanKey,
  interval: BillingInterval,
  kind: PriceKind = "base",
): number | null {
  const plan = PLAN_CATALOG[planKey];

  if (kind === "base") {
    return interval === "month" ? plan.priceMonth : plan.priceYear;
  }

  return interval === "month" ? plan.priceExtraLocationMonth : plan.priceExtraLocationYear;
}

/**
 * Every price the catalog implies, as the sync script's worklist.
 *
 * Derived from `PLAN_CATALOG` rather than written out, so adding a plan or
 * pricing an add-on that was previously `null` puts a new row here without
 * anybody remembering to.
 */
export function expectedPrices(): {
  planKey: PlanKey;
  interval: BillingInterval;
  kind: PriceKind;
  lookupKey: string;
  amount: number;
}[] {
  const rows: ReturnType<typeof expectedPrices> = [];

  for (const planKey of Object.keys(PLAN_CATALOG) as PlanKey[]) {
    for (const kind of ["base", "extra_location"] as const) {
      for (const interval of ["month", "year"] as const) {
        const amount = catalogAmount(planKey, interval, kind);
        // Null means "not sold this way" — Agency has no self-serve base price,
        // Starter has no extra-location price. Absent, not zero.
        if (amount === null) continue;

        rows.push({
          planKey,
          interval,
          kind,
          lookupKey: priceLookupKey(planKey, interval, kind),
          amount,
        });
      }
    }
  }

  return rows;
}
