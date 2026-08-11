import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { createCaptureTransport } from "@/messaging/email";
import { runScheduledReports } from "@/reports/pipeline";

/**
 * Sending a scheduled report (P3-T5).
 *
 * One property matters more than everything else here: **a report is sent once
 * per period, however often the sweep runs**. The sweep is hourly and is
 * allowed to re-run, retry and catch up, so "already sent" has to be a row in
 * `report_deliveries` rather than an assumption about timing. A duplicate is
 * not a cosmetic bug — it is the product mailing a customer the same PDF five
 * times because a worker restarted.
 *
 * The second is that the PDF is real. It is rendered by a library with its own
 * layout engine and embedded fonts, in a worker process, so "it type-checks" is
 * not evidence that a file comes out — these assertions open the bytes.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

type Fixture = { orgId: string; userId: string; locationId: string; scheduleId: string };

async function makeOrg(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Rep ${label} ${suffix}`, slug: `rep-${label}-${suffix}`, locale: "tr" })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [user] = await getAdminDb()
    .insert(schema.users)
    .values({
      email: `rep-${label}-${suffix}@example.test`,
      name: `Rep ${label}`,
      locale: "tr",
      emailVerified: true,
    })
    .returning({ id: schema.users.id });
  if (!user) throw new Error("user insert returned nothing");
  userIds.push(user.id);

  await getAdminDb()
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: user.id, role: "owner" });

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Merkez`, locale: "tr" })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  // A rated review inside last week, so the report has something to say.
  await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: org.id,
      locationId: location.id,
      source: "google",
      sourceReviewId: `${label}-review`,
      rating: 5,
      text: `Kahvesi çok güzeldi — ${label}`,
      postedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
      rawPayload: {},
    });

  const [schedule] = await getAdminDb()
    .insert(schema.reportSchedules)
    .values({ organizationId: org.id, userId: user.id, cadence: "weekly", enabled: true })
    .returning({ id: schema.reportSchedules.id });
  if (!schedule) throw new Error("schedule insert returned nothing");

  return { orgId: org.id, userId: user.id, locationId: location.id, scheduleId: schedule.id };
}

let alpha: Fixture;

/** A Monday, so the completed weekly period is the week that just ended. */
const MONDAY = new Date("2026-08-03T09:00:00Z");

beforeAll(async () => {
  alpha = await makeOrg("alpha");
});

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  if (userIds.length > 0) {
    await getAdminDb().delete(schema.users).where(inArray(schema.users.id, userIds));
  }
  await closeDatabasePools();
});

describe("sending", () => {
  it("mails the recipient a PDF, and records it", async () => {
    const transport = createCaptureTransport();
    const result = await runScheduledReports(alpha.orgId, { now: MONDAY, transport });

    expect(result).toMatchObject({ sent: 1, failed: 0, skipped: 0 });

    const [message] = transport.sent;
    expect(message?.attachments).toHaveLength(1);

    const attachment = message!.attachments![0]!;
    expect(attachment.contentType).toBe("application/pdf");
    // The bytes, not the type: a library that silently produced nothing would
    // still satisfy a content-type assertion.
    expect(attachment.content.subarray(0, 5).toString()).toBe("%PDF-");
    expect(attachment.content.length).toBeGreaterThan(1_000);

    // Turkish, transliterated for the trip through a mail server and a file
    // system — see `src/reports/copy.ts`.
    expect(attachment.filename).toMatch(/^fairfame-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.pdf$/);

    // The *recipient's* language, from `users.locale` — not the organization's
    // and not a request's, because a worker has no request.
    expect(message?.subject).toContain("raporu");

    const [row] = await getAdminDb()
      .select({
        status: schema.reportDeliveries.status,
        periodStart: schema.reportDeliveries.periodStart,
      })
      .from(schema.reportDeliveries)
      .where(eq(schema.reportDeliveries.scheduleId, alpha.scheduleId));

    expect(row?.status).toBe("sent");
    expect(row?.periodStart.toISOString()).toBe("2026-07-27T00:00:00.000Z");
  });
});

describe("running the sweep again", () => {
  it("does not send a second time for the same period", async () => {
    // The property the whole feature rests on. An hourly sweep means this path
    // runs 167 more times before the next report is due.
    const transport = createCaptureTransport();
    const result = await runScheduledReports(alpha.orgId, { now: MONDAY, transport });

    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(transport.sent).toHaveLength(0);
  });

  it("still sends only once when the sweep first runs days late", async () => {
    // A worker that was down all Monday and comes back on Friday must send
    // Monday's report — and must not then send it again on Saturday.
    const friday = new Date("2026-08-07T06:00:00Z");
    const transport = createCaptureTransport();

    expect(await runScheduledReports(alpha.orgId, { now: friday, transport })).toMatchObject({
      sent: 0,
      skipped: 1,
    });
  });

  it("sends again once the next period closes", async () => {
    const nextMonday = new Date("2026-08-10T09:00:00Z");
    const transport = createCaptureTransport();

    const result = await runScheduledReports(alpha.orgId, { now: nextMonday, transport });

    expect(result.sent).toBe(1);
    expect(transport.sent).toHaveLength(1);

    const rows = await getAdminDb()
      .select({ periodStart: schema.reportDeliveries.periodStart })
      .from(schema.reportDeliveries)
      .where(eq(schema.reportDeliveries.scheduleId, alpha.scheduleId));

    // Two periods, two rows — the ledger is a history, not a flag.
    expect(rows).toHaveLength(2);
  });
});

describe("what stops it sending", () => {
  it("skips a disabled schedule without forgetting its settings", async () => {
    const beta = await makeOrg("beta");
    await getAdminDb()
      .update(schema.reportSchedules)
      .set({ enabled: false })
      .where(eq(schema.reportSchedules.id, beta.scheduleId));

    const transport = createCaptureTransport();
    expect(await runScheduledReports(beta.orgId, { now: MONDAY, transport })).toMatchObject({
      sent: 0,
      skipped: 0,
    });

    // The row survives, so switching it back on restores the cadence somebody
    // chose rather than starting from a default.
    const [row] = await getAdminDb()
      .select({ cadence: schema.reportSchedules.cadence })
      .from(schema.reportSchedules)
      .where(eq(schema.reportSchedules.id, beta.scheduleId));

    expect(row?.cadence).toBe("weekly");
  });

  it("stops when the recipient is no longer a member", async () => {
    // Not a tidy-up detail: their location scope is resolved from the
    // membership, so without one there is nothing to scope by — and mailing a
    // business's numbers to a former member is the leak scope exists to stop.
    const gamma = await makeOrg("gamma");
    await getAdminDb()
      .delete(schema.memberships)
      .where(eq(schema.memberships.userId, gamma.userId));

    const transport = createCaptureTransport();
    expect(await runScheduledReports(gamma.orgId, { now: MONDAY, transport })).toMatchObject({
      sent: 0,
    });
    expect(transport.sent).toHaveLength(0);
  });
});
