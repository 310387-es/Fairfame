import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import {
  can,
  EntitlementError,
  recordUsage,
  requireFeature,
  requireWithinLimit,
  withinLimit,
} from "@/lib/entitlements";
import { PLAN_CATALOG, TRIAL_DAYS } from "@/lib/plans";
import { provisionTrialSubscription } from "@/lib/provisioning";
import { withTenant } from "@/lib/tenancy";

/**
 * Entitlements enforced against a real database, through the RLS-bound role.
 *
 * The point being proven is that gating follows plan *configuration*: the same
 * code path returns a different answer when only the subscription's plan row
 * changes.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const createdOrgIds: string[] = [];

async function planId(key: keyof typeof PLAN_CATALOG): Promise<string> {
  const [plan] = await getAdminDb()
    .select({ id: schema.plans.id })
    .from(schema.plans)
    .where(eq(schema.plans.key, key))
    .limit(1);
  if (!plan) throw new Error(`plan ${key} missing — run pnpm db:seed`);
  return plan.id;
}

async function createOrgOn(
  key: keyof typeof PLAN_CATALOG,
  options: {
    status?: "trialing" | "active" | "past_due" | "canceled";
    currentPeriodEnd?: Date | null;
    overrides?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Ent ${key} ${suffix}`, slug: `ent-${key}-${suffix}-${createdOrgIds.length}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  createdOrgIds.push(org.id);

  await getAdminDb()
    .insert(schema.subscriptions)
    .values({
      organizationId: org.id,
      planId: await planId(key),
      status: options.status ?? "active",
      currentPeriodEnd: options.currentPeriodEnd ?? new Date(Date.now() + 86_400_000),
      overrides: options.overrides ?? {},
    });

  return org.id;
}

/** Real rows, because the resolver counts locations rather than being told a number. */
async function addLocations(organizationId: string, howMany: number): Promise<void> {
  await getAdminDb()
    .insert(schema.locations)
    .values(
      Array.from({ length: howMany }, (_unused, index) => ({
        organizationId,
        name: `Branch ${index + 1} ${suffix}`,
      })),
    );
}

let starterOrg: string;
let proOrg: string;

beforeAll(async () => {
  starterOrg = await createOrgOn("starter");
  proOrg = await createOrgOn("pro");
});

afterAll(async () => {
  await getAdminDb()
    .delete(schema.organizations)
    .where(inArray(schema.organizations.id, createdOrgIds));
  await closeDatabasePools();
});

describe("can()", () => {
  it("denies a feature the plan excludes", async () => {
    expect(await can(starterOrg, "social_sources")).toBe(false);
    expect(await can(starterOrg, "api_access")).toBe(false);
  });

  it("allows a feature the plan includes", async () => {
    expect(await can(starterOrg, "ai_replies")).toBe(true);
    expect(await can(proOrg, "api_access")).toBe(true);
  });

  it("reserves white-label for Agency", async () => {
    expect(await can(proOrg, "white_label")).toBe(false);
  });

  it("changes answer when only the plan changes — config, not code", async () => {
    // Same organization, same call, same code. Only the subscription's plan row
    // moves. This is the entire point of the primitive.
    expect(await can(starterOrg, "social_sources")).toBe(false);

    await getAdminDb()
      .update(schema.subscriptions)
      .set({ planId: await planId("growth") })
      .where(eq(schema.subscriptions.organizationId, starterOrg));

    expect(await can(starterOrg, "social_sources")).toBe(true);

    await getAdminDb()
      .update(schema.subscriptions)
      .set({ planId: await planId("starter") })
      .where(eq(schema.subscriptions.organizationId, starterOrg));

    expect(await can(starterOrg, "social_sources")).toBe(false);
  });

  it("honours a per-organization override without touching the plan", async () => {
    const org = await createOrgOn("starter", {
      overrides: { features: { social_sources: true } },
    });

    expect(await can(org, "social_sources")).toBe(true);
    // The plan itself is untouched for everyone else.
    expect(await can(starterOrg, "social_sources")).toBe(false);
  });
});

