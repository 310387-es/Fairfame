import { eq } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";
import { DEFAULT_PLAN_KEY, TRIAL_DAYS } from "./plans.ts";

/**
 * Gives a newly created organization its 14-day trial.
 *
 * Runs from BetterAuth's afterCreateOrganization hook, which fires before any
 * tenant context exists, so it uses the owner connection. It is the only
 * writer of that first subscription row.
 *
 * The subscription points at the *default* plan — the tier the organization
 * lands on when the trial lapses. Trial entitlements are not stored: they are
 * derived by resolveEntitlements() from `status = 'trialing'` and a live
 * `current_period_end`. That way an expired trial downgrades automatically,
 * with no scheduled job required to flip anything.
 */
export async function provisionTrialSubscription(
  organizationId: string,
  now = new Date(),
): Promise<{ created: boolean }> {
  const existing = await getAdminDb()
    .select({ id: schema.subscriptions.id })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.organizationId, organizationId))
    .limit(1);

  if (existing.length > 0) return { created: false };

  const [plan] = await getAdminDb()
    .select({ id: schema.plans.id })
    .from(schema.plans)
    .where(eq(schema.plans.key, DEFAULT_PLAN_KEY))
    .limit(1);

  if (!plan) {
    throw new Error(
      `Cannot provision a trial: plan "${DEFAULT_PLAN_KEY}" is missing. Run \`pnpm db:seed\`.`,
    );
  }

  const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  await getAdminDb().insert(schema.subscriptions).values({
    organizationId,
    planId: plan.id,
    status: "trialing",
    currentPeriodEnd: trialEndsAt,
  });

  await getAdminDb()
    .update(schema.organizations)
    .set({ planId: plan.id, updatedAt: now })
    .where(eq(schema.organizations.id, organizationId));

  return { created: true };
}
