import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";
import { AgencyError, isAgency, linkClient, listClients, unlinkClient } from "@/agency/clients";
import { DEFAULT_BRAND, resolveBrand } from "@/agency/branding";
import { subscribeToPlanWith } from "./plan-fixture";

/**
 * Agency and white-label (P4-T5).
 *
 * **The whole file is about one distinction**: `agency_clients` records a
 * relationship and grants nothing; `memberships` grants everything. A link that
 * could widen access would be the worst bug this codebase can have, because RLS
 * keys on `app.current_org()` and there would then be two answers to "may this
 * person read this row".
 *
 * So the tests are mostly about what is *absent* from the console: a linked
 * organization the person is not a member of, and a member organization nobody
 * linked.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

type Org = { id: string; slug: string; name: string };

let agency: Org;
/** Linked, and the operator is a member. Appears. */
let kadikoy: Org;
/** Linked, but the operator is *not* a member. Must never appear. */
let besiktas: Org;
/** A member organization nobody linked. Must never appear. */
let unrelated: Org;

let operator: string;
let outsider: string;

async function makeOrg(label: string, name: string): Promise<Org> {
  const [row] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name, slug: `ag-${label}-${suffix}` })
    .returning({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      name: schema.organizations.name,
    });
  orgIds.push(row!.id);
  return row!;
}

async function makeUser(label: string): Promise<string> {
  const [row] = await getAdminDb()
    .insert(schema.users)
    .values({ email: `ag-${label}-${suffix}@example.com`, name: label })
    .returning({ id: schema.users.id });
  userIds.push(row!.id);
  return row!.id;
}

async function join(organizationId: string, userId: string, role: "owner" | "admin" | "client") {
  await getAdminDb().insert(schema.memberships).values({ organizationId, userId, role });
}

async function link(agencyId: string, clientId: string) {
  await getAdminDb()
    .insert(schema.agencyClients)
    .values({ organizationId: agencyId, clientOrganizationId: clientId })
    .onConflictDoNothing();
}

beforeAll(async () => {
  agency = await makeOrg("agency", "Mercan Ajans");
  kadikoy = await makeOrg("kadikoy", "Kadıköy Kahve");
  besiktas = await makeOrg("besiktas", "Beşiktaş Bistro");
  unrelated = await makeOrg("unrelated", "İlgisiz İşletme");

  operator = await makeUser("operator");
  outsider = await makeUser("outsider");

  await join(agency.id, operator, "owner");
  await join(kadikoy.id, operator, "admin");
  await join(unrelated.id, operator, "admin");
  // Nobody from the agency is a member of Beşiktaş.
  await join(besiktas.id, outsider, "owner");

  await link(agency.id, kadikoy.id);
  await link(agency.id, besiktas.id);

  // The agency pays for white-label; its clients do not need to.
  await subscribeToPlanWith(agency.id, ["white_label"]);
}, 30_000);

