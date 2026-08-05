import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setMemberLocations } from "@/auth/scope";
import { recordIysConsent } from "@/compliance/consent";
import { setIysGateway } from "@/compliance/gate";
import { createLocalGateway } from "@/compliance/iys-gateway";
import { EMPTY_CONTACT_FILTERS, contactFiltersToRecord } from "@/contacts/filters";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { currentPeriod } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";
import { meterFor, runBroadcast, runDueBroadcasts } from "@/broadcasts/pipeline";
import { resolveAudience } from "@/broadcasts/audience";
import { listRecipients } from "@/broadcasts/store";
import { subscribeToPlanWith } from "./plan-fixture";

/**
 * Broadcasts (P4-T4).
 *
 * The Definition of Done in four clauses: a broadcast targets a segment,
 * schedules, sends (mock), and tracks delivery/conversion — and sends are
 * metered plus consent-gated. The last clause is where the interesting
 * assertions are, because it is the one whose failure costs a customer money or
 * a fine rather than a support ticket.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

type Fixture = {
  orgId: string;
  kadikoy: string;
  besiktas: string;
  campaignId: string;
  segmentId: string;
  admin: string;
  /** Consented, in Kadıköy. */
  ayse: string;
  /** No consent, in Kadıköy. */
  stranger: string;
  /** Consented, but in Beşiktaş — used for the scope test. */
  mehmet: string;
};

let alpha: Fixture;

