import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { recordIysConsent, pendingIysUploads } from "@/compliance/consent";
import { setIysGateway, type IysGateway, type IysUploadOutcome } from "@/compliance/gate";
import { createLocalGateway } from "@/compliance/iys-gateway";
import { runIysUploads } from "@/compliance/iys-upload";
import { runIysSweep } from "@/jobs/workers/iys-upload";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";

/**
 * The İYS upload worker (P1b-T5).
 *
 * The obligation this closes: a permission the customer gave us but the
 * registry has never seen is not a permission to send, and `checkSendAllowed`
 * refuses on exactly that basis. Until something drains the queue, every
 * commercial message is correctly blocked forever.
 *
 * So the cases that matter here are the ones where a bug would either **lose a
 * deadline** (a consent that quietly stops being retried) or **fake one** (a row
 * marked registered that no registry accepted). The happy path is the least
 * interesting thing in this file.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

const IYS_ON = { IYS_REQUIRED: true };
const IYS_OFF = { IYS_REQUIRED: false };

type Fixture = { orgId: string; contactRefs: string[] };

/** A gateway that answers however the test says, and records what it was asked. */
function scriptedGateway(
  answer: (record: { id: string; contactRef: string }) => IysUploadOutcome | null,
  name = "test-registry",
): IysGateway & { seen: { contactRef: string; channel: string; grantedAt: Date | null }[] } {
  const seen: { contactRef: string; channel: string; grantedAt: Date | null }[] = [];

  return {
    name,
    seen,
    check: async () => "allowed" as const,
    async upload({ records }) {
      for (const record of records) {
        seen.push({
          contactRef: record.contactRef,
          channel: record.channel,
          grantedAt: record.grantedAt,
        });
      }
      // A null answer means "said nothing about this row", which the uploader
      // must not read as success.
      return records.map(answer).filter((outcome): outcome is IysUploadOutcome => outcome !== null);
    },
  };
}

const acceptAll = () => scriptedGateway((record) => ({ id: record.id, status: "accepted" }));