describe("withinLimit()", () => {
  it("counts real rows for a resource limit", async () => {
    const check = await withinLimit(starterOrg, "max_locations");

    expect(check.limit).toBe(PLAN_CATALOG.starter.entitlements.limits.max_locations);
    expect(check.current).toBe(0);
    expect(check.allowed).toBe(true);
  });

  it("denies once the resource limit is reached", async () => {
    // Starter allows exactly one location.
    await withTenant({ organizationId: starterOrg }, (tx) =>
      tx.insert(schema.locations).values({ organizationId: starterOrg, name: "First" }),
    );

    const check = await withinLimit(starterOrg, "max_locations");
    expect(check.current).toBe(1);
    expect(check.allowed).toBe(false);
    expect(check.remaining).toBe(0);
  });

  it("treats null as unlimited, never as zero", async () => {
    const agencyOrg = await createOrgOn("agency");
    const check = await withinLimit(agencyOrg, "max_locations");

    expect(check.limit).toBeNull();
    expect(check.remaining).toBeNull();
    expect(check.allowed).toBe(true);
  });

  it("measures metered usage from the usage counters", async () => {
    const org = await createOrgOn("growth");

    const before = await withinLimit(org, "sms_credits");
    expect(before.current).toBe(0);
    expect(before.limit).toBe(PLAN_CATALOG.growth.entitlements.metered.sms_credits);

    await recordUsage(org, "sms_credits", 10);

    const after = await withinLimit(org, "sms_credits");
    expect(after.current).toBe(10);
    expect(after.allowed).toBe(true);
  });

  it("accumulates repeated usage rather than overwriting it", async () => {
    const org = await createOrgOn("growth");

    await recordUsage(org, "sms_credits", 5);
    await recordUsage(org, "sms_credits", 7);

    const check = await withinLimit(org, "sms_credits");
    expect(check.current).toBe(12);
  });

  it("denies once the metered allowance is exhausted", async () => {
    const org = await createOrgOn("starter"); // starter sms_credits = 0

    const check = await withinLimit(org, "sms_credits");
    expect(check.limit).toBe(0);
    expect(check.allowed).toBe(false);
  });

  it("respects the requested quantity, not just one more", async () => {
    const org = await createOrgOn("growth");
    // Measured back from whatever the plan grants, so a repricing moves this
    // test with it rather than turning it red.
    const { limit } = await withinLimit(org, "sms_credits", { additional: 0 });
    if (limit === null) throw new Error("expected a finite sms allowance");
    await recordUsage(org, "sms_credits", limit - 5);

    expect((await withinLimit(org, "sms_credits", { additional: 5 })).allowed).toBe(true);
    expect((await withinLimit(org, "sms_credits", { additional: 6 })).allowed).toBe(false);
  });
});

/**
 * Per-location quotas, through the database shell (11 Aug 2026 — docs/05 §1–2).
 *
 * `tests/lib/entitlements.test.ts` pins the arithmetic; these pin that the real
 * location count reaches it. A pure function that multiplies correctly is worth
 * nothing if the resolver never counts the branches.
 */
describe("per-location quotas", () => {
  it("multiplies the allowance by the organization's locations", async () => {
    const org = await createOrgOn("growth");
    const perLocation = PLAN_CATALOG.growth.entitlements.metered.sms_credits ?? 0;

    // No branches yet, so the floor of 1 applies and the catalog figure stands.
    expect((await withinLimit(org, "sms_credits", { additional: 0 })).limit).toBe(perLocation);

    await addLocations(org, 3);

    expect((await withinLimit(org, "sms_credits", { additional: 0 })).limit).toBe(perLocation * 3);
  });

  it("leaves the location ceiling absolute, so it cannot raise itself", async () => {
    // The failure this prevents: max_locations scaling with the location count
    // means every new branch raises the cap that was supposed to stop it.
    const org = await createOrgOn("growth");
    await addLocations(org, 3);

    expect((await withinLimit(org, "max_locations", { additional: 0 })).limit).toBe(
      PLAN_CATALOG.growth.entitlements.limits.max_locations,
    );
  });

  it("gives a brand-new organization one location's worth, not nothing", async () => {
    // No locations yet. Flooring at 1 is what stops the very first review
    // request of a new account failing a limit check against zero.
    const org = await createOrgOn("growth");

    const check = await withinLimit(org, "requests_per_month", { additional: 1 });
    expect(check.allowed).toBe(true);
  });

  it("keeps a zero allowance at zero however many branches there are", async () => {
    const org = await createOrgOn("starter");
    await addLocations(org, 3);

    const check = await withinLimit(org, "sms_credits", { additional: 1 });
    expect(check.limit).toBe(0);
    expect(check.allowed).toBe(false);
  });

  it("keeps unlimited unlimited", async () => {
    const org = await createOrgOn("agency");
    await addLocations(org, 5);

    expect((await withinLimit(org, "requests_per_month", { additional: 1 })).limit).toBeNull();
  });
});