async function makeOrg(label: string): Promise<Fixture> {
  const db = getAdminDb();

  const [org] = await db
    .insert(schema.organizations)
    .values({ name: `Broadcast ${label} ${suffix}`, slug: `broadcast-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  orgIds.push(org!.id);
  await subscribeToPlanWith(org!.id, ["broadcasts", "crm"]);

  const locations = await db
    .insert(schema.locations)
    .values([
      { organizationId: org!.id, name: "Kadıköy Şubesi" },
      { organizationId: org!.id, name: "Beşiktaş Şubesi" },
    ])
    .returning({ id: schema.locations.id });

  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      organizationId: org!.id,
      locationId: locations[0]!.id,
      name: "Yorum daveti",
      slug: `bc-${label}-${suffix}`,
      status: "active",
    })
    .returning({ id: schema.campaigns.id });

  const [user] = await db
    .insert(schema.users)
    .values({ email: `bc-admin-${label}-${suffix}@example.com`, name: "Admin" })
    .returning({ id: schema.users.id });
  userIds.push(user!.id);
  await db
    .insert(schema.memberships)
    .values({ organizationId: org!.id, userId: user!.id, role: "admin" });

  const contacts = await db
    .insert(schema.contacts)
    .values([
      { organizationId: org!.id, name: "Ayşe Yılmaz", email: `bc-ayse-${suffix}@example.com` },
      { organizationId: org!.id, name: "Yabancı", email: `bc-stranger-${suffix}@example.com` },
      { organizationId: org!.id, name: "Mehmet Demir", email: `bc-mehmet-${suffix}@example.com` },
    ])
    .returning({ id: schema.contacts.id });

  // The interactions that attach a contact to a branch — the same thing
  // `src/contacts/scope.ts` reads.
  await db.insert(schema.reviewRequests).values([
    {
      organizationId: org!.id,
      campaignId: campaign!.id,
      locationId: locations[0]!.id,
      contactId: contacts[0]!.id,
      channel: "email",
      status: "sent",
      token: `bt-a-${suffix}`,
    },
    {
      organizationId: org!.id,
      campaignId: campaign!.id,
      locationId: locations[0]!.id,
      contactId: contacts[1]!.id,
      channel: "email",
      status: "sent",
      token: `bt-s-${suffix}`,
    },
    {
      organizationId: org!.id,
      campaignId: campaign!.id,
      locationId: locations[1]!.id,
      contactId: contacts[2]!.id,
      channel: "email",
      status: "sent",
      token: `bt-m-${suffix}`,
    },
  ]);

  const [segment] = await db
    .insert(schema.contactSegments)
    .values({
      organizationId: org!.id,
      name: `Herkes ${suffix}`,
      filters: contactFiltersToRecord(EMPTY_CONTACT_FILTERS),
    })
    .returning({ id: schema.contactSegments.id });

  await withTenant({ organizationId: org!.id }, async (tx) => {
    for (const contactId of [contacts[0]!.id, contacts[2]!.id]) {
      await recordIysConsent({
        tx,
        organizationId: org!.id,
        contactRef: contactId,
        channel: "email",
        source: "web_form",
        proofRef: "test",
      });
    }
  });

  return {
    orgId: org!.id,
    kadikoy: locations[0]!.id,
    besiktas: locations[1]!.id,
    campaignId: campaign!.id,
    segmentId: segment!.id,
    admin: user!.id,
    ayse: contacts[0]!.id,
    stranger: contacts[1]!.id,
    mehmet: contacts[2]!.id,
  };
}

/** Queues a review-request broadcast over the whole segment. */
async function queue(
  fixture: Fixture,
  overrides: Partial<{ scheduledAt: Date | null; createdByUserId: string | null }> = {},
): Promise<string> {
  const [row] = await getAdminDb()
    .insert(schema.broadcasts)
    .values({
      organizationId: fixture.orgId,
      name: `Gönderim ${Math.random().toString(36).slice(2, 8)}`,
      kind: "review_request",
      channel: "email",
      segmentId: fixture.segmentId,
      audience: contactFiltersToRecord(EMPTY_CONTACT_FILTERS),
      campaignId: fixture.campaignId,
      scheduledAt: overrides.scheduledAt ?? null,
      status: overrides.scheduledAt ? "scheduled" : "draft",
      createdByUserId:
        overrides.createdByUserId === undefined ? fixture.admin : overrides.createdByUserId,
    })
    .returning({ id: schema.broadcasts.id });

  return row!.id;
}

beforeAll(async () => {
  alpha = await makeOrg("alpha");
}, 30_000);

afterEach(() => setIysGateway(null));

afterAll(async () => {
  const db = getAdminDb();
  if (orgIds.length > 0) {
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  if (userIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  }
  setIysGateway(null);
  await closeDatabasePools();
});

// ---------------------------------------------------------------------------

describe("the audience", () => {
  it("comes from the same predicate the contacts list uses", async () => {
    // The promise P4-T1 made when it exported `contactsWhere`. A second
    // interpretation would be a screen promising forty and a send reaching
    // thirty-eight.
    const contacts = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      resolveAudience({
        tx,
        organizationId: alpha.orgId,
        scope: { all: true },
        filters: EMPTY_CONTACT_FILTERS,
        channel: "email",
      }),
    );

    expect(contacts.map((row) => row.id).sort()).toEqual(
      [alpha.ayse, alpha.stranger, alpha.mehmet].sort(),
    );
  });

  it("narrows to the creator's branches", async () => {
    const contacts = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      resolveAudience({
        tx,
        organizationId: alpha.orgId,
        scope: { all: false, locationIds: [alpha.kadikoy] },
        filters: EMPTY_CONTACT_FILTERS,
        channel: "email",
      }),
    );

    expect(contacts.map((row) => row.id).sort()).toEqual([alpha.ayse, alpha.stranger].sort());
  });

  it("excludes an opt-out before a recipient row is ever formed", async () => {
    // The gate would refuse them anyway. The point is not to have formed the
    // intention: a recipient row saying "we meant to message this person" is a
    // record of something nobody should have decided.
    await withTenant({ organizationId: alpha.orgId }, (tx) =>
      tx
        .update(schema.contacts)
        .set({ unsubscribedAt: new Date() })
        .where(eq(schema.contacts.id, alpha.mehmet)),
    );

    const contacts = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      resolveAudience({
        tx,
        organizationId: alpha.orgId,
        scope: { all: true },
        filters: EMPTY_CONTACT_FILTERS,
        channel: "email",
      }),
    );

    expect(contacts.map((row) => row.id)).not.toContain(alpha.mehmet);

    await withTenant({ organizationId: alpha.orgId }, (tx) =>
      tx
        .update(schema.contacts)
        .set({ unsubscribedAt: null })
        .where(eq(schema.contacts.id, alpha.mehmet)),
    );
  });

  it("skips anyone unreachable on the channel", async () => {
    const contacts = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      resolveAudience({
        tx,
        organizationId: alpha.orgId,
        scope: { all: true },
        filters: EMPTY_CONTACT_FILTERS,
        // Nobody in this fixture has a phone number.
        channel: "sms",
      }),
    );

    expect(contacts).toEqual([]);
  });
});

describe("sends are consent-gated", () => {
  it("refuses a recipient with no consent and records the reason", async () => {
    setIysGateway(createLocalGateway("test"));
    const broadcastId = await queue(alpha);

    const outcome = await runBroadcast(alpha.orgId, broadcastId);

    // Two consented, one not. The refusal is named, not swallowed.
    expect(outcome.refused).toBe(1);
    expect(outcome.refusals).toEqual({ no_consent: 1 });
    expect(outcome.sent).toBe(2);

    const recipients = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      listRecipients(tx, alpha.orgId, broadcastId),
    );

    const refused = recipients.find((row) => row.contactId === alpha.stranger);
    expect(refused?.status).toBe("refused");
    expect(refused?.refusalReason).toBe("no_consent");
  });

  it("refuses everybody when İYS is required and no gateway is wired", async () => {
    // The default posture before go-live. A broadcast is the place it matters
    // most: one press of a button, several hundred messages.
    const broadcastId = await queue(alpha);
    const outcome = await runBroadcast(alpha.orgId, broadcastId);

    expect(outcome.sent).toBe(0);
    expect(outcome.refusals.iys_not_configured).toBeGreaterThan(0);
  });

  it("gates review requests, which the direct send does not", async () => {
    /**
     * The point of gating in the pipeline. `/requests` has sent review-request
     * email since P1b-T1 without an İYS check; changing that would stop review
     * requests sending in every environment without a registry. A *broadcast*
     * gates every kind, so `docs/20`'s "İYS-compliant" holds for the unified
     * send even where the direct one predates the rule.
     */
    const broadcastId = await queue(alpha);
    const outcome = await runBroadcast(alpha.orgId, broadcastId);

    // No gateway installed in this test, so a review-request broadcast is
    // refused — which the equivalent direct send would not be.
    expect(outcome.sent).toBe(0);
    expect(outcome.audience).toBeGreaterThan(0);
  });
});

describe("running one", () => {
  it("is claimed exactly once, however many sweeps race", async () => {
    setIysGateway(createLocalGateway("test"));
    const broadcastId = await queue(alpha);

    const [first, second] = await Promise.all([
      runBroadcast(alpha.orgId, broadcastId),
      runBroadcast(alpha.orgId, broadcastId),
    ]);

    // One does the work; the other finds nothing to claim. The status
    // transition in the WHERE clause *is* the lock.
    const worked = [first, second].filter((outcome) => outcome.audience > 0);
    expect(worked).toHaveLength(1);
  });

  it("abandons rather than half-sending when the creator has left", async () => {
    setIysGateway(createLocalGateway("test"));

    const db = getAdminDb();
    const [ghost] = await db
      .insert(schema.users)
      .values({ email: `bc-ghost-${suffix}@example.com`, name: "Ghost" })
      .returning({ id: schema.users.id });
    userIds.push(ghost!.id);

    // Created by somebody who is not a member of this organization — the state
    // a departed colleague leaves behind.
    const broadcastId = await queue(alpha, { createdByUserId: ghost!.id });
    const outcome = await runBroadcast(alpha.orgId, broadcastId);

    expect(outcome.sent).toBe(0);
    expect(outcome.abandoned).toContain("left the team");

    const [row] = await db
      .select({ status: schema.broadcasts.status })
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.id, broadcastId));
    expect(row?.status).toBe("cancelled");
  });

  it("resolves the audience under the creator's scope, at send time", async () => {
    setIysGateway(createLocalGateway("test"));

    const db = getAdminDb();
    const [member] = await db
      .insert(schema.users)
      .values({ email: `bc-scoped-${suffix}@example.com`, name: "Scoped" })
      .returning({ id: schema.users.id });
    userIds.push(member!.id);
    await db
      .insert(schema.memberships)
      .values({ organizationId: alpha.orgId, userId: member!.id, role: "member" });

    await withTenant({ organizationId: alpha.orgId, userId: alpha.admin }, (tx) =>
      setMemberLocations(
        tx,
        { organizationId: alpha.orgId, role: "admin" },
        { userId: member!.id, locationIds: [alpha.besiktas] },
      ),
    );

    const broadcastId = await queue(alpha, { createdByUserId: member!.id });
    const outcome = await runBroadcast(alpha.orgId, broadcastId);

    // Only Beşiktaş. A branch manager must not be able to queue a send that
    // reaches the whole chain.
    expect(outcome.audience).toBe(1);

    const recipients = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      listRecipients(tx, alpha.orgId, broadcastId),
    );
    expect(recipients.map((row) => row.contactId)).toEqual([alpha.mehmet]);
  });
});

describe("when the send itself falls over", () => {
  it("marks the broadcast abandoned rather than leaving it stuck in sending", async () => {
    /**
     * Found by running it. The claim in phase 1 commits before any network
     * call, so an exception escaping dispatch used to leave `status =
     * 'sending'` forever: unclaimable by the next sweep, unsendable by the
     * button, and with nothing on the screen to say why.
     *
     * Provoked here the way it happened in the browser — a review-request
     * broadcast pointed at a `link` campaign, which has nothing to send.
     */
    setIysGateway(createLocalGateway("test"));

    const [linkCampaign] = await getAdminDb()
      .insert(schema.campaigns)
      .values({
        organizationId: alpha.orgId,
        locationId: alpha.kadikoy,
        name: "QR kartı",
        slug: `bc-link-${suffix}`,
        channel: "link",
        status: "active",
      })
      .returning({ id: schema.campaigns.id });

    const [row] = await getAdminDb()
      .insert(schema.broadcasts)
      .values({
        organizationId: alpha.orgId,
        name: `Bozuk ${suffix}`,
        kind: "review_request",
        channel: "email",
        segmentId: alpha.segmentId,
        audience: contactFiltersToRecord(EMPTY_CONTACT_FILTERS),
        campaignId: linkCampaign!.id,
        status: "draft",
        createdByUserId: alpha.admin,
      })
      .returning({ id: schema.broadcasts.id });

    const outcome = await runBroadcast(alpha.orgId, row!.id);
    expect(outcome.abandoned).toBeTruthy();

    const [after] = await getAdminDb()
      .select({ status: schema.broadcasts.status, reason: schema.broadcasts.failureReason })
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.id, row!.id));

    expect(after?.status).toBe("cancelled");
    expect(after?.reason).toBeTruthy();

    // The audience snapshot survives: those rows are the record of who was
    // considered, and erasing them would hide what a half-finished send did.
    const recipients = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      listRecipients(tx, alpha.orgId, row!.id),
    );
    expect(recipients.length).toBeGreaterThan(0);
  });
});

describe("scheduling", () => {
  it("sends a broadcast whose time has passed, and leaves a future one alone", async () => {
    setIysGateway(createLocalGateway("test"));

    const past = await queue(alpha, { scheduledAt: new Date(Date.now() - 60_000) });
    const future = await queue(alpha, { scheduledAt: new Date(Date.now() + 86_400_000) });

    const outcomes = await runDueBroadcasts();
    const ids = outcomes.map((outcome) => outcome.broadcastId);

    // A time in the past is sent now rather than skipped: a worker that was
    // down for an hour should catch up, not silently drop an afternoon.
    expect(ids).toContain(past);
    expect(ids).not.toContain(future);

    const [row] = await getAdminDb()
      .select({ status: schema.broadcasts.status })
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.id, future));
    expect(row?.status).toBe("scheduled");
  });
});

describe("the plan is checked at send time, not only at save", () => {
  it("abandons a scheduled broadcast whose plan no longer includes them", async () => {
    /**
     * A broadcast can be scheduled weeks ahead and a subscription can lapse in
     * between. The same rule P3-T5 established for scheduled reports: anything
     * with a delay between the decision and the act needs the entitlement asked
     * twice.
     */
    setIysGateway(createLocalGateway("test"));

    const db = getAdminDb();
    const [org] = await db
      .insert(schema.organizations)
      .values({ name: `Lapsed ${suffix}`, slug: `bc-lapsed-${suffix}` })
      .returning({ id: schema.organizations.id });
    orgIds.push(org!.id);

    const [location] = await db
      .insert(schema.locations)
      .values({ organizationId: org!.id, name: "Şube" })
      .returning({ id: schema.locations.id });

    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        organizationId: org!.id,
        locationId: location!.id,
        name: "Davet",
        slug: `bc-lapsed-c-${suffix}`,
        status: "active",
      })
      .returning({ id: schema.campaigns.id });

    const [segment] = await db
      .insert(schema.contactSegments)
      .values({
        organizationId: org!.id,
        name: `Herkes ${suffix}`,
        filters: contactFiltersToRecord(EMPTY_CONTACT_FILTERS),
      })
      .returning({ id: schema.contactSegments.id });

    // No subscription at all, so the organization sits on the Starter floor —
    // which is what a lapsed account resolves to.
    const [row] = await db
      .insert(schema.broadcasts)
      .values({
        organizationId: org!.id,
        name: "Zamanlanmış",
        kind: "review_request",
        channel: "email",
        segmentId: segment!.id,
        audience: contactFiltersToRecord(EMPTY_CONTACT_FILTERS),
        campaignId: campaign!.id,
        status: "scheduled",
        scheduledAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: schema.broadcasts.id });

    const outcome = await runBroadcast(org!.id, row!.id);

    expect(outcome.sent).toBe(0);
    expect(outcome.abandoned).toContain("no longer included");

    const [after] = await db
      .select({ status: schema.broadcasts.status })
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.id, row!.id));
    expect(after?.status).toBe("cancelled");
  });
});

describe("metering", () => {
  it("charges the channel's own allowance, not another feature's", () => {
    // An SMS costs an SMS whatever it says. Email surveys are deliberately
    // unmetered (P4-T2), and email review requests are metered inside
    // `prepareRequests`, which has done it since P1b-T1.
    expect(meterFor("message", "sms")).toBe("sms_credits");
    expect(meterFor("message", "whatsapp")).toBe("whatsapp_conversations");
    expect(meterFor("review_request", "email")).toBe("requests_per_month");
    expect(meterFor("survey", "email")).toBeNull();
  });

  it("spends the review-request allowance through the sender that owns it", async () => {
    setIysGateway(createLocalGateway("test"));
    const before = await usage(alpha.orgId, "requests_per_month");

    const broadcastId = await queue(alpha);
    const outcome = await runBroadcast(alpha.orgId, broadcastId);

    const after = await usage(alpha.orgId, "requests_per_month");

    // Metered on delivery, not intent: the refused recipient costs nothing.
    expect(after - before).toBe(outcome.sent);
  });
});

describe("delivery and conversion", () => {
  it("reads conversion from the funnel it points at, never a copy", async () => {
    setIysGateway(createLocalGateway("test"));
    const broadcastId = await queue(alpha);
    await runBroadcast(alpha.orgId, broadcastId);

    const before = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      listRecipients(tx, alpha.orgId, broadcastId),
    );
    expect(before.filter((row) => row.converted)).toHaveLength(0);

    // The customer acts. Nothing about the broadcast is touched.
    const [recipient] = await getAdminDb()
      .select({ reviewRequestId: schema.broadcastRecipients.reviewRequestId })
      .from(schema.broadcastRecipients)
      .where(eq(schema.broadcastRecipients.broadcastId, broadcastId))
      .limit(1);

    if (recipient?.reviewRequestId) {
      await getAdminDb()
        .update(schema.reviewRequests)
        .set({ submittedAt: new Date() })
        .where(eq(schema.reviewRequests.id, recipient.reviewRequestId));

      const after = await withTenant({ organizationId: alpha.orgId }, (tx) =>
        listRecipients(tx, alpha.orgId, broadcastId),
      );
      expect(after.filter((row) => row.converted)).toHaveLength(1);
    }
  });
});

/** What this organization has spent of one allowance, this billing period. */
async function usage(organizationId: string, metric: string): Promise<number> {
  const [row] = await getAdminDb()
    .select({ count: schema.usageCounters.count })
    .from(schema.usageCounters)
    .where(
      and(
        eq(schema.usageCounters.organizationId, organizationId),
        eq(schema.usageCounters.metric, metric),
        // The period, from the same helper the writer uses — reading "all
        // time" would make this pass in December and fail on the 1st.
        eq(schema.usageCounters.period, currentPeriod()),
      ),
    );

  return row?.count ?? 0;
}
