import { inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { EMPTY_INBOX_FILTERS, type InboxFilterState } from "@/inbox/filters";
import {
  createSavedView,
  deleteSavedView,
  listSavedViews,
  MAX_SAVED_VIEWS_PER_OWNER,
  SavedViewError,
} from "@/inbox/views";
import { withTenant } from "@/lib/tenancy";
import { subscribeToPlanWith } from "./plan-fixture";

/**
 * Saved views (P2-T3).
 *
 * The Definition of Done: "a user saves a filtered view and returns to it."
 * Returning to it is the interesting half — a view is only useful if what comes
 * back out is the same filter set that went in, so the round-trip is what most
 * of this asserts. The rest is who may do what: a shared view appears on every
 * teammate's screen, and a private one must not appear on anybody else's.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

type Fixture = { orgId: string; alice: string; bob: string };

async function makeFixture(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Views ${label} ${suffix}`, slug: `views-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);
  // The floor plan excludes team-workflow features (P2-T8).
  await subscribeToPlanWith(org.id, ["saved_views"]);

  const users = await getAdminDb()
    .insert(schema.users)
    .values([
      { email: `v-alice-${label}-${suffix}@example.com`, name: "Alice" },
      { email: `v-bob-${label}-${suffix}@example.com`, name: "Bob" },
    ])
    .returning({ id: schema.users.id });

  return { orgId: org.id, alice: users[0]!.id, bob: users[1]!.id };
}

const filters = (overrides: Partial<InboxFilterState> = {}): InboxFilterState => ({
  ...EMPTY_INBOX_FILTERS,
  ...overrides,
});

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("saving and returning to a view", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`round-${counter++}`);
  });

  it("gives back the filters it was given", async () => {
    const saved = filters({
      source: "google",
      sentiment: "negative",
      status: ["open", "in_progress"],
      rating: [1, 2],
      assignee: "me",
      overdue: true,
      query: "gecikme",
      from: "2026-07-01",
      to: "2026-07-31",
      sort: "priority",
    });

    const views = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      await createSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.alice,
        role: "member",
        name: "Everything at once",
        shared: false,
        filters: saved,
      });
      return listSavedViews(tx, fixture.orgId, fixture.alice);
    });

    expect(views).toHaveLength(1);
    expect(views[0]?.filters).toEqual(saved);
  });

  it("opens at a URL that reproduces the view", async () => {
    const view = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      createSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.alice,
        role: "member",
        name: "Overdue negatives",
        shared: false,
        filters: filters({ sentiment: "negative", overdue: true }),
      }),
    );

    expect(view.href).toBe("/inbox?sentiment=negative&overdue=1");
  });

  it("does not remember which page you were on", async () => {
    // Position is not a filter. A view that reopened on page 4 of a list that
    // has since changed length is a view that lands nowhere in particular.
    const view = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      createSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.alice,
        role: "member",
        name: "Plain",
        shared: false,
        filters: filters({ source: "mock" }),
      }),
    );

    expect(view.href).not.toContain("page=");
    expect(view.href).not.toContain("more=");
  });

  it("updates in place when the same name is saved again", async () => {
    const views = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const base = {
        organizationId: fixture.orgId,
        userId: fixture.alice,
        role: "member" as const,
        name: "My queue",
        shared: false,
      };

      await createSavedView(tx, { ...base, filters: filters({ sentiment: "negative" }) });
      await createSavedView(tx, { ...base, filters: filters({ sentiment: "positive" }) });

      return listSavedViews(tx, fixture.orgId, fixture.alice);
    });

    expect(views).toHaveLength(1);
    expect(views[0]?.filters.sentiment).toBe("positive");
  });

  it("updates a shared view in place too", async () => {
    // The shared row's owner is NULL, and the unique key is NULLS NOT DISTINCT.
    // Without that, this second save raises a constraint violation instead of
    // updating — and it is the case a plain `unique()` would have got wrong.
    const views = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const base = {
        organizationId: fixture.orgId,
        userId: fixture.alice,
        role: "admin" as const,
        name: "The team's queue",
        shared: true,
      };

      await createSavedView(tx, { ...base, filters: filters({ overdue: true }) });
      await createSavedView(tx, { ...base, filters: filters({ status: ["open"] }) });

      return listSavedViews(tx, fixture.orgId, fixture.alice);
    });

    expect(views).toHaveLength(1);
    expect(views[0]?.filters.overdue).toBe(false);
    expect(views[0]?.filters.status).toEqual(["open"]);
  });

  it("ignores a filter it no longer recognises", async () => {
    // A view saved before a filter was removed. It should widen, not break.
    const [row] = await getAdminDb()
      .insert(schema.savedViews)
      .values({
        organizationId: fixture.orgId,
        ownerUserId: fixture.alice,
        name: "From an older release",
        filters: { source: "google", moonPhase: "waxing" },
      })
      .returning({ id: schema.savedViews.id });

    const views = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listSavedViews(tx, fixture.orgId, fixture.alice),
    );

    expect(views.find((view) => view.id === row!.id)?.filters.source).toBe("google");
  });

  it("survives a stored blob that is not a filter set at all", async () => {
    await getAdminDb()
      .insert(schema.savedViews)
      .values({
        organizationId: fixture.orgId,
        ownerUserId: fixture.alice,
        name: "Corrupt",
        filters: ["not", "an", "object"],
      });

    const views = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listSavedViews(tx, fixture.orgId, fixture.alice),
    );

    expect(views).toHaveLength(1);
    expect(views[0]?.href).toBe("/inbox");
  });
});

describe("who sees which view", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`vis-${counter++}`);

    await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      await createSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.alice,
        role: "member",
        name: "Alice's own",
        shared: false,
        filters: filters({ sentiment: "negative" }),
      });
      await createSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.alice,
        role: "admin",
        name: "The team's",
        shared: true,
        filters: filters({ overdue: true }),
      });
    });
  });

  it("shows a person their own views and everything shared", async () => {
    const [forAlice, forBob] = await withTenant({ organizationId: fixture.orgId }, async (tx) => [
      await listSavedViews(tx, fixture.orgId, fixture.alice),
      await listSavedViews(tx, fixture.orgId, fixture.bob),
    ]);

    expect(forAlice?.map((view) => view.name)).toEqual(["The team's", "Alice's own"]);
    // Bob sees the shared one and nothing of Alice's.
    expect(forBob?.map((view) => view.name)).toEqual(["The team's"]);
  });

  it("puts the shared views first", async () => {
    const views = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listSavedViews(tx, fixture.orgId, fixture.alice),
    );

    expect(views[0]?.shared).toBe(true);
  });

  it("keeps views inside their tenant", async () => {
    const neighbour = await makeFixture(`vis-other-${counter++}`);

    const seen = await withTenant({ organizationId: neighbour.orgId }, (tx) =>
      listSavedViews(tx, neighbour.orgId, fixture.alice),
    );

    expect(seen).toEqual([]);
  });
});

describe("permissions", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`perm-${counter++}`);
  });

  it("refuses a member trying to save a view for the whole team", async () => {
    await expect(
      withTenant({ organizationId: fixture.orgId }, (tx) =>
        createSavedView(tx, {
          organizationId: fixture.orgId,
          userId: fixture.bob,
          role: "member",
          name: "Everyone's problem",
          shared: true,
          filters: filters({ overdue: true }),
        }),
      ),
    ).rejects.toThrow(SavedViewError);
  });

  it("lets a member keep a private view", async () => {
    const view = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      createSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.bob,
        role: "member",
        name: "Bob's own",
        shared: false,
        filters: filters({ assignee: "me" }),
      }),
    );

    expect(view.shared).toBe(false);
  });

  it("will not let one member delete another's view", async () => {
    const removed = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const view = await createSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.alice,
        role: "member",
        name: "Alice's",
        shared: false,
        filters: filters({ sentiment: "negative" }),
      });

      return deleteSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.bob,
        role: "member",
        id: view.id,
      });
    });

    expect(removed).toBe(false);
  });

  it("will not let a member delete a shared view", async () => {
    const removed = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const view = await createSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.alice,
        role: "owner",
        name: "The team's",
        shared: true,
        filters: filters({ overdue: true }),
      });

      return deleteSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.bob,
        role: "member",
        id: view.id,
      });
    });

    expect(removed).toBe(false);
  });

  it("lets an admin delete a shared view", async () => {
    const removed = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const view = await createSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.alice,
        role: "admin",
        name: "The team's",
        shared: true,
        filters: filters({ overdue: true }),
      });

      return deleteSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.bob,
        role: "admin",
        id: view.id,
      });
    });

    expect(removed).toBe(true);
  });

  it("lets a person delete their own", async () => {
    const removed = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const view = await createSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.bob,
        role: "member",
        name: "Bob's",
        shared: false,
        filters: filters({ assignee: "me" }),
      });

      return deleteSavedView(tx, {
        organizationId: fixture.orgId,
        userId: fixture.bob,
        role: "member",
        id: view.id,
      });
    });

    expect(removed).toBe(true);
  });

  it("caps how many one person may keep", async () => {
    await expect(
      withTenant({ organizationId: fixture.orgId }, async (tx) => {
        for (let index = 0; index <= MAX_SAVED_VIEWS_PER_OWNER; index += 1) {
          await createSavedView(tx, {
            organizationId: fixture.orgId,
            userId: fixture.alice,
            role: "member",
            name: `View ${index}`,
            shared: false,
            filters: filters({ theme: `theme-${index}` }),
          });
        }
      }),
    ).rejects.toThrow(SavedViewError);
  });
});
