import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNRESTRICTED, resolveLocationScope, setMemberLocations } from "@/auth/scope";
import { recordIysConsent, revokeConsent } from "@/compliance/consent";
import { EMPTY_CONTACT_FILTERS, type ContactFilterState } from "@/contacts/filters";
import { countContacts, getContact, listContacts } from "@/contacts/queries";
import { createSegment, deleteSegment, listSegments, SegmentError } from "@/contacts/segments";
import {
  addContactTag,
  ContactTagError,
  listContactTags,
  MAX_TAGS_PER_CONTACT,
  removeContactTag,
} from "@/contacts/tags";
import { importContacts } from "@/contacts/import";
import { contactTimeline } from "@/contacts/timeline";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { EntitlementError } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";
import { subscribeToPlanWith } from "./plan-fixture";

/**
 * Contacts / light CRM (P4-T1).
 *
 * Two organizations built to be confusable — the same customer names, the same
 * branch names, the same tags — because an isolation test that uses "Org A" and
 * "Org B" passes for a query that is leaking, as long as the ids happen to line
 * up. Everything here is asserted by *content*, not only by id.
 *
 * The headline is **location scope**. `contacts` has no `location_id`, so RLS
 * says nothing about a member pinned to one branch, and the failure mode is one
 * an admin can never see: a screen that looks correct to the unrestricted person
 * testing it and shows the whole customer file to the member it was meant to
 * restrict.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

type Org = {
  id: string;
  kadikoy: string;
  besiktas: string;
  /** A contact who has only ever dealt with Kadıköy. */
  ayse: string;
  /** A contact who has only ever dealt with Beşiktaş. */
  mehmet: string;
  /** Imported by hand: no request, no branch, no way to attribute them. */
  orphan: string;
  campaign: string;
};

let alpha: Org;
let beta: Org;
/** Unrestricted admin of alpha. */
let admin: string;
/** Pinned to Kadıköy. */
let scoped: string;
/** A `client`, pinned to nothing: the role whose empty default means nothing. */
let client: string;

async function makeOrg(label: string): Promise<Org> {
  const db = getAdminDb();

  const [org] = await db
    .insert(schema.organizations)
    .values({ name: `Contacts ${label} ${suffix}`, slug: `contacts-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);
  await subscribeToPlanWith(org.id, ["crm"]);

  const locations = await db
    .insert(schema.locations)
    .values([
      { organizationId: org.id, name: "Kadıköy Şubesi" },
      { organizationId: org.id, name: "Beşiktaş Şubesi" },
    ])
    .returning({ id: schema.locations.id });

  const kadikoy = locations[0]!.id;
  const besiktas = locations[1]!.id;

  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      organizationId: org.id,
      locationId: kadikoy,
      name: "Yorum daveti",
      slug: `c-${label}-${suffix}`,
    })
    .returning({ id: schema.campaigns.id });

  // Deliberately identical names and shapes across both organizations.
  const contacts = await db
    .insert(schema.contacts)
    .values([
      { organizationId: org.id, name: "Şule Yılmaz", email: `ayse-${label}-${suffix}@example.com` },
      {
        organizationId: org.id,
        name: "Mehmet Demir",
        phone: `+9053${label === "alpha" ? 1 : 2}${suffix.slice(0, 6)}`,
      },
      {
        organizationId: org.id,
        name: "Kayıtsız Kişi",
        email: `orphan-${label}-${suffix}@example.com`,
      },
    ])
    .returning({ id: schema.contacts.id });

  const ayse = contacts[0]!.id;
  const mehmet = contacts[1]!.id;
  const orphan = contacts[2]!.id;

  // The interaction rows that attach a contact to a branch.
  await db.insert(schema.reviewRequests).values([
    {
      organizationId: org.id,
      campaignId: campaign!.id,
      locationId: kadikoy,
      contactId: ayse,
      channel: "email",
      status: "sent",
      token: `t-a-${label}-${suffix}`,
      sentAt: new Date("2026-07-01T09:00:00Z"),
      openedAt: new Date("2026-07-01T10:00:00Z"),
    },
    {
      organizationId: org.id,
      campaignId: campaign!.id,
      locationId: besiktas,
      contactId: mehmet,
      channel: "whatsapp",
      status: "sent",
      token: `t-m-${label}-${suffix}`,
      sentAt: new Date("2026-07-02T09:00:00Z"),
    },
  ]);

  return { id: org.id, kadikoy, besiktas, ayse, mehmet, orphan, campaign: campaign!.id };
}

async function addUser(organizationId: string, label: string, role: "admin" | "member" | "client") {
  const db = getAdminDb();
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${label}-${suffix}@example.com`, name: label })
    .returning({ id: schema.users.id });
  userIds.push(user!.id);

  await db.insert(schema.memberships).values({ organizationId, userId: user!.id, role });

  return user!.id;
}