async function makeFixture(label: string, consents = 1): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `IYS ${label} ${suffix}`, slug: `iys-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const contactRefs: string[] = [];
  for (let index = 0; index < consents; index += 1) {
    const contactRef = `contact-${counter++}-${suffix}`;
    contactRefs.push(contactRef);

    await withTenant({ organizationId: org.id }, (tx) =>
      recordIysConsent({
        tx,
        organizationId: org.id,
        contactRef,
        channel: "message",
        source: "web_form",
        proofRef: `submission:${contactRef}`,
      }),
    );
  }

  return { orgId: org.id, contactRefs };
}

function consentRows(orgId: string) {
  return getAdminDb()
    .select()
    .from(schema.consentRecords)
    .where(
      and(eq(schema.consentRecords.organizationId, orgId), eq(schema.consentRecords.type, "iys")),
    );
}

afterEach(() => {
  setIysGateway(null);
});

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("draining the upload queue", () => {
  it("reports pending consents and takes them out of the queue", async () => {
    const fixture = await makeFixture("drain", 3);
    const gateway = acceptAll();
    setIysGateway(gateway);

    const result = await runIysUploads({ organizationId: fixture.orgId }, IYS_ON);

    expect(result).toMatchObject({ attempted: 3, uploaded: 3, failed: 0 });

    // The queue is what the *next* pass would pick up. If a successful upload
    // did not empty it, the registry would be sent the same consent forever.
    const stillPending = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      pendingIysUploads(tx, fixture.orgId),
    );
    expect(stillPending).toEqual([]);
  });

  it("sends the registry when permission was given, not when we got round to it", async () => {
    const fixture = await makeFixture("granted-at");
    const gateway = acceptAll();
    setIysGateway(gateway);

    await runIysUploads({ organizationId: fixture.orgId }, IYS_ON);

    // İYS records the moment the box was ticked. A late upload of a timely
    // consent is untidy; a consent re-dated to the upload is a false record.
    expect(gateway.seen).toHaveLength(1);
    expect(gateway.seen[0]?.grantedAt).toBeInstanceOf(Date);
    expect(gateway.seen[0]?.channel).toBe("message");
    expect(gateway.seen[0]?.contactRef).toBe(fixture.contactRefs[0]);
  });

  it("records which gateway accepted it, so a local one stays recognisable", async () => {
    const fixture = await makeFixture("via");
    setIysGateway(scriptedGateway((record) => ({ id: record.id, status: "accepted" }), "local"));

    await runIysUploads({ organizationId: fixture.orgId }, IYS_ON);

    // `iys_uploaded_at` on its own would claim the registry holds this
    // permission. In development that is false, and this column is the only
    // thing that keeps the two distinguishable afterwards.
    const [row] = await consentRows(fixture.orgId);
    expect(row?.iysUploadedAt).toBeInstanceOf(Date);
    expect(row?.iysUploadedVia).toBe("local");
  });

  it("audit-logs the upload, because it is the moment sending becomes allowed", async () => {
    const fixture = await makeFixture("audit", 2);
    setIysGateway(acceptAll());

    await runIysUploads({ organizationId: fixture.orgId }, IYS_ON);

    const [entry] = await getAdminDb()
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.organizationId, fixture.orgId),
          eq(schema.auditLogs.action, "consent.iys_uploaded"),
        ),
      );

    expect(entry).toBeTruthy();
    expect(entry?.meta).toMatchObject({ gateway: "test-registry", uploaded: 2 });
    // Null actor: the worker acts for the organization, not for a person, and
    // inventing a user here would put a false name on a legal record.
    expect(entry?.actorUserId).toBeNull();
  });
});

describe("when the upload does not succeed", () => {
  it("leaves a rejected consent queued with the reason, so it is retried", async () => {
    const fixture = await makeFixture("rejected");
    setIysGateway(
      scriptedGateway((record) => ({
        id: record.id,
        status: "failed",
        retryable: true,
        detail: "registry timed out",
      })),
    );

    const result = await runIysUploads({ organizationId: fixture.orgId }, IYS_ON);
    expect(result).toMatchObject({ uploaded: 0, failed: 1 });

    const [row] = await consentRows(fixture.orgId);
    expect(row?.iysUploadedAt).toBeNull();
    expect(row?.iysUploadError).toContain("registry timed out");
    // Retryable is recorded rather than inferred: an operator reading the queue
    // needs to know whether waiting will fix it.
    expect(row?.iysUploadError).toContain("retryable");
  });

  it("succeeds on a later pass after a failure, without a manual reset", async () => {
    const fixture = await makeFixture("retry");

    setIysGateway(
      scriptedGateway((record) => ({
        id: record.id,
        status: "failed",
        retryable: true,
        detail: "registry down",
      })),
    );
    await runIysUploads({ organizationId: fixture.orgId }, IYS_ON);

    setIysGateway(acceptAll());
    const second = await runIysUploads({ organizationId: fixture.orgId }, IYS_ON);

    expect(second).toMatchObject({ uploaded: 1, failed: 0 });

    const [row] = await consentRows(fixture.orgId);
    expect(row?.iysUploadedAt).toBeInstanceOf(Date);
    // The stale failure must be cleared, or the row would carry an error
    // describing a state it is no longer in.
    expect(row?.iysUploadError).toBeNull();
  });

  it("keeps every row queued when the gateway throws instead of answering", async () => {
    const fixture = await makeFixture("threw", 2);
    setIysGateway({
      name: "exploding",
      check: async () => "allowed" as const,
      upload: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const result = await runIysUploads({ organizationId: fixture.orgId }, IYS_ON);
    expect(result).toMatchObject({ attempted: 2, uploaded: 0, failed: 2 });

    const rows = await consentRows(fixture.orgId);
    expect(rows.every((row) => row.iysUploadedAt === null)).toBe(true);
    expect(rows.every((row) => row.iysUploadError?.includes("ECONNREFUSED"))).toBe(true);
  });

  it("does not treat silence about a row as acceptance", async () => {
    const fixture = await makeFixture("silent", 2);

    // Answers for the first record only. The second is simply absent from the
    // response — the failure mode where a partial reply gets read as a full one.
    let answered = 0;
    setIysGateway(
      scriptedGateway((record) => {
        answered += 1;
        return answered === 1 ? { id: record.id, status: "accepted" } : null;
      }),
    );

    const result = await runIysUploads({ organizationId: fixture.orgId }, IYS_ON);
    expect(result).toMatchObject({ uploaded: 1, failed: 1 });

    const rows = await consentRows(fixture.orgId);
    const unregistered = rows.filter((row) => row.iysUploadedAt === null);
    expect(unregistered).toHaveLength(1);
    expect(unregistered[0]?.iysUploadError).toContain("no outcome");
  });
});

describe("when İYS does not apply or is not wired", () => {
  it("does nothing, and marks nothing, when no gateway is configured", async () => {
    const fixture = await makeFixture("no-gateway");
    setIysGateway(null);

    const result = await runIysUploads({ organizationId: fixture.orgId }, IYS_ON);
    expect(result.skipped).toBe("no_gateway");

    // Deliberately not an error written to the rows: there is nothing wrong
    // with these consents, and a failure reason here would blame the customer's
    // record for a deployment gap.
    const [row] = await consentRows(fixture.orgId);
    expect(row?.iysUploadedAt).toBeNull();
    expect(row?.iysUploadError).toBeNull();
  });

  it("skips a deployment outside Türkiye without touching the gateway", async () => {
    const fixture = await makeFixture("not-required");
    const gateway = acceptAll();
    setIysGateway(gateway);

    const result = await runIysUploads({ organizationId: fixture.orgId }, IYS_OFF);

    expect(result.skipped).toBe("not_required");
    expect(gateway.seen).toEqual([]);
  });

  it("refuses to record uploads when the local adapter is used in production", async () => {
    const fixture = await makeFixture("local-in-prod");
    setIysGateway(createLocalGateway("production"));

    const result = await runIysUploads({ organizationId: fixture.orgId }, IYS_ON);

    // The whole point of the guard: marking a consent registered when no
    // registry has seen it is worse than leaving it queued, because the send
    // gate would then let a message through on the strength of a local row.
    expect(result).toMatchObject({ uploaded: 0, failed: 1 });

    const [row] = await consentRows(fixture.orgId);
    expect(row?.iysUploadedAt).toBeNull();
    expect(row?.iysUploadError).toContain("permanent");
  });

  it("accepts through the local adapter outside production, so the loop is exercisable", async () => {
    const fixture = await makeFixture("local-in-dev");
    setIysGateway(createLocalGateway("development"));

    const result = await runIysUploads({ organizationId: fixture.orgId }, IYS_ON);
    expect(result.uploaded).toBe(1);

    const [row] = await consentRows(fixture.orgId);
    expect(row?.iysUploadedVia).toBe("local");
  });
});

describe("the sweep", () => {
  it("finds organizations holding unreported consents and drains them", async () => {
    const first = await makeFixture("sweep-a", 2);
    const second = await makeFixture("sweep-b");
    setIysGateway(acceptAll());

    // The sweep takes no organization: nothing enqueues it, because the trigger
    // is a deadline passing rather than anything happening.
    await runIysSweep();

    for (const orgId of [first.orgId, second.orgId]) {
      const rows = await consentRows(orgId);
      expect(rows.every((row) => row.iysUploadedAt !== null)).toBe(true);
    }
  });

  it("keeps going when one organization's upload throws", async () => {
    const poison = await makeFixture("sweep-poison");
    const healthy = await makeFixture("sweep-healthy");

    setIysGateway({
      name: "selective",
      check: async () => "allowed" as const,
      async upload({ organizationId, records }) {
        if (organizationId === poison.orgId) throw new Error("registry exploded");
        return records.map((record) => ({ id: record.id, status: "accepted" as const }));
      },
    });

    await runIysSweep();

    // Each tenant's three business days are its own. A shared loop that aborted
    // on the first failure would put every later business out of compliance
    // because of someone else's bad row.
    const [healthyRow] = await consentRows(healthy.orgId);
    expect(healthyRow?.iysUploadedAt).toBeInstanceOf(Date);

    const [poisonRow] = await consentRows(poison.orgId);
    expect(poisonRow?.iysUploadedAt).toBeNull();
  });

  it("does not scan at all when no gateway is configured", async () => {
    const fixture = await makeFixture("sweep-no-gateway");
    setIysGateway(null);

    const result = await runIysSweep();

    expect(result).toMatchObject({ organizations: 0, uploaded: 0 });
    const [row] = await consentRows(fixture.orgId);
    expect(row?.iysUploadedAt).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("uploads only the organization it was asked about", async () => {
    const mine = await makeFixture("mine", 2);
    const theirs = await makeFixture("theirs", 2);

    const gateway = acceptAll();
    setIysGateway(gateway);

    const result = await runIysUploads({ organizationId: mine.orgId }, IYS_ON);
    expect(result.uploaded).toBe(2);

    // The gateway is a third party. Handing it another tenant's contact
    // references would be a disclosure, not just a bug.
    expect(gateway.seen.map((entry) => entry.contactRef).sort()).toEqual(
      [...mine.contactRefs].sort(),
    );

    const untouched = await consentRows(theirs.orgId);
    expect(untouched.every((row) => row.iysUploadedAt === null)).toBe(true);
  });
});
