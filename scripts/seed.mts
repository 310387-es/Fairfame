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
import { PLAN_CATALOG, PLAN_KEYS, TRIAL_DAYS } from "../src/lib/plans.ts";
import { provisionTrialSubscription } from "../src/lib/provisioning.ts";

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
        priceYear: plan.priceYear,
        currency: plan.currency,
        interval: plan.interval,
        includedLocations: plan.includedLocations,
        priceExtraLocationMonth: plan.priceExtraLocationMonth,
        priceExtraLocationYear: plan.priceExtraLocationYear,
        entitlements: plan.entitlements,
      })
      .onConflictDoUpdate({
        target: schema.plans.key,
        set: {
          name: plan.name,
          priceMonth: plan.priceMonth,
          priceYear: plan.priceYear,
          currency: plan.currency,
          interval: plan.interval,
          includedLocations: plan.includedLocations,
          priceExtraLocationMonth: plan.priceExtraLocationMonth,
          priceExtraLocationYear: plan.priceExtraLocationYear,
          entitlements: plan.entitlements,
          updatedAt: new Date(),
        },
        // `provider_price_id` / `provider_price_id_year` are deliberately not
        // in this set. They belong to the payment provider, and a re-seed that
        // blanked them would leave a plan that renders a price it cannot
        // charge. Migration 0058 leaves them alone for the same reason.
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

  // --- Demo widget -------------------------------------------------------
  //
  // A published widget for the demo org, so the public endpoints have something
  // to answer with in a fresh checkout (P3-T0). It shows nothing until reviews
  // are ingested *and* approved for display, which is the correct empty state
  // rather than a placeholder: the approval gate is the whole point.
  //
  // The key is fixed rather than generated. It is dev-only data in a dev-only
  // database, and a stable key is what lets a demo page, a README snippet and
  // the browser suite all point at the same widget across re-seeds. Real keys
  // are CSPRNG-generated — see src/widgets/keys.ts.
  const DEMO_WIDGET_KEY = "demwdgetkey7q2xr8mnp4vsz";

  await db
    .insert(schema.widgets)
    .values({
      organizationId: org.id,
      name: "Müşteri yorumları",
      publicKey: DEMO_WIDGET_KEY,
      published: true,
    })
    .onConflictDoUpdate({
      target: schema.widgets.publicKey,
      set: { organizationId: org.id, published: true, updatedAt: new Date() },
    });
  console.log(`Seeded demo widget → /embed/w/${DEMO_WIDGET_KEY}`);

  // --- Demo subscription -------------------------------------------------
  // Mirrors what BetterAuth's afterCreateOrganization hook does for real
  // signups, so the demo org resolves entitlements like any other.
  const { created } = await provisionTrialSubscription(org.id);
  console.log(
    created
      ? `Provisioned a ${TRIAL_DAYS}-day trial for "${org.slug}".`
      : `Trial already present for "${org.slug}" — left as is.`,
  );

  console.log("\nSeed complete.");
} catch (error) {
  console.error("Seed failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
