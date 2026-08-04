import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Role } from "@/auth/permissions";
import {
  assignableMembers,
  listTeamWithScope,
  resolveLocationScope,
  ScopeError,
  setMemberLocations,
  withinScope,
} from "@/auth/scope";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { assignReview, recordFirstResponse, setReviewStatus, TriageError } from "@/inbox/triage";
import { listLocations } from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";

/**
 * Status, assignment and location scope (P2-T4).
 *
 * The Definition of Done: "a review can be assigned, moved through statuses, and
 * shows SLA state; permissions enforced server-side." The SLA state is a pure
 * function tested next door; what needs a database is the permission half, and
 * in particular the rule that is new here — a member is scoped to locations, so
 * "can this person be given this review" is a question about *them*, not about
 * whoever is doing the assigning.
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
  admin: Person;
  /** Scoped to Kadıköy only. */
  kadikoyMember: Person;
  /** No rows in member_locations — unrestricted by the documented default. */
  roamingMember: Person;
  client: Person;
};

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
    .values({ name: `Triage ${label} ${suffix}`, slug: `triage-${label}-${suffix}` })
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

  // Ordered by name in listLocations: Beşiktaş sorts before Kadıköy, so read
  // them by the value inserted rather than by position.
  const kadikoy = locations[0]!.id;
  const besiktas = locations[1]!.id;

  const fixture: Fixture = {
    orgId: org.id,
    kadikoy,
    besiktas,
    owner: await addPerson(org.id, "Owner", "owner"),
    admin: await addPerson(org.id, "Admin", "admin"),
    kadikoyMember: await addPerson(org.id, "Kadikoyer", "member"),
    roamingMember: await addPerson(org.id, "Roamer", "member"),
    client: await addPerson(org.id, "Client", "client"),
  };

  await getAdminDb().insert(schema.memberLocations).values({
    organizationId: org.id,
    membershipId: fixture.kadikoyMember.membershipId,
    locationId: kadikoy,
  });

  return fixture;
}

async function addReview(fixture: Fixture, locationId: string): Promise<string> {
  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: fixture.orgId,
      locationId,
      source: "mock",
      sourceReviewId: `t-${suffix}-${counter++}`,
      authorName: "Selin",
      rating: 2,
      text: "Servis yavaştı.",
      postedAt: new Date(),
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });

  return review!.id;
}

/** Runs an operation as one person, resolving their scope the way the action does. */
async function as<T>(
  fixture: Fixture,
  person: Person,
  fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0], actor: never) => Promise<T>,
): Promise<T> {
  return withTenant({ organizationId: fixture.orgId, userId: person.userId }, async (tx) => {
    const scope = await resolveLocationScope(tx, fixture.orgId, person.userId, person.role);
    const actor = {
      organizationId: fixture.orgId,
      userId: person.userId,
      role: person.role,
      scope,
    };
    return fn(tx, actor as never);
  });
}

async function readReview(id: string) {
  const [row] = await getAdminDb().select().from(schema.reviews).where(eq(schema.reviews.id, id));
  return row!;
}

async function auditFor(orgId: string, reviewId: string) {
  return getAdminDb()
    .select()
    .from(schema.auditLogs)
    .where(
      and(
        eq(schema.auditLogs.organizationId, orgId),
        eq(schema.auditLogs.entity, `review:${reviewId}`),
      ),
    );
}

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("location scope", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`scope-${counter++}`);
  });

  it("leaves an owner unrestricted", async () => {
    const scope = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      resolveLocationScope(tx, fixture.orgId, fixture.owner.userId, "owner"),
    );

    expect(scope.all).toBe(true);
  });

  it("restricts a member who has been given locations", async () => {
    const scope = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      resolveLocationScope(tx, fixture.orgId, fixture.kadikoyMember.userId, "member"),
    );

    expect(scope).toEqual({ all: false, locationIds: [fixture.kadikoy] });
    expect(withinScope(scope, fixture.kadikoy)).toBe(true);
    expect(withinScope(scope, fixture.besiktas)).toBe(false);
  });

  it("leaves a member with no assignment unrestricted", async () => {
    // The documented default. Reading "no rows" as "no locations" would lock
    // every existing member out of everything, with no screen to fix it.
    const scope = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      resolveLocationScope(tx, fixture.orgId, fixture.roamingMember.userId, "member"),
    );

    expect(scope.all).toBe(true);
  });

  it("gives a client with no assignment nothing", async () => {
    // The one role held by somebody outside the business, where the generous
    // default would be a leak rather than an inconvenience.
    const scope = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      resolveLocationScope(tx, fixture.orgId, fixture.client.userId, "client"),
    );

    expect(scope).toEqual({ all: false, locationIds: [] });
  });

  it("narrows the locations a scoped member is offered", async () => {
    const [everything, narrowed] = await withTenant(
      { organizationId: fixture.orgId },
      async (tx) => {
        const scope = await resolveLocationScope(
          tx,
          fixture.orgId,
          fixture.kadikoyMember.userId,
          "member",
        );
        return [
          await listLocations(tx, fixture.orgId),
          await listLocations(tx, fixture.orgId, scope),
        ];
      },
    );

    expect(everything).toHaveLength(2);
    expect(narrowed?.map((location) => location.id)).toEqual([fixture.kadikoy]);
  });
});

