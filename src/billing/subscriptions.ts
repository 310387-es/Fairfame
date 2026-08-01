import { eq } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";
import { getEntitlements, type ResolvedEntitlements } from "../lib/entitlements.ts";
import { childLogger } from "../lib/logger.ts";
import { PLAN_KEYS, type PlanKey } from "../lib/plans.ts";

/**
 * Moving an organization between plans.
 *
 * This is the part of billing that must work in Phase 0, and it works without
 * any payment provider: entitlements come from the subscription's plan, so
 * assigning a plan is what changes capability. A provider webhook will
 * eventually call this same function — it is not a separate path.
 *
 * Uses the owner connection because plan changes originate outside a user
 * request (a webhook, an admin action, a trial expiring) where no tenant
 * context exists.
 */

const log = childLogger({ module: "billing/subscriptions" });

export type SubscriptionStatus = (typeof schema.subscriptionStatusEnum.enumValues)[number];

export type AssignPlanInput = {
  organizationId: string;
  planKey: PlanKey;
  status?: SubscriptionStatus;
  currentPeriodEnd?: Date | null;
  /** The provider's subscription id, once there is one. */
  providerRef?: string | null;
  /** Who or what made the change, for the audit trail. */
  actorUserId?: string | null;
};

export type AssignPlanResult = {
  planKey: PlanKey;
  status: SubscriptionStatus;
  entitlements: ResolvedEntitlements;
};

export async function assignPlan(input: AssignPlanInput): Promise<AssignPlanResult> {
  const db = getAdminDb();
  const status = input.status ?? "active";

  // Checked before the query: `plans.key` is a Postgres enum, so an unknown
  // value (a malformed webhook, say) would otherwise surface as an opaque
  // driver error rather than a statement about the plan.
  if (!(PLAN_KEYS as readonly string[]).includes(input.planKey)) {
    throw new Error(`Unknown plan "${input.planKey}". Run \`pnpm db:seed\`.`);
  }

  const [plan] = await db
    .select({ id: schema.plans.id, key: schema.plans.key })
    .from(schema.plans)
    .where(eq(schema.plans.key, input.planKey))
    .limit(1);

  if (!plan) {
    throw new Error(`Unknown plan "${input.planKey}". Run \`pnpm db:seed\`.`);
  }

  const [existing] = await db
    .select({ id: schema.subscriptions.id, planId: schema.subscriptions.planId })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.organizationId, input.organizationId))
    .limit(1);

  if (existing) {
    await db
      .update(schema.subscriptions)
      .set({
        planId: plan.id,
        status,
        currentPeriodEnd: input.currentPeriodEnd ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.subscriptions.id, existing.id));
  } else {
    await db.insert(schema.subscriptions).values({
      organizationId: input.organizationId,
      planId: plan.id,
      status,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
    });
  }

  // Keep the denormalized pointer on the organization in step.
  await db
    .update(schema.organizations)
    .set({ planId: plan.id, updatedAt: new Date() })
    .where(eq(schema.organizations.id, input.organizationId));

  // A plan change alters what an account may do and what it will be charged,
  // so it is always recorded — including when a webhook is the actor.
  await db.insert(schema.auditLogs).values({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? null,
    action: "subscription.plan_assigned",
    entity: `subscription:${input.organizationId}`,
    meta: { planKey: input.planKey, status, providerRef: input.providerRef ?? null },
  });

  const entitlements = await getEntitlements(input.organizationId);

  log.info(
    {
      organizationId: input.organizationId,
      planKey: input.planKey,
      status,
      effectivePlanKey: entitlements.effectivePlanKey,
    },
    "Plan assigned",
  );

  return { planKey: input.planKey, status, entitlements };
}

/** Cancels a subscription, dropping the organization to the default plan. */
export async function cancelSubscription(
  organizationId: string,
  actorUserId?: string | null,
): Promise<ResolvedEntitlements> {
  const db = getAdminDb();

  await db
    .update(schema.subscriptions)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(eq(schema.subscriptions.organizationId, organizationId));

  await db.insert(schema.auditLogs).values({
    organizationId,
    actorUserId: actorUserId ?? null,
    action: "subscription.canceled",
    entity: `subscription:${organizationId}`,
    meta: {},
  });

  return getEntitlements(organizationId);
}