const filters = (overrides: Partial<ContactFilterState> = {}): ContactFilterState => ({
  ...EMPTY_CONTACT_FILTERS,
  ...overrides,
});

beforeAll(async () => {
  alpha = await makeOrg("alpha");
  beta = await makeOrg("beta");

  admin = await addUser(alpha.id, "crm-admin", "admin");
  scoped = await addUser(alpha.id, "crm-scoped", "member");
  client = await addUser(alpha.id, "crm-client", "client");

  await withTenant({ organizationId: alpha.id, userId: admin }, (tx) =>
    setMemberLocations(
      tx,
      { organizationId: alpha.id, role: "admin" },
      { userId: scoped, locationIds: [alpha.kadikoy] },
    ),
  );
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

describe("tenant isolation", () => {
  it("never returns another organization's contacts, by id or by content", async () => {
    const betaNames = await withTenant({ organizationId: beta.id }, async (tx) => {
      const page = await listContacts({
        tx,
        organizationId: beta.id,
        scope: UNRESTRICTED,
        filters: filters(),
        page: 1,
      });
      return page.rows;
    });

    const alphaPage = await withTenant({ organizationId: alpha.id }, (tx) =>
      listContacts({
        tx,
        organizationId: alpha.id,
        scope: UNRESTRICTED,
        filters: filters(),
        page: 1,
      }),
    );

    // Both organizations hold a "Şule Yılmaz", so an id check alone would pass
    // for a query returning the wrong one.
    expect(alphaPage.rows).toHaveLength(3);
    expect(betaNames).toHaveLength(3);

    const alphaIds = new Set(alphaPage.rows.map((row) => row.id));
    for (const row of betaNames) expect(alphaIds.has(row.id)).toBe(false);

    const alphaEmails = alphaPage.rows.map((row) => row.email).join(" ");
    expect(alphaEmails).toContain("alpha");
    expect(alphaEmails).not.toContain("beta");
  });

  it("refuses another organization's contact by id", async () => {
    const found = await withTenant({ organizationId: alpha.id }, (tx) =>
      getContact({
        tx,
        organizationId: alpha.id,
        scope: UNRESTRICTED,
        contactId: beta.ayse,
      }),
    );

    expect(found).toBeNull();
  });
});

describe("derived columns", () => {
  /**
   * The assertion that was missing, and the bug it now pins.
   *
   * `last activity` and `reviews left` are correlated subqueries in the SELECT
   * projection, and Drizzle renders a column interpolated there *unqualified*
   * — so `where rr.contact_id = ${contacts.id}` became
   * `where rr.contact_id = "id"`, which inside the subquery resolves to
   * `rr.id`. Every row came back null and zero, with no error anywhere. Every
   * other test in this file passed, because the same interpolation renders
   * correctly in a WHERE clause. Only the screen showed it.
   */
  it("reports when something last happened, and how many reviews were left", async () => {
    const rows = await withTenant({ organizationId: alpha.id }, (tx) =>
      listContacts({
        tx,
        organizationId: alpha.id,
        scope: UNRESTRICTED,
        filters: filters(),
        page: 1,
      }),
    );

    const ayse = rows.rows.find((row) => row.id === alpha.ayse);
    expect(ayse?.lastActivityAt).toBeInstanceOf(Date);
    expect(ayse?.lastActivityAt?.getFullYear()).toBeGreaterThan(2000);

    // Nobody has left a review; the count is a real zero rather than the
    // accidental one the broken correlation produced.
    expect(ayse?.reviewCount).toBe(0);

    // The contact with no request at all genuinely has no activity — which is
    // the state the bug made every row look like.
    const orphan = rows.rows.find((row) => row.id === alpha.orphan);
    expect(orphan?.lastActivityAt).toBeNull();
  });

  it("counts a review once the ask produces one", async () => {
    const db = getAdminDb();
    const [review] = await db
      .insert(schema.reviews)
      .values({
        organizationId: alpha.id,
        locationId: alpha.kadikoy,
        source: "firstparty",
        sourceReviewId: `r-${suffix}`,
        rating: 5,
        text: "Harika bir deneyimdi.",
        postedAt: new Date("2026-07-03T12:00:00Z"),
        rawPayload: {},
      })
      .returning({ id: schema.reviews.id });

    await db
      .update(schema.reviewRequests)
      .set({ reviewId: review!.id, submittedAt: new Date("2026-07-03T12:00:00Z") })
      .where(eq(schema.reviewRequests.contactId, alpha.ayse));

    const rows = await withTenant({ organizationId: alpha.id }, (tx) =>
      listContacts({
        tx,
        organizationId: alpha.id,
        scope: UNRESTRICTED,
        filters: filters(),
        page: 1,
      }),
    );

    expect(rows.rows.find((row) => row.id === alpha.ayse)?.reviewCount).toBe(1);
  });
});

describe("location scope", () => {
  it("shows an unrestricted member everyone, including a contact with no branch", async () => {
    const rows = await withTenant({ organizationId: alpha.id, userId: admin }, async (tx) => {
      const scope = await resolveLocationScope(tx, alpha.id, admin, "admin");
      return listContacts({
        tx,
        organizationId: alpha.id,
        scope,
        filters: filters(),
        page: 1,
      });
    });

    expect(rows.rows.map((row) => row.id).sort()).toEqual(
      [alpha.ayse, alpha.mehmet, alpha.orphan].sort(),
    );
  });

  it("narrows a pinned member to the branches they were given", async () => {
    const rows = await withTenant({ organizationId: alpha.id, userId: scoped }, async (tx) => {
      const scope = await resolveLocationScope(tx, alpha.id, scoped, "member");
      return listContacts({
        tx,
        organizationId: alpha.id,
        scope,
        filters: filters(),
        page: 1,
      });
    });

    // Kadıköy only. The Beşiktaş customer and the unattributable import are
    // both out — the second because there is no branch to attribute them to,
    // and guessing would be the leak.
    expect(rows.rows.map((row) => row.id)).toEqual([alpha.ayse]);
    expect(rows.total).toBe(1);
  });

  it("returns nothing — not everything — for a scope pinned to nothing", async () => {
    const rows = await withTenant({ organizationId: alpha.id, userId: client }, async (tx) => {
      const scope = await resolveLocationScope(tx, alpha.id, client, "client");
      expect(scope).toEqual({ all: false, locationIds: [] });

      return listContacts({
        tx,
        organizationId: alpha.id,
        scope,
        filters: filters(),
        page: 1,
      });
    });

    expect(rows.rows).toEqual([]);
    expect(rows.total).toBe(0);
  });

  it("hides by URL exactly what it hides from the list", async () => {
    // The bug this exists to catch: a row filtered out of the list that is
    // still readable by pasting its id into the address bar.
    const found = await withTenant({ organizationId: alpha.id, userId: scoped }, async (tx) => {
      const scope = await resolveLocationScope(tx, alpha.id, scoped, "member");
      return getContact({ tx, organizationId: alpha.id, scope, contactId: alpha.mehmet });
    });

    expect(found).toBeNull();
  });

  it("counts a segment through the reader's own scope", async () => {
    const [wide, narrow] = await withTenant(
      { organizationId: alpha.id, userId: admin },
      async (tx) => [
        await countContacts({
          tx,
          organizationId: alpha.id,
          scope: UNRESTRICTED,
          filters: filters(),
        }),
        await countContacts({
          tx,
          organizationId: alpha.id,
          scope: { all: false, locationIds: [alpha.kadikoy] },
          filters: filters(),
        }),
      ],
    );

    expect(wide).toBe(3);
    expect(narrow).toBe(1);
  });
});

describe("filters", () => {
  it("finds a Turkish name typed without its diacritics", async () => {
    // "Sule" must find "Şule". A customer list that cannot do that in the
    // launch market is a list people scroll instead of searching.
    const rows = await withTenant({ organizationId: alpha.id }, (tx) =>
      listContacts({
        tx,
        organizationId: alpha.id,
        scope: UNRESTRICTED,
        filters: filters({ query: "sule" }),
        page: 1,
      }),
    );

    expect(rows.rows.map((row) => row.id)).toEqual([alpha.ayse]);
  });

  it("matches across name, email and phone rather than within one field", async () => {
    const rows = await withTenant({ organizationId: alpha.id }, (tx) =>
      listContacts({
        tx,
        organizationId: alpha.id,
        scope: UNRESTRICTED,
        filters: filters({ query: `Yılmaz ayse-alpha-${suffix}` }),
        page: 1,
      }),
    );

    expect(rows.rows.map((row) => row.id)).toEqual([alpha.ayse]);
  });

  it("narrows to a branch without widening past the scope", async () => {
    const rows = await withTenant({ organizationId: alpha.id }, (tx) =>
      listContacts({
        tx,
        organizationId: alpha.id,
        // Pinned to Kadıköy, asking for Beşiktaş: the answer is nobody, not
        // "everyone in Beşiktaş".
        scope: { all: false, locationIds: [alpha.kadikoy] },
        filters: filters({ locationId: alpha.besiktas }),
        page: 1,
      }),
    );

    expect(rows.rows).toEqual([]);
  });

  it("filters on a live consent record and drops a withdrawn one", async () => {
    await withTenant({ organizationId: alpha.id }, async (tx) => {
      await recordIysConsent({
        tx,
        organizationId: alpha.id,
        contactRef: alpha.ayse,
        channel: "message",
        source: "web_form",
        proofRef: "test",
      });
      await recordIysConsent({
        tx,
        organizationId: alpha.id,
        contactRef: alpha.mehmet,
        channel: "message",
        source: "web_form",
        proofRef: "test",
      });
    });

    const before = await withTenant({ organizationId: alpha.id }, (tx) =>
      listContacts({
        tx,
        organizationId: alpha.id,
        scope: UNRESTRICTED,
        filters: filters({ consent: "message" }),
        page: 1,
      }),
    );
    expect(before.rows.map((row) => row.id).sort()).toEqual([alpha.ayse, alpha.mehmet].sort());

    await withTenant({ organizationId: alpha.id }, (tx) =>
      revokeConsent({ tx, organizationId: alpha.id, contactRef: alpha.mehmet }),
    );

    const after = await withTenant({ organizationId: alpha.id }, (tx) =>
      listContacts({
        tx,
        organizationId: alpha.id,
        scope: UNRESTRICTED,
        filters: filters({ consent: "message" }),
        page: 1,
      }),
    );

    // `revoked_at` is decisive here for the same reason it is in the gate: a
    // withdrawn permission that still reads as granted is how somebody who
    // said stop ends up in an audience.
    expect(after.rows.map((row) => row.id)).toEqual([alpha.ayse]);

    // And a consent granted in one organization never widens another's list.
    const other = await withTenant({ organizationId: beta.id }, (tx) =>
      listContacts({
        tx,
        organizationId: beta.id,
        scope: UNRESTRICTED,
        filters: filters({ consent: "message" }),
        page: 1,
      }),
    );
    expect(other.rows).toEqual([]);
  });

  it("separates 'has an address' from 'has a permission'", async () => {
    const rows = await withTenant({ organizationId: alpha.id }, (tx) =>
      listContacts({
        tx,
        organizationId: alpha.id,
        scope: UNRESTRICTED,
        filters: filters({ channel: "phone" }),
        page: 1,
      }),
    );

    expect(rows.rows.map((row) => row.id)).toEqual([alpha.mehmet]);
  });
});

describe("tags", () => {
  it("adopts the label the organization already uses", async () => {
    const applied = await withTenant({ organizationId: alpha.id }, async (tx) => {
      await addContactTag(tx, {
        organizationId: alpha.id,
        contactId: alpha.ayse,
        label: "VIP",
        userId: admin,
      });

      // A different spelling of the same word, on somebody else.
      return addContactTag(tx, {
        organizationId: alpha.id,
        contactId: alpha.mehmet,
        label: "  vip ",
        userId: admin,
      });
    });

    expect(applied).toEqual({ slug: "vip", label: "VIP" });

    const vocabulary = await withTenant({ organizationId: alpha.id }, (tx) =>
      listContactTags(tx, alpha.id),
    );
    expect(vocabulary).toEqual([{ slug: "vip", label: "VIP", contactCount: 2 }]);
  });

  it("normalises Turkish so one label is one tag", async () => {
    const [first, second] = await withTenant({ organizationId: alpha.id }, async (tx) => [
      await addContactTag(tx, {
        organizationId: alpha.id,
        contactId: alpha.ayse,
        label: "Şikayet",
        userId: admin,
      }),
      await addContactTag(tx, {
        organizationId: alpha.id,
        contactId: alpha.mehmet,
        label: "sikayet",
        userId: admin,
      }),
    ]);

    expect(first!.slug).toBe("sikayet");
    expect(second!.slug).toBe("sikayet");
    // The first spelling wins, because it is the one already in use.
    expect(second!.label).toBe("Şikayet");
  });

  it("filters on every tag asked for, not any of them", async () => {
    const both = await withTenant({ organizationId: alpha.id }, (tx) =>
      listContacts({
        tx,
        organizationId: alpha.id,
        scope: UNRESTRICTED,
        filters: filters({ tags: ["vip", "sikayet"] }),
        page: 1,
      }),
    );

    expect(both.rows.map((row) => row.id).sort()).toEqual([alpha.ayse, alpha.mehmet].sort());

    await withTenant({ organizationId: alpha.id }, (tx) =>
      removeContactTag(tx, {
        organizationId: alpha.id,
        contactId: alpha.mehmet,
        slug: "sikayet",
      }),
    );

    const narrowed = await withTenant({ organizationId: alpha.id }, (tx) =>
      listContacts({
        tx,
        organizationId: alpha.id,
        scope: UNRESTRICTED,
        filters: filters({ tags: ["vip", "sikayet"] }),
        page: 1,
      }),
    );
    expect(narrowed.rows.map((row) => row.id)).toEqual([alpha.ayse]);
  });

  it("never shows one organization's vocabulary to another", async () => {
    const vocabulary = await withTenant({ organizationId: beta.id }, (tx) =>
      listContactTags(tx, beta.id),
    );
    expect(vocabulary).toEqual([]);
  });

  it("refuses a label that normalises to nothing", async () => {
    await expect(
      withTenant({ organizationId: alpha.id }, (tx) =>
        addContactTag(tx, {
          organizationId: alpha.id,
          contactId: alpha.orphan,
          label: "!!!",
          userId: admin,
        }),
      ),
    ).rejects.toBeInstanceOf(ContactTagError);
  });

  it("caps a contact's tags, but still lets an existing one be re-applied", async () => {
    await withTenant({ organizationId: alpha.id }, async (tx) => {
      for (let index = 0; index < MAX_TAGS_PER_CONTACT; index += 1) {
        await addContactTag(tx, {
          organizationId: alpha.id,
          contactId: alpha.orphan,
          label: `etiket-${index}`,
          userId: admin,
        });
      }

      await expect(
        addContactTag(tx, {
          organizationId: alpha.id,
          contactId: alpha.orphan,
          label: "bir-tane-daha",
          userId: admin,
        }),
      ).rejects.toBeInstanceOf(ContactTagError);

      // Re-applying one it already carries is a no-op, not a cap failure.
      const again = await addContactTag(tx, {
        organizationId: alpha.id,
        contactId: alpha.orphan,
        label: "etiket-0",
        userId: admin,
      });
      expect(again.slug).toBe("etiket-0");
    });
  });
});

describe("segments", () => {
  it("round-trips the filters it was saved with", async () => {
    const saved = filters({ tags: ["vip"], consent: "message", sort: "name" });

    const created = await withTenant({ organizationId: alpha.id, userId: admin }, (tx) =>
      createSegment(tx, {
        organizationId: alpha.id,
        userId: admin,
        role: "admin",
        name: "Mesaj izinli VIP",
        filters: saved,
      }),
    );

    const listed = await withTenant({ organizationId: alpha.id }, (tx) =>
      listSegments(tx, alpha.id),
    );
    const found = listed.find((segment) => segment.id === created.id);

    expect(found?.filters).toEqual(saved);
    expect(found?.href).toBe("/contacts?tag=vip&consent=message&sort=name");
  });

  it("updates rather than failing when the name is reused", async () => {
    await withTenant({ organizationId: alpha.id, userId: admin }, (tx) =>
      createSegment(tx, {
        organizationId: alpha.id,
        userId: admin,
        role: "admin",
        name: "Mesaj izinli VIP",
        filters: filters({ tags: ["sikayet"] }),
      }),
    );

    const listed = await withTenant({ organizationId: alpha.id }, (tx) =>
      listSegments(tx, alpha.id),
    );
    const matching = listed.filter((segment) => segment.name === "Mesaj izinli VIP");

    expect(matching).toHaveLength(1);
    expect(matching[0]!.filters.tags).toEqual(["sikayet"]);
  });

  it("is organization-level, so a member may not create or delete one", async () => {
    await expect(
      withTenant({ organizationId: alpha.id, userId: scoped }, (tx) =>
        createSegment(tx, {
          organizationId: alpha.id,
          userId: scoped,
          role: "member",
          name: "Benim listem",
          filters: filters({ tags: ["vip"] }),
        }),
      ),
    ).rejects.toBeInstanceOf(SegmentError);

    const listed = await withTenant({ organizationId: alpha.id }, (tx) =>
      listSegments(tx, alpha.id),
    );

    await expect(
      withTenant({ organizationId: alpha.id, userId: scoped }, (tx) =>
        deleteSegment(tx, { organizationId: alpha.id, role: "member", id: listed[0]!.id }),
      ),
    ).rejects.toBeInstanceOf(SegmentError);
  });

  it("never lists another organization's segments", async () => {
    const listed = await withTenant({ organizationId: beta.id }, (tx) => listSegments(tx, beta.id));
    expect(listed).toEqual([]);
  });
});

describe("entitlement", () => {
  it("refuses a segment on a plan without the CRM", async () => {
    const db = getAdminDb();
    const [org] = await db
      .insert(schema.organizations)
      .values({ name: `Contacts floor ${suffix}`, slug: `contacts-floor-${suffix}` })
      .returning({ id: schema.organizations.id });
    orgIds.push(org!.id);
    // No subscription at all, so the organization sits on the floor plan.

    await expect(
      withTenant({ organizationId: org!.id }, (tx) =>
        createSegment(tx, {
          organizationId: org!.id,
          userId: admin,
          role: "admin",
          name: "Herhangi",
          filters: filters({ tags: ["vip"] }),
        }),
      ),
    ).rejects.toBeInstanceOf(EntitlementError);
  });
});

describe("timeline", () => {
  it("puts every source in one list, newest first", async () => {
    const events = await withTenant({ organizationId: alpha.id }, async (tx) => {
      const contact = await getContact({
        tx,
        organizationId: alpha.id,
        scope: UNRESTRICTED,
        contactId: alpha.ayse,
      });
      return contactTimeline(tx, alpha.id, contact!);
    });

    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("request_sent");
    expect(kinds).toContain("request_opened");
    expect(kinds).toContain("consent_granted");
    // The anchor: everybody has a moment they became a contact.
    expect(kinds).toContain("created");

    for (let index = 1; index < events.length; index += 1) {
      expect(events[index - 1]!.at.getTime()).toBeGreaterThanOrEqual(events[index]!.at.getTime());
    }
  });

  it("keeps a withdrawal and the grant that preceded it", async () => {
    // Losing the grant would lose the half a business has to be able to prove.
    const events = await withTenant({ organizationId: alpha.id }, async (tx) => {
      const contact = await getContact({
        tx,
        organizationId: alpha.id,
        scope: UNRESTRICTED,
        contactId: alpha.mehmet,
      });
      return contactTimeline(tx, alpha.id, contact!);
    });

    expect(events.map((event) => event.kind)).toContain("consent_granted");
    expect(events.map((event) => event.kind)).toContain("consent_revoked");
  });

  it("carries nothing from another organization", async () => {
    const events = await withTenant({ organizationId: beta.id }, async (tx) => {
      const contact = await getContact({
        tx,
        organizationId: beta.id,
        scope: UNRESTRICTED,
        contactId: beta.ayse,
      });
      return contactTimeline(tx, beta.id, contact!);
    });

    // Beta's Şule was asked once, at beta's own branch, and has no consent.
    expect(events.filter((event) => event.kind === "consent_granted")).toHaveLength(0);
    const sent = events.find((event) => event.kind === "request_sent");
    expect(sent && "locationName" in sent ? sent.locationName : null).toBe("Kadıköy Şubesi");
  });
});

/**
 * A22-C2 — adding one person by hand.
 *
 * `/contacts` could only be filled from a CSV. The obvious implementation — an
 * insert in the action — would have been a second definition of what adding a
 * contact means, and the rule it would most easily drift from is the one that
 * matters: **an import grants no permission**. So it is a one-row import, and
 * these assert the properties that come with that rather than the button.
 */
describe("adding a contact by hand", () => {
  it("creates the person and no permission at all", async () => {
    const org = await makeOrg("manual-add");

    await withTenant({ organizationId: org.id }, (tx) =>
      importContacts(tx, org.id, [{ email: "yeni@ornek.com", phone: null, name: "Yeni Kişi" }]),
    );

    // By address, not by organization: `makeOrg` seeds a list of its own, and
    // the claim here is about the row this call added.
    const [contact] = await getAdminDb()
      .select({ id: schema.contacts.id, name: schema.contacts.name })
      .from(schema.contacts)
      .where(eq(schema.contacts.email, "yeni@ornek.com"));

    expect(contact?.name).toBe("Yeni Kişi");

    // The whole reason this goes through the import: a contact record is not
    // permission, and `checkSendAllowed` still has nothing to say yes to.
    const consents = await getAdminDb()
      .select({ id: schema.consentRecords.id })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.contactRef, contact!.id));

    expect(consents).toEqual([]);
  });

  it("fills a gap rather than making a second row for the same person", async () => {
    const org = await makeOrg("manual-merge");

    await withTenant({ organizationId: org.id }, (tx) =>
      importContacts(tx, org.id, [{ email: "ayse@ornek.com", phone: null, name: null }]),
    );
    await withTenant({ organizationId: org.id }, (tx) =>
      importContacts(tx, org.id, [
        { email: "ayse@ornek.com", phone: "905321112233", name: "Ayşe" },
      ]),
    );

    const rows = await getAdminDb()
      .select({ name: schema.contacts.name, phone: schema.contacts.phone })
      .from(schema.contacts)
      .where(eq(schema.contacts.email, "ayse@ornek.com"));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Ayşe");
    expect(rows[0]?.phone).toBe("905321112233");
  });

  it("refuses somebody with neither an address nor a number", async () => {
    const org = await makeOrg("manual-neither");

    const result = await withTenant({ organizationId: org.id }, (tx) =>
      importContacts(tx, org.id, [{ email: null, phone: null, name: "Kimse" }]),
    );

    // Counted rather than thrown: the table's own constraint says the same
    // thing, and turning it into a number is what lets a screen report it.
    expect(result).toEqual({ created: 0, updated: 0, skipped: 1 });
  });
});