describe("assignable members", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`assignable-${counter++}`);
  });

  it("offers a scoped member only at their own location", async () => {
    const [atKadikoy, atBesiktas] = await withTenant(
      { organizationId: fixture.orgId },
      async (tx) => [
        await assignableMembers(tx, fixture.orgId, fixture.kadikoy),
        await assignableMembers(tx, fixture.orgId, fixture.besiktas),
      ],
    );

    expect(atKadikoy?.map((member) => member.userId)).toContain(fixture.kadikoyMember.userId);
    expect(atBesiktas?.map((member) => member.userId)).not.toContain(fixture.kadikoyMember.userId);
  });

  it("never offers a client", async () => {
    const members = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      assignableMembers(tx, fixture.orgId, fixture.kadikoy),
    );

    expect(members.map((member) => member.userId)).not.toContain(fixture.client.userId);
  });

  it("offers the unrestricted people everywhere", async () => {
    const members = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      assignableMembers(tx, fixture.orgId, fixture.besiktas),
    );

    const ids = members.map((member) => member.userId);
    expect(ids).toContain(fixture.owner.userId);
    expect(ids).toContain(fixture.admin.userId);
    expect(ids).toContain(fixture.roamingMember.userId);
  });
});

describe("moving a review through statuses", () => {
  let fixture: Fixture;
  let reviewId: string;

  beforeEach(async () => {
    fixture = await makeFixture(`status-${counter++}`);
    reviewId = await addReview(fixture, fixture.kadikoy);
  });

  it("walks open → in progress → done", async () => {
    await as(fixture, fixture.admin, (tx, actor) =>
      setReviewStatus(tx, actor, { reviewId, status: "in_progress" }),
    );
    expect((await readReview(reviewId)).status).toBe("in_progress");

    await as(fixture, fixture.admin, (tx, actor) =>
      setReviewStatus(tx, actor, { reviewId, status: "done" }),
    );
    expect((await readReview(reviewId)).status).toBe("done");
  });

  it("lets a review be reopened", async () => {
    // Closing something by mistake must be recoverable. A state machine that
    // refuses is a state machine people work around outside the product.
    await as(fixture, fixture.admin, (tx, actor) =>
      setReviewStatus(tx, actor, { reviewId, status: "done" }),
    );
    await as(fixture, fixture.admin, (tx, actor) =>
      setReviewStatus(tx, actor, { reviewId, status: "open" }),
    );

    expect((await readReview(reviewId)).status).toBe("open");
  });

  it("writes an audit row naming the change", async () => {
    await as(fixture, fixture.admin, (tx, actor) =>
      setReviewStatus(tx, actor, { reviewId, status: "ignored" }),
    );

    const rows = await auditFor(fixture.orgId, reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("review.status_changed");
    expect(rows[0]?.actorUserId).toBe(fixture.admin.userId);
    expect(rows[0]?.meta).toMatchObject({ from: "open", to: "ignored" });
  });

  it("logs nothing when the status does not actually change", async () => {
    const outcome = await as(fixture, fixture.admin, (tx, actor) =>
      setReviewStatus(tx, actor, { reviewId, status: "open" }),
    );

    expect(outcome.changed).toBe(false);
    expect(await auditFor(fixture.orgId, reviewId)).toHaveLength(0);
  });

  it("refuses a client", async () => {
    await expect(
      as(fixture, fixture.client, (tx, actor) =>
        setReviewStatus(tx, actor, { reviewId, status: "done" }),
      ),
    ).rejects.toThrow(TriageError);
  });

  it("refuses a member scoped to another location", async () => {
    const elsewhere = await addReview(fixture, fixture.besiktas);

    await expect(
      as(fixture, fixture.kadikoyMember, (tx, actor) =>
        setReviewStatus(tx, actor, { reviewId: elsewhere, status: "done" }),
      ),
    ).rejects.toThrow(/location you cannot see/);

    expect((await readReview(elsewhere)).status).toBe("open");
  });
});

describe("assigning a review", () => {
  let fixture: Fixture;
  let reviewId: string;

  beforeEach(async () => {
    fixture = await makeFixture(`assign-${counter++}`);
    reviewId = await addReview(fixture, fixture.kadikoy);
  });

  it("assigns and unassigns", async () => {
    await as(fixture, fixture.admin, (tx, actor) =>
      assignReview(tx, actor, { reviewId, assigneeUserId: fixture.kadikoyMember.userId }),
    );
    expect((await readReview(reviewId)).assigneeUserId).toBe(fixture.kadikoyMember.userId);

    await as(fixture, fixture.admin, (tx, actor) =>
      assignReview(tx, actor, { reviewId, assigneeUserId: null }),
    );
    expect((await readReview(reviewId)).assigneeUserId).toBeNull();
  });

  it("audits both directions distinctly", async () => {
    await as(fixture, fixture.admin, (tx, actor) =>
      assignReview(tx, actor, { reviewId, assigneeUserId: fixture.roamingMember.userId }),
    );
    await as(fixture, fixture.admin, (tx, actor) =>
      assignReview(tx, actor, { reviewId, assigneeUserId: null }),
    );

    const actions = (await auditFor(fixture.orgId, reviewId)).map((row) => row.action);
    expect(actions).toContain("review.assigned");
    expect(actions).toContain("review.unassigned");
  });

  it("refuses to give work to somebody who cannot see the location", async () => {
    // The rule that matters: the *assignee's* scope, not the assigner's. An
    // admin sees everything and could otherwise create an item that sits in a
    // queue nobody can open.
    const elsewhere = await addReview(fixture, fixture.besiktas);

    await expect(
      as(fixture, fixture.admin, (tx, actor) =>
        assignReview(tx, actor, {
          reviewId: elsewhere,
          assigneeUserId: fixture.kadikoyMember.userId,
        }),
      ),
    ).rejects.toThrow(/cannot see this location/);

    expect((await readReview(elsewhere)).assigneeUserId).toBeNull();
  });

  it("refuses somebody from another organization", async () => {
    const neighbour = await makeFixture(`assign-other-${counter++}`);

    await expect(
      as(fixture, fixture.admin, (tx, actor) =>
        assignReview(tx, actor, { reviewId, assigneeUserId: neighbour.admin.userId }),
      ),
    ).rejects.toThrow(/not on this team/);
  });

  it("lets a member assign within their own scope", async () => {
    // docs/06 §3 gives Member the "assign" verb; it is ordinary work.
    await as(fixture, fixture.kadikoyMember, (tx, actor) =>
      assignReview(tx, actor, { reviewId, assigneeUserId: fixture.kadikoyMember.userId }),
    );

    expect((await readReview(reviewId)).assigneeUserId).toBe(fixture.kadikoyMember.userId);
  });
});

describe("the first response", () => {
  let fixture: Fixture;
  let reviewId: string;

  beforeEach(async () => {
    fixture = await makeFixture(`response-${counter++}`);
    reviewId = await addReview(fixture, fixture.kadikoy);
  });

  it("is recorded once and never moved", async () => {
    const first = new Date("2026-08-03T09:00:00.000Z");
    const later = new Date("2026-08-05T09:00:00.000Z");

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      recordFirstResponse(tx, fixture.orgId, reviewId, first),
    );
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      recordFirstResponse(tx, fixture.orgId, reviewId, later),
    );

    // A follow-up reply must not overwrite the answer that actually arrived
    // first — it is the numerator of every response-time figure.
    expect((await readReview(reviewId)).firstResponseAt?.toISOString()).toBe(first.toISOString());
  });

  it("cannot be written across the tenant boundary", async () => {
    const neighbour = await makeFixture(`response-other-${counter++}`);

    await withTenant({ organizationId: neighbour.orgId }, (tx) =>
      recordFirstResponse(tx, neighbour.orgId, reviewId, new Date()),
    );

    expect((await readReview(reviewId)).firstResponseAt).toBeNull();
  });
});

