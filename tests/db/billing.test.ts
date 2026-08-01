import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignPlan, cancelSubscription } from "@/billing/subscriptions";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { can, withinLimit } from "@/lib/entitlements";
import { DEFAULT_PLAN_KEY } from "@/lib/plans";

/**
 * The T12 acceptance criterion: assigning a plan to an organization changes
 * its entitlements — with no payment provider involved anywhere.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

async function makeOrg(label: string): Promise<string> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Billing ${label} ${suffix}`, slug: `billing-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);
  return org.id;
}

let orgId: string;

beforeAll(async () => {
  orgId = await makeOrg("main");
});

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("assignPlan", () => {
  it("creates a subscription when none exists and applies that plan's entitlements", async () => {
    const result = await assignPlan({ organizationId: orgId, planKey: "starter" });

    expect(result.status).toBe("active");
    expect(result.entitlements.effectivePlanKey).toBe("starter");
    expect(await can(orgId, "api_access")).toBe(false);
    expect((await withinLimit(orgId, "max_locations")).limit).toBe(1);
  });

  it("upgrading flips the gated features on", async () => {
    await assignPlan({ organizationId: orgId, planKey: "pro" });

    expect(await can(orgId, "api_access")).toBe(true);
    expect(await can(orgId, "benchmarking")).toBe(true);
    expect(await can(orgId, "competitor_watch")).toBe(true);
    expect((await withinLimit(orgId, "max_locations")).limit).toBe(10);
    // Still not Agency.
    expect(await can(orgId, "white_label")).toBe(false);
  });

  it("downgrading flips them back off", async () => {
    await assignPlan({ organizationId: orgId, planKey: "starter" });

    expect(await can(orgId, "api_access")).toBe(false);
    expect(await can(orgId, "benchmarking")).toBe(false);
    expect((await withinLimit(orgId, "max_locations")).limit).toBe(1);
  });

  it("reaches the top tier", async () => {
    await assignPlan({ organizationId: orgId, planKey: "agency" });

    expect(await can(orgId, "white_label")).toBe(true);
    expect((await withinLimit(orgId, "max_locations")).limit).toBeNull();
  });

  it("never creates a second subscription for the same organization", async () => {
    const rows = await getAdminDb()
      .select({ id: schema.subscriptions.id })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.organizationId, orgId));

    expect(rows).toHaveLength(1);
  });

  it("keeps the organization's denormalized plan pointer in step", async () => {
    await assignPlan({ organizationId: orgId, planKey: "growth" });

    const [org] = await getAdminDb()
      .select({ planId: schema.organizations.planId })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
    const [plan] = await getAdminDb()
      .select({ id: schema.plans.id })
      .from(schema.plans)
      .where(eq(schema.plans.key, "growth"));

    expect(org?.planId).toBe(plan?.id);
  });

  it("records every plan change in the audit log", async () => {
    const rows = await getAdminDb()
      .select({ action: schema.auditLogs.action, meta: schema.auditLogs.meta })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, orgId));

    const assignments = rows.filter((row) => row.action === "subscription.plan_assigned");
    expect(assignments.length).toBeGreaterThanOrEqual(5);
    expect(assignments.some((row) => (row.meta as { planKey?: string }).planKey === "pro")).toBe(
      true,
    );
  });

  it("rejects an unknown plan key", async () => {
    await expect(
      // Deliberately bypassing the type to mimic a bad webhook payload.
      assignPlan({ organizationId: orgId, planKey: "enterprise" as "pro" }),
    ).rejects.toThrow(/Unknown plan/);
  });

  it("supports a trial assignment that grants top-tier access", async () => {
    const trialOrg = await makeOrg("trial");
    await assignPlan({
      organizationId: trialOrg,
      planKey: "starter",
      status: "trialing",
      currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000),
    });

    // Trial entitlements come from the resolver, not from the assigned plan.
    expect(await can(trialOrg, "white_label")).toBe(true);
  });

  it("keeps entitlements while past_due — dunning is a grace period", async () => {
    const dunningOrg = await makeOrg("dunning");
    await assignPlan({ organizationId: dunningOrg, planKey: "pro", status: "past_due" });

    expect(await can(dunningOrg, "api_access")).toBe(true);
  });
});

describe("cancelSubscription", () => {
  it("drops the organization to the default plan", async () => {
    const cancelOrg = await makeOrg("cancel");
    await assignPlan({ organizationId: cancelOrg, planKey: "agency" });
    expect(await can(cancelOrg, "white_label")).toBe(true);

    const entitlements = await cancelSubscription(cancelOrg);

    expect(entitlements.effectivePlanKey).toBe(DEFAULT_PLAN_KEY);
    expect(await can(cancelOrg, "white_label")).toBe(false);
    expect(await can(cancelOrg, "api_access")).toBe(false);
  });

  it("audits the cancellation", async () => {
    const cancelOrg = await makeOrg("cancel-audit");
    await assignPlan({ organizationId: cancelOrg, planKey: "growth" });
    await cancelSubscription(cancelOrg);

    const rows = await getAdminDb()
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, cancelOrg));

    expect(rows.map((row) => row.action)).toContain("subscription.canceled");
  });
});

describe("no payment provider is involved", () => {
  it("changes entitlements with billing entirely unconfigured", async () => {
    // The whole point of the skeleton: capability follows the plan record, so
    // the product is usable long before a PSP integration exists.
    const org = await makeOrg("no-psp");

    await assignPlan({ organizationId: org, planKey: "pro" });
    expect(await can(org, "api_access")).toBe(true);

    await assignPlan({ organizationId: org, planKey: "starter" });
    expect(await can(org, "api_access")).toBe(false);
  });
});
