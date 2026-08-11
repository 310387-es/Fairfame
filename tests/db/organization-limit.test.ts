import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { organizationAllowance } from "@/auth/organization-limit";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withinLimit } from "@/lib/entitlements";
import { DEFAULT_PLAN_KEY, PLAN_CATALOG, type PlanKey } from "@/lib/plans";
import { dropFixtureUsers } from "./cleanup";

/**
 * How many workspaces one person may own (11 Aug 2026).
 *
 * **The gap.** `/create-organization` called BetterAuth straight from the
 * browser, so no entitlement check was on the path at all — and every new
 * organization is granted its own 14-day *top-tier* trial. Twenty workspaces
 * was twenty free trials on one account, against a business model that prices
 * the trial to bound AI and SMS cost.
 *
 * The interesting assertions are the two that encode judgement rather than
 * arithmetic: **ownership does not include membership**, and **the most
 * generous plan among the workspaces you own is the one that decides**. Both
 * are decisions somebody could reasonably reverse, so both are pinned with the
 * reason written down.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

async function makeUser(label: string): Promise<string> {
  const [user] = await getAdminDb()
    .insert(schema.users)
    .values({ email: `orglimit-${label}-${suffix}@example.com`, name: label, emailVerified: true })
    .returning({ id: schema.users.id });
  return user!.id;
}

/** An organization owned (or merely joined) by `userId`, on `planKey`. */
async function makeOrg(
  label: string,
  userId: string,
  role: "owner" | "admin" | "member",
  planKey: PlanKey | null,
): Promise<string> {
  const db = getAdminDb();

  const [org] = await db
    .insert(schema.organizations)
    .values({ name: `OrgLimit ${label}`, slug: `orglimit-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  orgIds.push(org!.id);

  await db.insert(schema.memberships).values({ organizationId: org!.id, userId, role });

  if (planKey) {
    const [plan] = await db
      .select({ id: schema.plans.id })
      .from(schema.plans)
      .where(eq(schema.plans.key, planKey));
    if (!plan) throw new Error(`Plan "${planKey}" is not seeded; run pnpm db:seed.`);

    await db
      .insert(schema.subscriptions)
      .values({ organizationId: org!.id, planId: plan.id, status: "active" });
  }

  return org!.id;
}

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await dropFixtureUsers(suffix);
  await closeDatabasePools();
});

describe("the allowance", () => {
  it("always lets somebody create their first workspace", async () => {
    // There is no organization to resolve a plan from, and refusing here would
    // mean nobody could ever start.
    const allowance = await organizationAllowance(await makeUser("first"));

    expect(allowance).toMatchObject({ allowed: true, current: 0, planKey: null });
  });

  it("stops a Starter owner at one", async () => {
    const user = await makeUser("starter");
    await makeOrg("starter-a", user, "owner", "starter");

    const allowance = await organizationAllowance(user);

    expect(allowance.current).toBe(1);
    expect(allowance.limit).toBe(PLAN_CATALOG.starter.entitlements.limits.max_organizations);
    expect(allowance.allowed).toBe(false);
  });

  it("lets a Growth owner have a second, and not a third", async () => {
    const user = await makeUser("growth");
    await makeOrg("growth-a", user, "owner", "growth");
    expect((await organizationAllowance(user)).allowed).toBe(true);

    await makeOrg("growth-b", user, "owner", "growth");
    const full = await organizationAllowance(user);

    expect(full.current).toBe(2);
    expect(full.allowed).toBe(false);
  });

  it("never runs out for an agency", async () => {
    // The tier where many workspaces *is* the product: one per client, with
    // `agency_console` to switch between them.
    const user = await makeUser("agency");
    await makeOrg("agency-a", user, "owner", "agency");
    await makeOrg("agency-b", user, "owner", "agency");
    await makeOrg("agency-c", user, "owner", "agency");

    expect(await organizationAllowance(user)).toMatchObject({ allowed: true, limit: null });
  });
});

describe("what counts, and what decides", () => {
  it("does not spend your allowance on somebody else's workspace", async () => {
    /**
     * Ownership, not membership. An accountant invited into a client's
     * workspace must not lose the ability to create their own — and an agency
     * inviting ten people must not quietly consume ten allowances.
     */
    const user = await makeUser("guest");
    await makeOrg("guest-host-a", user, "member", "agency");
    await makeOrg("guest-host-b", user, "admin", "agency");

    const allowance = await organizationAllowance(user);

    expect(allowance.current, "membership must not count as ownership").toBe(0);
    expect(allowance.allowed).toBe(true);
  });

  it("lets the most generous plan among them decide", async () => {
    /**
     * Somebody who owns a Starter café and an Agency account is an Agency
     * customer. Letting the cheaper subscription decide would mean paying for
     * the top tier and being refused by the bottom one.
     */
    const user = await makeUser("mixed");
    await makeOrg("mixed-starter", user, "owner", "starter");
    await makeOrg("mixed-agency", user, "owner", "agency");

    const allowance = await organizationAllowance(user);

    expect(allowance.current).toBe(2);
    // Starter alone would have refused at one.
    expect(allowance).toMatchObject({ allowed: true, limit: null });
  });

  it("counts a lapsed workspace but is not granted anything by it", async () => {
    /**
     * The same rule `resolveEntitlements` applies: a cancelled subscription
     * falls to the floor. The workspace still exists and still holds data, so
     * it counts — it just stops paying for the privilege of having others.
     */
    const user = await makeUser("lapsed");
    const orgId = await makeOrg("lapsed-agency", user, "owner", "agency");

    await getAdminDb()
      .update(schema.subscriptions)
      .set({ status: "canceled" })
      .where(eq(schema.subscriptions.organizationId, orgId));

    const allowance = await organizationAllowance(user);

    expect(allowance.current, "the workspace still exists").toBe(1);
    // Falls to the Starter floor, which includes one — the one they have.
    expect(allowance.allowed).toBe(false);
  });

  it("does not let the trial grant more trials", async () => {
    /**
     * **The one place that diverges from `resolveEntitlements`, pinned.**
     *
     * Everywhere else a `trialing` subscription resolves to `TRIAL_PLAN_KEY`
     * (Agency), because the trial exists to show the whole product. Applying
     * that here would make `max_organizations` unlimited for every brand-new
     * account — and since each new organization mints another 14-day trial,
     * "unlimited workspaces while trialing" *is* "unlimited trials". The rule
     * would grant the thing it exists to bound.
     *
     * So a trialing account resolves against the plan its subscription actually
     * names. This is the exact state `provisionTrialSubscription` leaves a new
     * signup in: DEFAULT_PLAN_KEY, status `trialing`.
     */
    const user = await makeUser("trialing");
    const orgId = await makeOrg("trialing-a", user, "owner", DEFAULT_PLAN_KEY);

    await getAdminDb()
      .update(schema.subscriptions)
      .set({ status: "trialing" })
      .where(eq(schema.subscriptions.organizationId, orgId));

    const allowance = await organizationAllowance(user);

    expect(allowance.limit, "the trial must not resolve to Agency here").toBe(
      PLAN_CATALOG[DEFAULT_PLAN_KEY].entitlements.limits.max_organizations,
    );
    expect(allowance.allowed).toBe(false);
  });

  it("treats a workspace with no subscription at all as the floor", async () => {
    const user = await makeUser("nosub");
    await makeOrg("nosub-a", user, "owner", null);

    expect((await organizationAllowance(user)).allowed).toBe(false);
  });
});

describe("the per-user key cannot be asked as a per-organization one", () => {
  it("throws rather than answering zero", async () => {
    /**
     * The failure this guards is not a missing check but a *confident wrong*
     * one. `max_organizations` has no resource counter, so `readUsage` would
     * fall through to `usage_counters`, find nothing, and return 0 — a check
     * that passes forever while reading exactly like an enforced one.
     */
    const user = await makeUser("misuse");
    const orgId = await makeOrg("misuse-a", user, "owner", "starter");

    await expect(withinLimit(orgId, "max_organizations")).rejects.toThrow(/per-user limit/i);
  });
});
