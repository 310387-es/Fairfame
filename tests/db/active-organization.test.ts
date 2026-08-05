import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { rememberActiveOrganization, resolveActiveOrganization } from "@/auth/active-organization";

/**
 * Which organization a session opens in (W1.1).
 *
 * **The bug.** BetterAuth writes `sessions.active_organization_id` only inside
 * `setActive`, and nothing called it on sign-in — so every returning session
 * began with a null tenant, `requireActor` threw `NoActiveOrganizationError`,
 * and the shell redirected to `/create-organization`. A customer with a
 * perfectly good organization was shown the form that makes a second one, and
 * could not reach any screen of the product until they used it.
 *
 * **The half these tests are really about.** The resolver reads a *preference*
 * and must never let it become a *permission*: a remembered organization is
 * re-checked against `memberships` every time. Getting that wrong would be the
 * worst failure this codebase can have — the tenant context set to an
 * organization somebody is no longer in — and it is exactly the kind of thing
 * that keeps working in every manual test, because the person testing it has
 * never been removed from anything.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

type Org = { id: string; name: string };

/** Belongs to one organization. The overwhelmingly common case. */
let soloUser: string;
let solo: Org;

/** Belongs to two and has never chosen. Gets the picker. */
let multiUser: string;
let first: Org;
let second: Org;

/** Belongs to nothing — the moment after signup. */
let newcomer: string;

async function makeOrg(label: string, name: string): Promise<Org> {
  const [row] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name, slug: `ao-${label}-${suffix}` })
    .returning({ id: schema.organizations.id, name: schema.organizations.name });
  orgIds.push(row!.id);
  return row!;
}

async function makeUser(label: string): Promise<string> {
  const [row] = await getAdminDb()
    .insert(schema.users)
    .values({ email: `ao-${label}-${suffix}@example.com`, name: label })
    .returning({ id: schema.users.id });
  userIds.push(row!.id);
  return row!.id;
}

async function join(organizationId: string, userId: string) {
  await getAdminDb().insert(schema.memberships).values({ organizationId, userId, role: "owner" });
}

async function leave(organizationId: string, userId: string) {
  await getAdminDb()
    .delete(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, organizationId),
        eq(schema.memberships.userId, userId),
      ),
    );
}

async function remembered(userId: string): Promise<string | null> {
  const [row] = await getAdminDb()
    .select({ id: schema.users.lastActiveOrganizationId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  return row?.id ?? null;
}

beforeAll(async () => {
  solo = await makeOrg("solo", "Tek Şube Kahve");
  first = await makeOrg("first", "Birinci İşletme");
  second = await makeOrg("second", "İkinci İşletme");

  soloUser = await makeUser("solo");
  multiUser = await makeUser("multi");
  newcomer = await makeUser("newcomer");

  await join(solo.id, soloUser);
  await join(first.id, multiUser);
  await join(second.id, multiUser);
}, 30_000);

afterAll(async () => {
  const db = getAdminDb();
  if (userIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  }
  if (orgIds.length > 0) {
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

// ---------------------------------------------------------------------------

describe("resolving where a session opens", () => {
  it("gives a single-member user their one organization", async () => {
    // The bug, stated as an assertion: this returned nothing, so the shell sent
    // them to a form asking them to create what they already had.
    expect(await resolveActiveOrganization(soloUser)).toBe(solo.id);
  });

  it("gives nobody an organization when they belong to none", async () => {
    // The moment after signup. Null is right here — there is nothing to open.
    expect(await resolveActiveOrganization(newcomer)).toBeNull();
  });

  it("declines to guess between two, so the picker can ask", async () => {
    expect(await resolveActiveOrganization(multiUser)).toBeNull();
  });

  it("opens the organization somebody last chose", async () => {
    await rememberActiveOrganization(multiUser, second.id);
    expect(await resolveActiveOrganization(multiUser)).toBe(second.id);

    // And a later choice wins over the earlier one.
    await rememberActiveOrganization(multiUser, first.id);
    expect(await resolveActiveOrganization(multiUser)).toBe(first.id);
  });
});

describe("a preference is not a permission", () => {
  it("ignores a remembered organization the person has been removed from", async () => {
    await rememberActiveOrganization(multiUser, second.id);
    expect(await resolveActiveOrganization(multiUser)).toBe(second.id);

    await leave(second.id, multiUser);

    // The stored preference is untouched and still points at `second` — the
    // resolver must not believe it. Falling through to the sole remaining
    // membership is the right answer; returning `second.id` would put the RLS
    // tenant context in an organization this person no longer belongs to.
    expect(await remembered(multiUser)).toBe(second.id);
    expect(await resolveActiveOrganization(multiUser)).toBe(first.id);
  });

  it("returns nothing when the remembered organization is gone and nothing replaces it", async () => {
    const orphan = await makeUser("orphan");
    await rememberActiveOrganization(orphan, solo.id);

    // Never a member of it in the first place — the shape a stale or forged
    // preference would take.
    expect(await resolveActiveOrganization(orphan)).toBeNull();
  });

  it("forgets the preference when the organization is deleted, rather than the person", async () => {
    const doomed = await makeOrg("doomed", "Kapanan İşletme");
    const owner = await makeUser("doomed-owner");
    await join(doomed.id, owner);
    await rememberActiveOrganization(owner, doomed.id);

    await getAdminDb().delete(schema.organizations).where(eq(schema.organizations.id, doomed.id));

    // ON DELETE SET NULL, not CASCADE. The user survives with no preference.
    expect(await remembered(owner)).toBeNull();
    expect(await resolveActiveOrganization(owner)).toBeNull();
  });
});

describe("remembering a choice", () => {
  it("is a no-op when the value has not changed", async () => {
    // The session-update hook fires on the daily refresh too, carrying an
    // unchanged value. The WHERE clause is what keeps that from being a write
    // per user per day.
    await rememberActiveOrganization(soloUser, solo.id);
    const [before] = await getAdminDb()
      .select({ updatedAt: schema.users.updatedAt })
      .from(schema.users)
      .where(eq(schema.users.id, soloUser))
      .limit(1);

    await rememberActiveOrganization(soloUser, solo.id);
    const [after] = await getAdminDb()
      .select({ updatedAt: schema.users.updatedAt })
      .from(schema.users)
      .where(eq(schema.users.id, soloUser))
      .limit(1);

    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it("does not throw when the organization does not exist", async () => {
    // The hook that calls this runs after a switch has already been committed
    // to the session. Losing the memory costs one click at the next sign-in;
    // throwing would cost the switch.
    await expect(
      rememberActiveOrganization(soloUser, "00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeUndefined();

    // And it left the good value alone.
    expect(await remembered(soloUser)).toBe(solo.id);
  });
});
