import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Role } from "@/auth/permissions";
import { resolveLocationScope } from "@/auth/scope";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { EMPTY_INBOX_FILTERS } from "@/inbox/filters";
import { bulkSetStatus } from "@/inbox/bulk";
import { setReviewStatus, type TriageActor } from "@/inbox/triage";
import { createSavedView } from "@/inbox/views";
import { EntitlementError } from "@/lib/entitlements";
import { listLocations, listLocationsForActor } from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";
import { notifySlaBreaches } from "@/notifications/service";
import { PLAN_CATALOG } from "@/lib/plans";

/**
 * Entitlements and team scope (P2-T8).
 *
 * The Definition of Done: "plan changes toggle these features with no code
 * change; no cross-scope access." Both halves are asserted the only way that
 * means anything — by *changing the plan* and running the same call again, and
 * by asking for something outside a member's locations through each surface
 * that could grant it.
 *
 * The plan is switched by pointing the organization at a different catalog row,
 * which is exactly what an upgrade does. Nothing in the assertions names a tier:
 * a test that said "growth can do bulk actions" would have to be edited the day
 * packaging moved, which is the thing this task exists to avoid.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

type Person = { userId: string; membershipId: string; role: Role };

type Fixture = {
  orgId: string;
  kadikoy: string;
  besiktas: string;
  owner: Person;
  /** Scoped to Kadıköy only. */
  scoped: Person;
};

async function planId(key: keyof typeof PLAN_CATALOG): Promise<string> {
  const [plan] = await getAdminDb().select().from(schema.plans).where(eq(schema.plans.key, key));
  if (!plan) throw new Error(`plan ${key} is not seeded`);
  return plan.id;
}

/** Points the organization at a different plan — what an upgrade does. */
async function setPlan(fixture: Fixture, key: keyof typeof PLAN_CATALOG): Promise<void> {
  await getAdminDb()
    .update(schema.subscriptions)
    .set({ planId: await planId(key), status: "active", currentPeriodEnd: null })
    .where(eq(schema.subscriptions.organizationId, fixture.orgId));
}

async function addPerson(orgId: string, label: string, role: Role): Promise<Person> {
  const [user] = await getAdminDb()
    .insert(schema.users)
    .values({ email: `${label}-${suffix}-${counter++}@example.com`, name: label })
    .returning({ id: schema.users.id });

  const [membership] = await getAdminDb()
    .insert(schema.memberships)
    .values({ organizationId: orgId, userId: user!.id, role })
    .returning({ id: schema.memberships.id });

  return { userId: user!.id, membershipId: membership!.id, role };
}

async function makeFixture(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Ent ${label}`, slug: `ent-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const locations = await getAdminDb()
    .insert(schema.locations)
    .values([
      { organizationId: org.id, name: "Kadıköy" },
      { organizationId: org.id, name: "Beşiktaş" },
    ])
    .returning({ id: schema.locations.id });

  const fixture: Fixture = {
    orgId: org.id,
    kadikoy: locations[0]!.id,
    besiktas: locations[1]!.id,
    owner: await addPerson(org.id, "Owner", "owner"),
    scoped: await addPerson(org.id, "Scoped", "member"),
  };

  await getAdminDb().insert(schema.memberLocations).values({
    organizationId: org.id,
    membershipId: fixture.scoped.membershipId,
    locationId: fixture.kadikoy,
  });

  // Every organization starts on a plan; which one is set per test.
  await getAdminDb()
    .insert(schema.subscriptions)
    .values({ organizationId: org.id, planId: await planId("starter"), status: "active" });

  return fixture;
}

async function addReview(fixture: Fixture, locationId?: string): Promise<string> {
  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: fixture.orgId,
      locationId: locationId ?? fixture.kadikoy,
      source: "mock",
      sourceReviewId: `e-${suffix}-${counter++}`,
      rating: 2,
      text: "Servis yavaştı.",
      postedAt: new Date(Date.now() - 48 * 3_600_000),
      slaDueAt: new Date(Date.now() - 2 * 3_600_000),
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });

  return review!.id;
}