describe("setting a member's locations", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`set-scope-${counter++}`);
  });

  const asAdmin = { organizationId: "", role: "admin" as const };

  it("pins a previously unrestricted member", async () => {
    const scope = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      await setMemberLocations(
        tx,
        { ...asAdmin, organizationId: fixture.orgId },
        { userId: fixture.roamingMember.userId, locationIds: [fixture.besiktas] },
      );
      return resolveLocationScope(tx, fixture.orgId, fixture.roamingMember.userId, "member");
    });

    expect(scope).toEqual({ all: false, locationIds: [fixture.besiktas] });
  });

  it("lifts a restriction with an empty list", async () => {
    // Empty means unrestricted — the same thing the absence of rows has always
    // meant. The screen never sends it to mean "sees nothing".
    const scope = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      await setMemberLocations(
        tx,
        { ...asAdmin, organizationId: fixture.orgId },
        { userId: fixture.kadikoyMember.userId, locationIds: [] },
      );
      return resolveLocationScope(tx, fixture.orgId, fixture.kadikoyMember.userId, "member");
    });

    expect(scope.all).toBe(true);
  });

  it("replaces the set rather than adding to it", async () => {
    const scope = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      await setMemberLocations(
        tx,
        { ...asAdmin, organizationId: fixture.orgId },
        { userId: fixture.kadikoyMember.userId, locationIds: [fixture.besiktas] },
      );
      return resolveLocationScope(tx, fixture.orgId, fixture.kadikoyMember.userId, "member");
    });

    expect(scope).toEqual({ all: false, locationIds: [fixture.besiktas] });
  });

  it("refuses a member trying to change anybody's scope", async () => {
    await expect(
      withTenant({ organizationId: fixture.orgId }, (tx) =>
        setMemberLocations(
          tx,
          { organizationId: fixture.orgId, role: "member" },
          { userId: fixture.roamingMember.userId, locationIds: [fixture.kadikoy] },
        ),
      ),
    ).rejects.toThrow(ScopeError);
  });

  it("refuses to pin an owner", async () => {
    await expect(
      withTenant({ organizationId: fixture.orgId }, (tx) =>
        setMemberLocations(
          tx,
          { ...asAdmin, organizationId: fixture.orgId },
          { userId: fixture.owner.userId, locationIds: [fixture.kadikoy] },
        ),
      ),
    ).rejects.toThrow(/owner always sees/);
  });

  it("refuses a location from another organization", async () => {
    const neighbour = await makeFixture(`set-scope-other-${counter++}`);

    await expect(
      withTenant({ organizationId: fixture.orgId }, (tx) =>
        setMemberLocations(
          tx,
          { ...asAdmin, organizationId: fixture.orgId },
          { userId: fixture.roamingMember.userId, locationIds: [neighbour.kadikoy] },
        ),
      ),
    ).rejects.toThrow(/does not belong/);
  });

  it("refuses somebody who is not on this team", async () => {
    const neighbour = await makeFixture(`set-scope-outsider-${counter++}`);

    await expect(
      withTenant({ organizationId: fixture.orgId }, (tx) =>
        setMemberLocations(
          tx,
          { ...asAdmin, organizationId: fixture.orgId },
          { userId: neighbour.admin.userId, locationIds: [fixture.kadikoy] },
        ),
      ),
    ).rejects.toThrow(/not on this team/);
  });

  it("reports each member's current scope for the screen", async () => {
    const team = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listTeamWithScope(tx, fixture.orgId),
    );

    const scoped = team.find((member) => member.userId === fixture.kadikoyMember.userId);
    const roaming = team.find((member) => member.userId === fixture.roamingMember.userId);

    expect(scoped?.locationIds).toEqual([fixture.kadikoy]);
    // Unrestricted reads as an empty list, which is what the screen renders as
    // "all locations" rather than as "none".
    expect(roaming?.locationIds).toEqual([]);
  });

  it("takes effect immediately on what that member can touch", async () => {
    // The point of the screen: pinning somebody changes what they may act on,
    // with no other step.
    const review = await addReview(fixture, fixture.besiktas);

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      setMemberLocations(
        tx,
        { ...asAdmin, organizationId: fixture.orgId },
        { userId: fixture.roamingMember.userId, locationIds: [fixture.kadikoy] },
      ),
    );

    await expect(
      as(fixture, fixture.roamingMember, (tx, actor) =>
        setReviewStatus(tx, actor, { reviewId: review, status: "done" }),
      ),
    ).rejects.toThrow(/location you cannot see/);
  });
});
