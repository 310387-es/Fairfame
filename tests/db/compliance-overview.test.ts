import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordIysConsent } from "@/compliance/consent";
import { complianceOverview, findContactByIdentifier } from "@/compliance/overview";
import { isRegisteredVia } from "@/compliance/iys-gateway";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";

/**
 * What the compliance page is allowed to claim (positioning win 3).
 *
 * The page exists to be pointed at — `docs/remediation-plan.md` wants it on the
 * pricing page — so the only assertions worth writing are the ones that stop it
 * flattering us.
 *
 * The headline is that **`recorded` and `registered` are different numbers**. A
 * consent accepted by the `local` gateway is captured, stored, and not in the
 * national registry; `iys_uploaded_via` exists on every row since P1b-T5 for
 * exactly this reason, and `isRegisteredVia`'s allowlist is empty until a real
 * BSP adapter lands. A page that added them together would report a compliance
 * posture no deployment currently has.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

let org: string;
let contactId: string;

beforeAll(async () => {
  const db = getAdminDb();

  const [created] = await db
    .insert(schema.organizations)
    .values({ name: `Compliance ${suffix}`, slug: `compliance-${suffix}` })
    .returning({ id: schema.organizations.id });
  org = created!.id;
  orgIds.push(org);

  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: org,
      name: "Ayşe Yılmaz",
      email: `Ayse.${suffix}@Example.COM`,
      phone: "+905321234567",
    })
    .returning({ id: schema.contacts.id });
  contactId = contact!.id;
});

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("complianceOverview", () => {
  it("counts a captured permission as recorded and not as registered", async () => {
    await withTenant({ organizationId: org }, (tx) =>
      recordIysConsent({
        tx,
        organizationId: org,
        contactRef: contactId,
        channel: "message",
        source: "web_form",
      }),
    );

    const overview = await withTenant({ organizationId: org }, (tx) => complianceOverview(tx, org));

    expect(overview.consents.recorded).toBe(1);
    // The whole point. Until a real gateway exists this is zero however many
    // permissions have been captured, and the screen says so.
    expect(overview.consents.registered).toBe(0);
    expect(isRegisteredVia("local")).toBe(false);
  });

  it("puts an un-uploaded permission in the pending queue", async () => {
    const overview = await withTenant({ organizationId: org }, (tx) => complianceOverview(tx, org));

    // Inside its three business days, so pending rather than overdue.
    expect(overview.consents.pending + overview.consents.overdue).toBe(1);
  });

  it("reports the deadline breach rather than hiding it", async () => {
    // The failure mode this guards: a queue that drops rows it has missed looks
    // healthiest exactly when it is worst.
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
    await getAdminDb()
      .update(schema.consentRecords)
      .set({ iysUploadDueAt: past })
      .where(inArray(schema.consentRecords.organizationId, [org]));

    const overview = await withTenant({ organizationId: org }, (tx) => complianceOverview(tx, org));

    expect(overview.consents.overdue).toBe(1);
    expect(overview.consents.pending).toBe(0);
  });

  it("counts an opt-out as a working opt-out, not a failure", async () => {
    await getAdminDb()
      .update(schema.contacts)
      .set({ unsubscribedAt: new Date() })
      .where(inArray(schema.contacts.id, [contactId]));

    const overview = await withTenant({ organizationId: org }, (tx) => complianceOverview(tx, org));

    expect(overview.consents.optedOut).toBe(1);
  });
});

describe("findContactByIdentifier", () => {
  it("finds a person by the email they wrote, whatever the case", async () => {
    const match = await withTenant({ organizationId: org }, (tx) =>
      // A subject request arrives as prose. Nobody types their address back in
      // the casing a database happens to hold it in.
      findContactByIdentifier(tx, org, `  AYSE.${suffix}@example.com `),
    );

    expect(match?.id).toBe(contactId);
  });

  it("finds a person by phone number", async () => {
    const match = await withTenant({ organizationId: org }, (tx) =>
      findContactByIdentifier(tx, org, "+905321234567"),
    );

    expect(match?.id).toBe(contactId);
  });

  it("answers 'nothing held' rather than failing", async () => {
    const match = await withTenant({ organizationId: org }, (tx) =>
      findContactByIdentifier(tx, org, "nobody@example.com"),
    );

    // The most common correct answer to a subject request, and the operator has
    // to be able to give it confidently.
    expect(match).toBeNull();
  });

  it("does not reach into another organization", async () => {
    const [other] = await getAdminDb()
      .insert(schema.organizations)
      .values({ name: `Compliance other ${suffix}`, slug: `compliance-other-${suffix}` })
      .returning({ id: schema.organizations.id });
    orgIds.push(other!.id);

    const match = await withTenant({ organizationId: other!.id }, (tx) =>
      findContactByIdentifier(tx, other!.id, `ayse.${suffix}@example.com`),
    );

    expect(match).toBeNull();
  });
});