async function actorFor(
  fixture: Fixture,
  person: Person,
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
): Promise<TriageActor> {
  return {
    organizationId: fixture.orgId,
    userId: person.userId,
    role: person.role,
    scope: await resolveLocationScope(tx, fixture.orgId, person.userId, person.role),
  };
}

/** The tiers this suite compares, found by asking the catalog rather than by name. */
function tierWithout(feature: "saved_views" | "bulk_actions") {
  const entry = Object.values(PLAN_CATALOG).find((plan) => !plan.entitlements.features[feature]);
  if (!entry) throw new Error(`every plan includes ${feature}; this suite needs one that does not`);
  return entry.key;
}

function tierWith(feature: "saved_views" | "bulk_actions" | "sla_tracking") {
  const entry = Object.values(PLAN_CATALOG).find((plan) => plan.entitlements.features[feature]);
  if (!entry) throw new Error(`no plan includes ${feature}`);
  return entry.key;
}

/**
 * Turns a feature off for this organization alone, then puts it back.
 *
 * `sla_tracking` is on every tier — deliberately, since a response deadline is
 * about the customer rather than about dividing work between colleagues. So
 * there is no lesser plan to switch to, and the claim has to be made through
 * the other lever the product already has: a per-subscription override, which
 * is what a custom deal or a temporary suspension writes.
 *
 * Note this is the *only* honest way to do it. Entitlements come from
 * `PLAN_CATALOG` in code; the `plans.entitlements` column is pricing metadata
 * the gate never reads, so patching that row would prove nothing while
 * appearing to work.
 *
 * Restores in a `finally`, because a leaked override would silently disarm
 * every later assertion in the file.
 */
async function withFeatureOff<T>(
  fixture: Fixture,
  feature: "sla_tracking",
  fn: () => Promise<T>,
): Promise<T> {
  const setOverrides = (value: unknown) =>
    getAdminDb()
      .update(schema.subscriptions)
      .set({ overrides: value })
      .where(eq(schema.subscriptions.organizationId, fixture.orgId));

  await setOverrides({ features: { [feature]: false } });

  try {
    return await fn();
  } finally {
    await setOverrides({});
  }
}

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("a plan change toggles the feature, with no code change", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`plan-${counter++}`);
  });

  it("saved views", async () => {
    const save = () =>
      withTenant({ organizationId: fixture.orgId }, (tx) =>
        createSavedView(tx, {
          organizationId: fixture.orgId,
          userId: fixture.owner.userId,
          role: "owner",
          name: "Overdue negatives",
          shared: false,
          filters: { ...EMPTY_INBOX_FILTERS, overdue: true },
        }),
      );

    await setPlan(fixture, tierWithout("saved_views"));
    await expect(save()).rejects.toThrow(EntitlementError);

    await setPlan(fixture, tierWith("saved_views"));
    await expect(save()).resolves.toMatchObject({ name: "Overdue negatives" });
  });

  it("bulk actions", async () => {
    const id = await addReview(fixture);
    const run = () =>
      withTenant({ organizationId: fixture.orgId }, async (tx) =>
        bulkSetStatus(tx, await actorFor(fixture, fixture.owner, tx), {
          reviewIds: [id],
          status: "done",
        }),
      );

    await setPlan(fixture, tierWithout("bulk_actions"));
    await expect(run()).rejects.toThrow(EntitlementError);

    await setPlan(fixture, tierWith("bulk_actions"));
    await expect(run()).resolves.toMatchObject({ changed: [id] });
  });

  it("SLA alerts", async () => {
    await addReview(fixture);

    await setPlan(fixture, tierWith("sla_tracking"));

    const gated = await withFeatureOff(fixture, "sla_tracking", () =>
      notifySlaBreaches({ organizationId: fixture.orgId }),
    );
    expect(gated).toMatchObject({ reviews: 0, created: 0 });

    const allowed = await notifySlaBreaches({ organizationId: fixture.orgId });

    // One review, but `created` counts notification *rows* — this organization
    // has two members, and both are told.
    expect(allowed.reviews).toBe(1);
    expect(allowed.created).toBe(2);
  });

  it("keeps the deadline data while the plan is off, so an upgrade reveals history", async () => {
    // Gating the *alert* rather than the stamp is what makes an upgrade show a
    // real backlog instead of starting the clock from zero.
    await setPlan(fixture, tierWith("sla_tracking"));
    const id = await withFeatureOff(fixture, "sla_tracking", async () => {
      const reviewId = await addReview(fixture);
      await notifySlaBreaches({ organizationId: fixture.orgId });
      return reviewId;
    });

    const [row] = await getAdminDb().select().from(schema.reviews).where(eq(schema.reviews.id, id));

    expect(row?.slaDueAt).not.toBeNull();
    expect(row?.slaAlertedAt).toBeNull();
  });

  it("does not single out one triage action — status still works on any plan", async () => {
    // Only saved views, bulk actions and SLA are gated. Setting a status one
    // review at a time is the product's core job, not an upsell.
    const id = await addReview(fixture);
    await setPlan(fixture, tierWithout("bulk_actions"));

    await expect(
      withTenant({ organizationId: fixture.orgId }, async (tx) =>
        setReviewStatus(tx, await actorFor(fixture, fixture.owner, tx), {
          reviewId: id,
          status: "done",
        }),
      ),
    ).resolves.toMatchObject({ changed: true });
  });
});

