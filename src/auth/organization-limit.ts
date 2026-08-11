import { and, eq } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";
import { PLAN_CATALOG, DEFAULT_PLAN_KEY, type PlanKey } from "../lib/plans.ts";

/**
 * How many workspaces one person may own (11 Aug 2026).
 *
 * ## The gap this closes
 *
 * `/create-organization` called BetterAuth's `organization.create` **straight
 * from the browser**. No server action stood between, so no entitlement check
 * ever ran — the only cap was `organizationLimit: 20` in `src/auth/config.ts`,
 * whose own comment calls it a backstop against runaway creation rather than a
 * plan rule.
 *
 * Every organization gets a fresh 14-day **top-tier** trial from
 * `afterCreateOrganization`. So one account could mint twenty workspaces and
 * twenty full-feature trials — 280 trial-days, no card, no check — against a
 * business model that prices the trial explicitly to *bound* AI and SMS cost
 * (`docs/05` §2.1).
 *
 * ## Why this is not `withinLimit`
 *
 * Every other limit in the catalog is a property of an **organization** and is
 * counted inside that organization's tenant: branches, seats, widgets.
 * `withinLimit` is built for exactly that — it resolves one organization's plan
 * and counts rows under RLS.
 *
 * This one is a property of a **user**. "How many workspaces have you created"
 * has no tenant to be asked in, and the person asking may be about to create
 * their first, when there is no organization at all. Routing it through
 * `withinLimit` would have returned a confident, meaningless number — the
 * usage-counter fallback answers `0` for any metric nobody records, so the
 * check would have passed forever while looking enforced. `withinLimit` now
 * throws if handed this key, so the wrong shape fails loudly instead.
 *
 * ## Two decisions worth stating
 *
 * **Ownership, not membership.** Only organizations where this person is
 * `owner` count. Being invited into somebody else's workspace must never eat
 * your own allowance — an agency's client inviting their accountant would
 * otherwise consume the accountant's.
 *
 * **The most generous plan among them wins.** Somebody who owns a Starter café
 * and an Agency account is an Agency customer; letting the cheaper subscription
 * decide would mean paying for the top tier and being refused by the bottom
 * one. It is not a loophole either — the generous allowance is one they are
 * paying for, and it disappears when that subscription does.
 *
 * The first organization is always allowed. There is nothing to resolve a plan
 * from, and refusing it would mean nobody could ever start.
 *
 * ## The trial does not grant this one, and that is the point
 *
 * **This is the only place in the product that reads a subscription's *own*
 * plan rather than its effective one, so it needs saying plainly.**
 * `resolveEntitlements` upgrades any `trialing` subscription to
 * `TRIAL_PLAN_KEY` — Agency — because the trial exists to show the whole
 * product. Applying that here would make `max_organizations` unlimited for
 * every brand-new account, and since **each new organization mints another
 * 14-day trial**, "unlimited workspaces while trialing" is precisely
 * "unlimited trials". The rule would grant the thing it exists to bound.
 *
 * So a trialing account resolves against the plan its subscription actually
 * names, which `provisionTrialSubscription` sets to `DEFAULT_PLAN_KEY`: one
 * workspace. A prospect evaluating the product for two businesses is asked to
 * subscribe before setting up the second, which is the correct order — nobody
 * is paying yet, and the second workspace is the thing being sold.
 *
 * If that ever feels too strict, the lever is `max_organizations` on Starter in
 * the catalog, not a trial exception here.
 */

export type OrganizationAllowance = {
  allowed: boolean;
  /** Null means unlimited. */
  limit: number | null;
  /** Organizations this person already owns. */
  current: number;
  /** Which plan granted the allowance, for the message and the upgrade prompt. */
  planKey: PlanKey | null;
};

/**
 * Organizations this person owns, and the best `max_organizations` among them.
 *
 * `getAdminDb` rather than a tenant transaction, on the same grounds as
 * `resolveActiveOrganization`: "which organizations does this user own" is by
 * definition a cross-organization question, and RLS would answer it with
 * whichever single tenant happened to be in context.
 */
export async function organizationAllowance(userId: string): Promise<OrganizationAllowance> {
  const owned = await getAdminDb()
    .select({ planKey: schema.plans.key, status: schema.subscriptions.status })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.organizationId))
    .leftJoin(
      schema.subscriptions,
      eq(schema.subscriptions.organizationId, schema.organizations.id),
    )
    .leftJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.role, "owner")));

  const current = owned.length;

  // Nothing owned yet: the first workspace is always allowed.
  if (current === 0) return { allowed: true, limit: null, current: 0, planKey: null };

  let best: PlanKey = DEFAULT_PLAN_KEY;
  let bestLimit: number | null =
    PLAN_CATALOG[DEFAULT_PLAN_KEY].entitlements.limits.max_organizations;

  for (const row of owned) {
    /**
     * A lapsed subscription grants nothing, which is the same rule
     * `resolveEntitlements` applies: `canceled` and `incomplete` fall to the
     * floor. A workspace whose plan has ended still *counts* against the
     * allowance — it exists and holds data — but it stops *granting* one.
     *
     * `trialing` is usable and resolves against **`row.planKey`**, not
     * `TRIAL_PLAN_KEY`. That divergence from `resolveEntitlements` is the whole
     * point and is argued at the top of this file: a trial that granted
     * unlimited workspaces would grant unlimited trials.
     */
    const usable =
      row.status === "trialing" || row.status === "active" || row.status === "past_due";
    const key =
      usable && row.planKey && row.planKey in PLAN_CATALOG
        ? (row.planKey as PlanKey)
        : DEFAULT_PLAN_KEY;

    const limit = PLAN_CATALOG[key].entitlements.limits.max_organizations;

    // Null is unlimited and beats every number, so it short-circuits.
    if (limit === null) return { allowed: true, limit: null, current, planKey: key };
    if (bestLimit !== null && limit > bestLimit) {
      bestLimit = limit;
      best = key;
    }
  }

  return {
    allowed: bestLimit === null || current < bestLimit,
    limit: bestLimit,
    current,
    planKey: best,
  };
}