afterAll(async () => {
  const db = getAdminDb();
  if (orgIds.length > 0) {
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  if (userIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  }
  await closeDatabasePools();
});

// ---------------------------------------------------------------------------

describe("the console lists a client only when link and membership both hold", () => {
  it("shows a linked organization the person belongs to", async () => {
    const clients = await listClients(agency.id, operator);
    expect(clients.map((row) => row.organizationId)).toContain(kadikoy.id);
  });

  it("hides a linked organization the person does not belong to", async () => {
    // The link exists. Membership does not. **This is the assertion the whole
    // design is for**: a relationship row must never be a way in.
    const clients = await listClients(agency.id, operator);
    expect(clients.map((row) => row.organizationId)).not.toContain(besiktas.id);
  });

  it("hides a member organization nobody linked", async () => {
    // The inverse. Membership alone must not put somebody else's organization
    // on an agency's console.
    const clients = await listClients(agency.id, operator);
    expect(clients.map((row) => row.organizationId)).not.toContain(unrelated.id);
  });

  it("shows nothing at all to somebody outside the agency", async () => {
    /**
     * The outsider *is* a member of Beşiktaş, and Beşiktaş *is* linked to this
     * agency — so both of the other two conditions hold. What must still stop
     * them is that they do not belong to the agency asking. `listClients`
     * checked neither until this test failed with a full roster.
     */
    const clients = await listClients(agency.id, outsider);
    expect(clients).toEqual([]);
  });

  it("carries the role held in the client, not in the agency", async () => {
    // The operator is an owner of the agency and an admin of Kadıköy. What
    // decides what "Open" lets them do is the second.
    const clients = await listClients(agency.id, operator);
    expect(clients.find((row) => row.organizationId === kadikoy.id)?.role).toBe("admin");
  });

  it("summarises each client without leaking another's figures", async () => {
    const db = getAdminDb();
    const [location] = await db
      .insert(schema.locations)
      .values({ organizationId: kadikoy.id, name: "Moda" })
      .returning({ id: schema.locations.id });

    await db.insert(schema.reviews).values({
      organizationId: kadikoy.id,
      locationId: location!.id,
      source: "mock",
      sourceReviewId: `ag-${suffix}`,
      rating: 4,
      text: "İyiydi",
      postedAt: new Date(),
      rawPayload: {},
      status: "open",
    });

    const clients = await listClients(agency.id, operator);
    const client = clients.find((row) => row.organizationId === kadikoy.id);

    expect(client?.locations).toBe(1);
    expect(client?.reviews).toBe(1);
    expect(client?.rating).toBeCloseTo(4, 5);
    expect(client?.openItems).toBe(1);
  });
});

describe("linking", () => {
  it("refuses an organization the person is not a member of", async () => {
    // Otherwise the link table is a way to name any slug and see inside it.
    await expect(
      withTenant({ organizationId: agency.id, userId: operator }, (tx) =>
        linkClient(tx, agency.id, operator, { clientSlug: besiktas.slug, label: null }),
      ),
    ).rejects.toBeInstanceOf(AgencyError);
  });

  it("refuses an organization that does not exist, with the same message", async () => {
    // Distinguishing the two would let an agency probe for slugs.
    const notAMember = withTenant({ organizationId: agency.id, userId: operator }, (tx) =>
      linkClient(tx, agency.id, operator, { clientSlug: besiktas.slug, label: null }),
    ).catch((error: Error) => error.message);

    const notReal = withTenant({ organizationId: agency.id, userId: operator }, (tx) =>
      linkClient(tx, agency.id, operator, { clientSlug: `nope-${suffix}`, label: null }),
    ).catch((error: Error) => error.message);

    expect(await notAMember).toBe(await notReal);
  });

  it("refuses an agency linking itself", async () => {
    await join(agency.id, operator, "admin").catch(() => undefined);
    await expect(
      withTenant({ organizationId: agency.id, userId: operator }, (tx) =>
        linkClient(tx, agency.id, operator, { clientSlug: agency.slug, label: null }),
      ),
    ).rejects.toBeInstanceOf(AgencyError);
  });

  it("links one the person does belong to, and unlinking leaves membership alone", async () => {
    await withTenant({ organizationId: agency.id, userId: operator }, (tx) =>
      linkClient(tx, agency.id, operator, { clientSlug: unrelated.slug, label: "Yan proje" }),
    );

    let clients = await listClients(agency.id, operator);
    expect(clients.find((row) => row.organizationId === unrelated.id)?.label).toBe("Yan proje");

    await withTenant({ organizationId: agency.id, userId: operator }, (tx) =>
      unlinkClient(tx, agency.id, unrelated.id),
    );

    clients = await listClients(agency.id, operator);
    expect(clients.map((row) => row.organizationId)).not.toContain(unrelated.id);

    // Membership is untouched: an agency tidying its console must not be able
    // to lock somebody out of an organization.
    const [membership] = await getAdminDb()
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(eq(schema.memberships.organizationId, unrelated.id));
    expect(membership).toBeDefined();
  });

  it("knows whether an organization is an agency at all", async () => {
    const yes = await withTenant({ organizationId: agency.id }, (tx) => isAgency(tx, agency.id));
    const no = await withTenant({ organizationId: kadikoy.id }, (tx) => isAgency(tx, kadikoy.id));

    expect(yes).toBe(true);
    expect(no).toBe(false);
  });
});

describe("white-label branding", () => {
  it("puts the agency's name on a client's public pages", async () => {
    await getAdminDb()
      .update(schema.organizations)
      .set({
        logo: "https://cdn.example/mercan.svg",
        branding: { senderName: "Mercan Ajans", hidePoweredBy: true },
      })
      .where(eq(schema.organizations.id, agency.id));

    const brand = await resolveBrand(kadikoy.id);

    // The client's customers see the agency, which is what white-label means.
    expect(brand.whiteLabelled).toBe(true);
    expect(brand.name).toBe("Mercan Ajans");
    expect(brand.logoUrl).toBe("https://cdn.example/mercan.svg");
    expect(brand.showPoweredBy).toBe(false);
  });

  it("falls back to the organization's own name when it has no agency", async () => {
    const brand = await resolveBrand(unrelated.id);

    expect(brand.whiteLabelled).toBe(false);
    expect(brand.name).toBe("İlgisiz İşletme");
    // An organization branding its own page is not buying the right to remove
    // our mark, so it cannot switch it off however its blob is written.
    expect(brand.showPoweredBy).toBe(true);
  });

  it("refuses to hide our mark for an organization that only branded itself", async () => {
    await getAdminDb()
      .update(schema.organizations)
      .set({ branding: { senderName: "Kendi Adım", hidePoweredBy: true } })
      .where(eq(schema.organizations.id, unrelated.id));

    const brand = await resolveBrand(unrelated.id);
    expect(brand.name).toBe("Kendi Adım");
    expect(brand.showPoweredBy).toBe(true);
  });

  it("drops the agency's brand when the agency's plan lapses", async () => {
    await getAdminDb()
      .update(schema.subscriptions)
      .set({ status: "canceled" })
      .where(eq(schema.subscriptions.organizationId, agency.id));

    const brand = await resolveBrand(kadikoy.id);

    // Back to the client's own name rather than going blank — a customer must
    // not meet an unbranded page because somebody's card expired.
    expect(brand.whiteLabelled).toBe(false);
    expect(brand.name).toBe("Kadıköy Kahve");
    expect(brand.showPoweredBy).toBe(true);
  });

  it("degrades to Revira for an organization that does not exist", async () => {
    const brand = await resolveBrand("00000000-0000-4000-8000-000000000000");
    expect(brand.name).toBe(DEFAULT_BRAND.name);
    expect(brand.whiteLabelled).toBe(false);
  });

  it("ignores a malformed branding blob rather than failing the page", async () => {
    await getAdminDb()
      .update(schema.organizations)
      .set({ branding: { primaryColor: "not-a-colour", senderName: 42 } })
      .where(eq(schema.organizations.id, unrelated.id));

    const brand = await resolveBrand(unrelated.id);

    // A customer must not see an error because an agency mistyped a colour.
    expect(brand.primaryColor).toBeNull();
    expect(brand.name).toBe("İlgisiz İşletme");
  });
});
