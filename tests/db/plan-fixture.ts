import { eq } from "drizzle-orm";
import { getAdminDb, schema } from "@/db/client";
import { PLAN_CATALOG, type FeatureKey } from "@/lib/plans";

/**
 * Puts a test organization on a plan that includes the features it needs.
 *
 * An organization with no subscription falls back to `DEFAULT_PLAN_KEY`, and
 * that floor deliberately excludes the team-workflow features (P2-T8). So a
 * suite exercising bulk actions or saved views has to say which plan it is on,
 * the same way a real account does — otherwise it is testing the entitlement
 * gate by accident and calling it a failure.
 *
 * The plan is *found* by asking the catalog for one that includes everything
 * requested, never named. Naming a tier here would mean editing every suite the
 * day packaging moves, which is exactly what putting entitlements in config was
 * supposed to prevent.
 */
export async function subscribeToPlanWith(
  organizationId: string,
  features: FeatureKey[],
): Promise<void> {
  const entry = Object.values(PLAN_CATALOG).find((plan) =>
    features.every((feature) => plan.entitlements.features[feature]),
  );

  if (!entry) {
    throw new Error(`No plan in the catalog includes all of: ${features.join(", ")}`);
  }

  const [plan] = await getAdminDb()
    .select({ id: schema.plans.id })
    .from(schema.plans)
    .where(eq(schema.plans.key, entry.key));

  if (!plan) throw new Error(`Plan "${entry.key}" is not seeded; run pnpm db:seed.`);

  await getAdminDb()
    .insert(schema.subscriptions)
    .values({ organizationId, planId: plan.id, status: "active" });
}