describe("no cross-scope access", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`scope-${counter++}`);
    await setPlan(fixture, tierWith("bulk_actions"));
  });

  it("offers a scoped member only their own locations", async () => {
    const [all, mine] = await withTenant(
      { organizationId: fixture.orgId, userId: fixture.scoped.userId },
      async (tx) => [
        await listLocations(tx, fixture.orgId),
        await listLocationsForActor(tx, {
          organizationId: fixture.orgId,
          userId: fixture.scoped.userId,
          role: "member",
        }),
      ],
    );

    // The unscoped reader is what the jobs use and still sees both; the person
    // sees one. Asserting both is what makes this a scope test rather than an
    // empty-fixture test.
    expect(all).toHaveLength(2);
    expect(mine?.map((location) => location.id)).toEqual([fixture.kadikoy]);
  });

  it("leaves an owner unrestricted", async () => {
    const seen = await withTenant(
      { organizationId: fixture.orgId, userId: fixture.owner.userId },
      (tx) =>
        listLocationsForActor(tx, {
          organizationId: fixture.orgId,
          userId: fixture.owner.userId,
          role: "owner",
        }),
    );

    expect(seen).toHaveLength(2);
  });

  it("refuses a single triage action outside the scope", async () => {
    const elsewhere = await addReview(fixture, fixture.besiktas);

    await expect(
      withTenant({ organizationId: fixture.orgId }, async (tx) =>
        setReviewStatus(tx, await actorFor(fixture, fixture.scoped, tx), {
          reviewId: elsewhere,
          status: "done",
        }),
      ),
    ).rejects.toThrow(/location you cannot see/);
  });

  it("skips out-of-scope rows in a bulk action rather than failing the batch", async () => {
    const mine = await addReview(fixture, fixture.kadikoy);
    const theirs = await addReview(fixture, fixture.besiktas);

    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkSetStatus(tx, await actorFor(fixture, fixture.scoped, tx), {
        reviewIds: [mine, theirs],
        status: "done",
      }),
    );

    expect(outcome.changed).toEqual([mine]);
    expect(outcome.skipped).toEqual([{ id: theirs, reason: "out_of_scope" }]);
  });
});