describe("trial provisioning", () => {
  it("grants top-tier entitlements for a freshly provisioned organization", async () => {
    const [org] = await getAdminDb()
      .insert(schema.organizations)
      .values({ name: `Trial ${suffix}`, slug: `trial-${suffix}` })
      .returning({ id: schema.organizations.id });
    if (!org) throw new Error("insert returned nothing");
    createdOrgIds.push(org.id);

    const { created } = await provisionTrialSubscription(org.id);
    expect(created).toBe(true);

    // Top tier during the trial, even though the subscription points at Starter.
    expect(await can(org.id, "white_label")).toBe(true);
    expect(await can(org.id, "api_access")).toBe(true);
    expect((await withinLimit(org.id, "max_locations")).limit).toBeNull();

    // It lands on Starter when the trial lapses.
    const [subscription] = await getAdminDb()
      .select({ planId: schema.subscriptions.planId, status: schema.subscriptions.status })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.organizationId, org.id));
    expect(subscription?.status).toBe("trialing");
    expect(subscription?.planId).toBe(await planId("starter"));
  });

  it("is idempotent — a second call does not create another subscription", async () => {
    const [org] = await getAdminDb()
      .insert(schema.organizations)
      .values({ name: `Trial2 ${suffix}`, slug: `trial2-${suffix}` })
      .returning({ id: schema.organizations.id });
    if (!org) throw new Error("insert returned nothing");
    createdOrgIds.push(org.id);

    expect((await provisionTrialSubscription(org.id)).created).toBe(true);
    expect((await provisionTrialSubscription(org.id)).created).toBe(false);

    const rows = await getAdminDb()
      .select({ id: schema.subscriptions.id })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.organizationId, org.id));
    expect(rows).toHaveLength(1);
  });

  it("expires the trial rather than leaving top-tier access", async () => {
    const lapsed = await createOrgOn("starter", {
      status: "trialing",
      currentPeriodEnd: new Date(Date.now() - 86_400_000),
    });

    expect(await can(lapsed, "white_label")).toBe(false);
    expect((await withinLimit(lapsed, "max_locations")).limit).toBe(1);
  });

  it("sets the trial period to the configured length", async () => {
    const [org] = await getAdminDb()
      .insert(schema.organizations)
      .values({ name: `Trial3 ${suffix}`, slug: `trial3-${suffix}` })
      .returning({ id: schema.organizations.id });
    if (!org) throw new Error("insert returned nothing");
    createdOrgIds.push(org.id);

    const now = new Date("2026-08-01T00:00:00Z");
    await provisionTrialSubscription(org.id, now);

    const [subscription] = await getAdminDb()
      .select({ end: schema.subscriptions.currentPeriodEnd })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.organizationId, org.id));

    const days = (subscription!.end!.getTime() - now.getTime()) / 86_400_000;
    expect(days).toBe(TRIAL_DAYS);
  });
});

describe("guards", () => {
  it("requireFeature throws with the offending key attached", async () => {
    await expect(requireFeature(starterOrg, "api_access")).rejects.toThrow(EntitlementError);
    await expect(requireFeature(starterOrg, "api_access")).rejects.toMatchObject({
      key: "api_access",
    });
  });

  it("requireFeature passes for an included feature", async () => {
    await expect(requireFeature(starterOrg, "ai_replies")).resolves.toBeUndefined();
  });

  it("requireWithinLimit reports the current usage in its message", async () => {
    const org = await createOrgOn("starter");
    await withTenant({ organizationId: org }, (tx) =>
      tx.insert(schema.locations).values({ organizationId: org, name: "Only one" }),
    );

    await expect(requireWithinLimit(org, "max_locations")).rejects.toThrow(/max_locations.*1\/1/);
  });
});
