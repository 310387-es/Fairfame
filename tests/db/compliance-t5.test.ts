import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { iysUploadDeadline } from "@/compliance/business-days";
import {
  markUploadFailed,
  markUploaded,
  overdueUploadCount,
  pendingIysUploads,
  recordIysConsent,
  revokeConsent,
} from "@/compliance/consent";
import { checkSendAllowed, setIysGateway } from "@/compliance/gate";
import { createLocalGateway } from "@/compliance/iys-gateway";
import { eraseSubject, exportSubject } from "@/compliance/subject-rights";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";

/**
 * The compliance layer (P1b-T5).
 *
 * Three obligations, each with a different failure mode:
 *
 *   - **İYS consent** — sending without it is fineable, and the three-business-
 *     day upload window is itself an obligation regardless of whether anything
 *     was sent.
 *   - **Withdrawal** — must be honoured immediately and must remain provable,
 *     which means never deleting the record.
 *   - **KVKK export and erasure** — a legal right with a deadline, and erasure
 *     has to leave the business's own history intact without leaving the person
 *     identifiable in it.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

const IYS_ON = { IYS_REQUIRED: true };

type Fixture = { orgId: string; contactId: string; locationId: string };

async function makeFixture(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `T5 ${label} ${suffix}`, slug: `t5-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: "Şube" })
    .returning({ id: schema.locations.id });

  const [contact] = await getAdminDb()
    .insert(schema.contacts)
    .values({
      organizationId: org.id,
      name: "Mehmet Demir",
      email: `t5-${counter}-${suffix}@example.test`,
      phone: `9053100${String(counter++).padStart(5, "0")}`,
      locale: "tr",
    })
    .returning({ id: schema.contacts.id });

  return { orgId: org.id, contactId: contact!.id, locationId: location!.id };
}

function inTenant<T>(
  fixture: Fixture,
  fn: (tx: Parameters<typeof exportSubject>[0]) => Promise<T>,
) {
  return withTenant({ organizationId: fixture.orgId }, fn);
}

afterEach(() => {
  setIysGateway(null);
});

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("recording İYS consent", () => {
  it("stores the channel, the source and the proof", async () => {
    const fixture = await makeFixture("record");

    await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "submission:abc",
      }),
    );

    const [row] = await getAdminDb()
      .select()
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.organizationId, fixture.orgId));

    // İYS requires a business to prove *how* a permission was obtained. "We
    // have a row" is not proof; the source and the artefact are.
    expect(row?.type).toBe("iys");
    expect(row?.channel).toBe("message");
    expect(row?.source).toBe("web_form");
    expect(row?.proofRef).toBe("submission:abc");
  });

  it("sets the three-business-day deadline", async () => {
    const fixture = await makeFixture("deadline");
    const collectedAt = new Date("2026-05-25T09:00:00+03:00");

    const { dueAt } = await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "p",
        now: collectedAt,
      }),
    );

    // Kurban Bayramı sits in the way; the deadline is nine calendar days out.
    expect(dueAt.toISOString()).toBe(iysUploadDeadline(collectedAt).toISOString());
    expect(dueAt.toISOString().slice(0, 10)).toBe("2026-06-03");
  });

  it("keeps message and call permissions apart", async () => {
    const fixture = await makeFixture("channels");

    for (const channel of ["message", "call"] as const) {
      await inTenant(fixture, (tx) =>
        recordIysConsent({
          tx,
          organizationId: fixture.orgId,
          contactRef: fixture.contactId,
          channel,
          source: "in_person",
          proofRef: "p",
        }),
      );
    }

    const rows = await getAdminDb()
      .select()
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.organizationId, fixture.orgId));

    // Someone may accept messages and refuse calls. One blanket row would mean
    // either over-claiming or under-using what they actually gave.
    expect(rows).toHaveLength(2);
  });

  it("treats a re-grant after withdrawal as a new permission", async () => {
    const fixture = await makeFixture("regrant");

    await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "first",
      }),
    );
    await inTenant(fixture, (tx) =>
      revokeConsent({ tx, organizationId: fixture.orgId, contactRef: fixture.contactId }),
    );
    await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "second",
      }),
    );

    const [row] = await getAdminDb()
      .select()
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.organizationId, fixture.orgId));

    // A new permission with a new upload clock, not a resurrection of the old.
    expect(row?.revokedAt).toBeNull();
    expect(row?.proofRef).toBe("second");
    expect(row?.iysUploadedAt).toBeNull();
  });
});

describe("withdrawal", () => {
  it("marks the record rather than deleting it", async () => {
    const fixture = await makeFixture("revoke");

    await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "p",
      }),
    );

    const revoked = await inTenant(fixture, (tx) =>
      revokeConsent({ tx, organizationId: fixture.orgId, contactRef: fixture.contactId }),
    );

    const rows = await getAdminDb()
      .select()
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.organizationId, fixture.orgId));

    // The obligation is to prove the state of a permission over time. A deleted
    // row proves nothing — including that the person said no.
    expect(revoked).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).not.toBeNull();
  });

  it("covers every channel when none is named", async () => {
    const fixture = await makeFixture("revoke-all");

    for (const channel of ["message", "call", "email"] as const) {
      await inTenant(fixture, (tx) =>
        recordIysConsent({
          tx,
          organizationId: fixture.orgId,
          contactRef: fixture.contactId,
          channel,
          source: "in_person",
          proofRef: "p",
        }),
      );
    }

    // A person saying "stop" has not distinguished between calls and messages.
    const revoked = await inTenant(fixture, (tx) =>
      revokeConsent({ tx, organizationId: fixture.orgId, contactRef: fixture.contactId }),
    );

    expect(revoked).toBe(3);
  });

  it("keeps the first withdrawal's date", async () => {
    const fixture = await makeFixture("revoke-twice");
    const first = new Date("2026-07-01T10:00:00Z");

    await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "p",
      }),
    );
    await inTenant(fixture, (tx) =>
      revokeConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        now: first,
      }),
    );
    await inTenant(fixture, (tx) =>
      revokeConsent({ tx, organizationId: fixture.orgId, contactRef: fixture.contactId }),
    );

    const [row] = await getAdminDb()
      .select()
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.organizationId, fixture.orgId));

    // Re-stamping would move a date the business may have to defend.
    expect(row?.revokedAt?.toISOString()).toBe(first.toISOString());
  });

  it("stops a send that was previously allowed", async () => {
    const fixture = await makeFixture("revoke-blocks");
    setIysGateway(createLocalGateway("development"));

    // İYS consent, because that is what authorises a commercial send where
    // İYS applies.
    await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "p",
      }),
    );

    const before = await inTenant(fixture, (tx) =>
      checkSendAllowed(
        {
          tx,
          organizationId: fixture.orgId,
          contactId: fixture.contactId,
          intent: "commercial",
          channel: "whatsapp",
        },
        IYS_ON,
      ),
    );
    expect(before.allowed).toBe(true);

    await inTenant(fixture, (tx) =>
      revokeConsent({ tx, organizationId: fixture.orgId, contactRef: fixture.contactId }),
    );

    const after = await inTenant(fixture, (tx) =>
      checkSendAllowed(
        {
          tx,
          organizationId: fixture.orgId,
          contactId: fixture.contactId,
          intent: "commercial",
          channel: "whatsapp",
        },
        IYS_ON,
      ),
    );

    expect(after).toMatchObject({ allowed: false, reason: "opted_out" });
  });
});

describe("the upload queue", () => {
  it("lists outstanding consents, most urgent first", async () => {
    const fixture = await makeFixture("queue");

    await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "p",
      }),
    );

    const pending = await inTenant(fixture, (tx) => pendingIysUploads(tx, fixture.orgId));

    expect(pending).toHaveLength(1);
    expect(pending[0]?.overdue).toBe(false);
  });

  it("keeps an overdue consent in the queue rather than hiding it", async () => {
    const fixture = await makeFixture("overdue");
    const longAgo = new Date("2026-01-05T09:00:00+03:00");

    await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "p",
        now: longAgo,
      }),
    );

    const pending = await inTenant(fixture, (tx) => pendingIysUploads(tx, fixture.orgId));
    const overdue = await inTenant(fixture, (tx) => overdueUploadCount(tx, fixture.orgId));

    // An obligation that has been missed still has to be discharged. Hiding it
    // would make the queue look healthy exactly when it is not.
    expect(pending[0]?.overdue).toBe(true);
    expect(overdue).toBe(1);
  });

  it("drops a consent from the queue once uploaded", async () => {
    const fixture = await makeFixture("uploaded");

    await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "p",
      }),
    );

    const [pending] = await inTenant(fixture, (tx) => pendingIysUploads(tx, fixture.orgId));
    await inTenant(fixture, (tx) => markUploaded(tx, fixture.orgId, [pending!.id]));

    expect(await inTenant(fixture, (tx) => pendingIysUploads(tx, fixture.orgId))).toEqual([]);
  });

  it("leaves a failed upload queued, with the reason", async () => {
    const fixture = await makeFixture("upload-failed");

    await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "p",
      }),
    );

    const [pending] = await inTenant(fixture, (tx) => pendingIysUploads(tx, fixture.orgId));
    await inTenant(fixture, (tx) =>
      markUploadFailed(tx, fixture.orgId, pending!.id, "gateway timeout"),
    );

    const still = await inTenant(fixture, (tx) => pendingIysUploads(tx, fixture.orgId));
    expect(still).toHaveLength(1);

    const [row] = await getAdminDb()
      .select({ error: schema.consentRecords.iysUploadError })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.id, pending!.id));
    expect(row?.error).toBe("gateway timeout");
  });

  it("excludes a withdrawn consent", async () => {
    const fixture = await makeFixture("queue-revoked");

    await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "p",
      }),
    );
    await inTenant(fixture, (tx) =>
      revokeConsent({ tx, organizationId: fixture.orgId, contactRef: fixture.contactId }),
    );

    // Uploading a permission the person has already withdrawn would register a
    // consent that does not exist.
    expect(await inTenant(fixture, (tx) => pendingIysUploads(tx, fixture.orgId))).toEqual([]);
  });
});

describe("the local gateway", () => {
  it("allows in development", async () => {
    const gateway = createLocalGateway("development");
    expect(await gateway.check({ organizationId: "o", contactRef: "c", channel: "whatsapp" })).toBe(
      "allowed",
    );
  });

  it("refuses in production", async () => {
    // İYS is the system of record; a local consent record is not a substitute.
    // A guard rather than a comment, because "we will remember to change the
    // env var" is not a control.
    const gateway = createLocalGateway("production");
    expect(await gateway.check({ organizationId: "o", contactRef: "c", channel: "whatsapp" })).toBe(
      "not_configured",
    );
  });
});

describe("KVKK export", () => {
  it("returns everything held about a person", async () => {
    const fixture = await makeFixture("export");

    await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "submission:xyz",
      }),
    );

    const result = await inTenant(fixture, (tx) =>
      exportSubject(tx, fixture.orgId, fixture.contactId),
    );

    expect(result?.contact.name).toBe("Mehmet Demir");
    expect(result?.consents).toHaveLength(1);
    expect(result?.consents[0]?.proofRef).toBe("submission:xyz");
  });

  it("returns null for another organization's contact", async () => {
    const mine = await makeFixture("export-mine");
    const theirs = await makeFixture("export-theirs");

    expect(
      await inTenant(mine, (tx) => exportSubject(tx, mine.orgId, theirs.contactId)),
    ).toBeNull();
  });
});

describe("KVKK erasure", () => {
  async function withReview(fixture: Fixture) {
    const [campaign] = await getAdminDb()
      .insert(schema.campaigns)
      .values({
        organizationId: fixture.orgId,
        locationId: fixture.locationId,
        name: "C",
        slug: `c-${counter++}-${suffix}`,
        channel: "email",
        destination: "firstparty",
      })
      .returning({ id: schema.campaigns.id });

    const [review] = await getAdminDb()
      .insert(schema.reviews)
      .values({
        organizationId: fixture.orgId,
        locationId: fixture.locationId,
        source: "firstparty",
        sourceReviewId: `r-${counter++}-${suffix}`,
        authorName: "Mehmet Demir",
        rating: 4,
        text: "Doğum günümde köpeğimle gelmiştik, çok ilgilendiler.",
        rawPayload: { contactId: fixture.contactId, submittedBy: "Mehmet Demir" },
      })
      .returning({ id: schema.reviews.id });

    await getAdminDb()
      .insert(schema.reviewInsights)
      .values({
        organizationId: fixture.orgId,
        reviewId: review!.id,
        sentiment: "positive",
        sentimentScore: 0.8,
        topics: ["personel"],
        language: "tr",
        promptId: "t@1",
        model: "test",
      });

    await getAdminDb()
      .insert(schema.reviewRequests)
      .values({
        organizationId: fixture.orgId,
        campaignId: campaign!.id,
        locationId: fixture.locationId,
        contactId: fixture.contactId,
        channel: "email",
        status: "submitted",
        token: `tok-${counter++}-${suffix}`,
        reviewId: review!.id,
      });

    return review!.id;
  }

  it("deletes the contact and anonymises the review", async () => {
    const fixture = await makeFixture("erase");
    const reviewId = await withReview(fixture);

    const result = await inTenant(fixture, (tx) =>
      eraseSubject(tx, fixture.orgId, fixture.contactId),
    );

    expect(result.contactDeleted).toBe(true);
    expect(result.reviewsAnonymised).toBe(1);

    const [review] = await getAdminDb()
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, reviewId));

    // The rating and the fact of the review survive: deleting them would not
    // unpublish anything and would corrupt every metric that counted it.
    expect(review?.rating).toBe(4);
    // Everything identifying is gone — including the text, which named a
    // birthday and a dog.
    expect(review?.authorName).toBeNull();
    expect(review?.text).toBeNull();
    expect(review?.rawPayload).toEqual({});
  });

  it("removes the derived insight and its embedding", async () => {
    const fixture = await makeFixture("erase-insight");
    const reviewId = await withReview(fixture);

    await inTenant(fixture, (tx) => eraseSubject(tx, fixture.orgId, fixture.contactId));

    const insights = await getAdminDb()
      .select({ id: schema.reviewInsights.id })
      .from(schema.reviewInsights)
      .where(eq(schema.reviewInsights.reviewId, reviewId));

    // An embedding can partially reconstruct the text it came from, so erasing
    // the words without the vector would be theatre.
    expect(insights).toEqual([]);
  });

  it("keeps consent records, revoked", async () => {
    const fixture = await makeFixture("erase-consent");

    await inTenant(fixture, (tx) =>
      recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: fixture.contactId,
        channel: "message",
        source: "web_form",
        proofRef: "p",
      }),
    );

    await inTenant(fixture, (tx) => eraseSubject(tx, fixture.orgId, fixture.contactId));

    const rows = await getAdminDb()
      .select()
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.organizationId, fixture.orgId));

    // `contact_ref` now points at a row that does not exist, so it identifies
    // nobody — but the record still proves what was granted and withdrawn.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).not.toBeNull();
  });

  it("leaves the request funnel countable without the person in it", async () => {
    const fixture = await makeFixture("erase-funnel");
    await withReview(fixture);

    await inTenant(fixture, (tx) => eraseSubject(tx, fixture.orgId, fixture.contactId));

    const [request] = await getAdminDb()
      .select({ contactId: schema.reviewRequests.contactId, status: schema.reviewRequests.status })
      .from(schema.reviewRequests)
      .where(eq(schema.reviewRequests.organizationId, fixture.orgId));

    expect(request?.status).toBe("submitted");
    expect(request?.contactId).toBeNull();
  });

  it("does not touch another organization's data", async () => {
    const mine = await makeFixture("erase-iso-mine");
    const theirs = await makeFixture("erase-iso-theirs");
    await withReview(theirs);

    const result = await inTenant(mine, (tx) => eraseSubject(tx, mine.orgId, theirs.contactId));

    expect(result.contactDeleted).toBe(false);

    const [contact] = await getAdminDb()
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, theirs.contactId));

    expect(contact).toBeDefined();
  });
});
