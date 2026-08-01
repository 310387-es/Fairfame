/**
 * Seeds the plan catalog and a demo organization.
 *
 *   pnpm db:seed
 *
 * Idempotent: plans upsert on their unique `key` and the demo org upserts on
 * its unique `slug`, so re-running converges rather than duplicating. Editing
 * PLAN_CATALOG and re-seeding is the supported way to change packaging.
 *
 * Users and memberships are deliberately NOT seeded — BetterAuth owns user
 * creation from T5, and hand-rolling rows here would fight its schema.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getEnv } from "../src/lib/env.ts";
import * as schema from "../src/db/schema.ts";
import { PLAN_CATALOG, PLAN_KEYS } from "../src/lib/plans.ts";

const DEMO_ORG = {
  name: "Demo İşletme",
  slug: "demo",
  locale: "tr",
  currency: "TRY",
} as const;

const DEMO_LOCATIONS = [
  { name: "Kadıköy Şubesi", address: "Caferağa Mah., Kadıköy, İstanbul", category: "restaurant" },
  {
    name: "Beşiktaş Şubesi",
    address: "Sinanpaşa Mah., Beşiktaş, İstanbul",
    category: "restaurant",
  },
] as const;

const pool = new Pool({ connectionString: getEnv().DATABASE_URL, max: 1 });
const db = drizzle(pool, { schema });

try {
  // --- Plans -------------------------------------------------------------
  for (const key of PLAN_KEYS) {
    const plan = PLAN_CATALOG[key];
    await db
      .insert(schema.plans)
      .values({
        key: plan.key,
        name: plan.name,
        priceMonth: plan.priceMonth,
        currency: plan.currency,
        interval: plan.interval,
        entitlements: plan.entitlements,
      })
      .onConflictDoUpdate({
        target: schema.plans.key,
        set: {
          name: plan.name,
          priceMonth: plan.priceMonth,
          currency: plan.currency,
          interval: plan.interval,
          entitlements: plan.entitlements,
          updatedAt: new Date(),
        },
      });
  }
  console.log(`Seeded ${PLAN_KEYS.length} plans: ${PLAN_KEYS.join(", ")}`);

  // --- Demo organization -------------------------------------------------
  const starter = await db.query.plans.findFirst({
    where: eq(schema.plans.key, "starter"),
  });
  if (!starter) throw new Error("Starter plan missing after seeding plans.");

  const [org] = await db
    .insert(schema.organizations)
    .values({ ...DEMO_ORG, planId: starter.id })
    .onConflictDoUpdate({
      target: schema.organizations.slug,
      set: { name: DEMO_ORG.name, planId: starter.id, updatedAt: new Date() },
    })
    .returning();
  if (!org) throw new Error("Demo organization upsert returned no row.");
  console.log(`Seeded organization "${org.name}" (${org.slug}) → plan ${starter.key}`);

  // --- Demo locations ----------------------------------------------------
  // No natural unique key on locations, so match on (organization_id, name).
  for (const location of DEMO_LOCATIONS) {
    const existing = await db.query.locations.findFirst({
      where: (table, { and, eq: equals }) =>
        and(equals(table.organizationId, org.id), equals(table.name, location.name)),
    });

    if (existing) {
      await db
        .update(schema.locations)
        .set({ ...location, updatedAt: new Date() })
        .where(eq(schema.locations.id, existing.id));
    } else {
      await db
        .insert(schema.locations)
        .values({ ...location, organizationId: org.id, locale: DEMO_ORG.locale });
    }
  }
  console.log(`Seeded ${DEMO_LOCATIONS.length} demo locations.`);

  console.log("\nSeed complete.");
} catch (error) {
  console.error("Seed failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
