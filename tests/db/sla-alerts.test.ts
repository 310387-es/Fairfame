import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { connectSource, syncConnection } from "@/connectors/sync";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { listInbox, toInboxFilters } from "@/reviews/queries";
import { EMPTY_INBOX_FILTERS } from "@/reviews/filters";
import { recordFirstResponse } from "@/reviews/triage";
import { withTenant } from "@/lib/tenancy";
import { subscribeToPlanWith } from "./plan-fixture";
import {
  notifyPendingReviews,
  notifySlaBreaches,
  SLA_ROLLUP_THRESHOLD,
} from "@/notifications/service";

/**
 * Near-real-time and alerts (P2-T7).
 *
 * The Definition of Done: "a new mock review surfaces in the open inbox and
 * fires the right notification." Both halves are here — the first through the
 * real connector rather than a hand-written insert, because "surfaces in the
 * inbox" is a claim about the ingest path, not about an INSERT statement.
 *
 * The second half is the new one: a deadline that lapses with nobody having
 * answered. Nothing happens when time passes, so the interesting cases are all
 * about *not* alerting — on something already answered, already closed, or
 * already alerted about.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

type Fixture = { orgId: string; locationId: string; userId: string };

async function makeFixture(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `SLA ${label}`, slug: `sla-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);
  // The floor plan excludes team-workflow features (P2-T8).
  await subscribeToPlanWith(org.id, ["sla_tracking"]);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: "Kadıköy" })
    .returning({ id: schema.locations.id });

  const [user] = await getAdminDb()
    .insert(schema.users)
    .values({ email: `sla-${label}-${suffix}@example.com`, name: "Deniz" })
    .returning({ id: schema.users.id });

  await getAdminDb()
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: user!.id, role: "owner" });

  return { orgId: org.id, locationId: location!.id, userId: user!.id };
}

async function addReview(
  fixture: Fixture,
  options: {
    dueHoursAgo?: number | null;
    status?: "open" | "in_progress" | "done" | "ignored";
    firstResponseAt?: Date | null;
  } = {},
): Promise<string> {
  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      source: "mock",
      sourceReviewId: `s-${suffix}-${counter++}`,
      authorName: "Selin",
      rating: 2,
      text: "Servis yavaştı.",
      postedAt: new Date(Date.now() - 48 * 3_600_000),
      rawPayload: {},
      status: options.status ?? "open",
      firstResponseAt: options.firstResponseAt ?? null,
      slaDueAt:
        options.dueHoursAgo === null || options.dueHoursAgo === undefined
          ? null
          : new Date(Date.now() - options.dueHoursAgo * 3_600_000),
    })
    .returning({ id: schema.reviews.id });

  return review!.id;
}

async function alertsOfType(orgId: string, type: "sla_breach" | "sla_rollup") {
  return getAdminDb()
    .select()
    .from(schema.notifications)
    .where(
      and(eq(schema.notifications.organizationId, orgId), eq(schema.notifications.type, type)),
    );
}

async function breachAlerts(orgId: string) {
  return getAdminDb()
    .select()
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.organizationId, orgId),
        eq(schema.notifications.type, "sla_breach"),
      ),
    );
}

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("a new mock review reaching the inbox", () => {
  it("surfaces in the open inbox and fires an alert", async () => {
    const fixture = await makeFixture(`ingest-${counter++}`);

    // Connected the way the app connects it, so the config the connector
    // validates is the one a real source would have.
    const connection = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      connectSource(tx, {
        organizationId: fixture.orgId,
        provider: "mock",
        config: { locationId: fixture.locationId, backfillCount: 12 },
      }),
    );

    await syncConnection(fixture.orgId, connection.id, { full: true, ignoreSchedule: true });

    const page = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listInbox(tx, fixture.orgId, fixture.locationId, {
        ...toInboxFilters({ ...EMPTY_INBOX_FILTERS, status: ["open"] }),
      }),
    );

    // Every ingested review lands `open`, with a deadline, and appears under the
    // default triage filter — the whole point of "surfaces in the open inbox".
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((row) => row.status === "open")).toBe(true);
    expect(page.rows.every((row) => row.slaDueAt !== null)).toBe(true);

    // A review that arrived *after* the backfill. The first sync is history and
    // notifies nobody (W1.3), so without this there would be nothing to alert
    // about and the assertion below would be testing silence.
    await getAdminDb()
      .insert(schema.reviews)
      .values({
        organizationId: fixture.orgId,
        locationId: fixture.locationId,
        source: "mock",
        sourceReviewId: `arrived-${counter++}`,
        authorName: "Zeynep",
        rating: 2,
        text: "Bugün geldim, servis çok yavaştı.",
        postedAt: new Date(),
        rawPayload: {},
      });

    const outcome = await notifyPendingReviews({ organizationId: fixture.orgId });
    expect(outcome.created).toBeGreaterThan(0);

    const alerts = await getAdminDb()
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.organizationId, fixture.orgId),
          eq(schema.notifications.type, "new_review"),
        ),
      );

    // The mock feed contains one-star reviews, so at least one alert has to be
    // urgent — "the right notification" is not just "a notification".
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.some((alert) => alert.urgency === "urgent")).toBe(true);
  });
});

describe("alerting on a lapsed deadline", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`breach-${counter++}`);
  });

  it("alerts once a deadline has passed unanswered", async () => {
    await addReview(fixture, { dueHoursAgo: 2 });

    const outcome = await notifySlaBreaches({ organizationId: fixture.orgId });

    expect(outcome.created).toBe(1);
    const alerts = await breachAlerts(fixture.orgId);
    expect(alerts).toHaveLength(1);
    // A breach is urgent by definition — the team's own promise has lapsed.
    expect(alerts[0]?.urgency).toBe("urgent");
  });

  it("says nothing about a deadline that has not passed yet", async () => {
    // A warning is a colour on a card. Interrupting somebody about something
    // that has not happened is how people learn to ignore alerts.
    await addReview(fixture, { dueHoursAgo: -5 });

    expect((await notifySlaBreaches({ organizationId: fixture.orgId })).created).toBe(0);
  });

  it("says nothing about a review somebody answered", async () => {
    const id = await addReview(fixture, { dueHoursAgo: 6 });
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      recordFirstResponse(tx, fixture.orgId, id, new Date()),
    );

    expect((await notifySlaBreaches({ organizationId: fixture.orgId })).created).toBe(0);
  });

  it("says nothing about a review closed some other way", async () => {
    // Someone phoned the customer, or it was spam. Chasing it is noise.
    await addReview(fixture, { dueHoursAgo: 6, status: "done" });
    await addReview(fixture, { dueHoursAgo: 6, status: "ignored" });

    expect((await notifySlaBreaches({ organizationId: fixture.orgId })).created).toBe(0);
  });

  it("still alerts on something a person has picked up but not answered", async () => {
    await addReview(fixture, { dueHoursAgo: 6, status: "in_progress" });

    expect((await notifySlaBreaches({ organizationId: fixture.orgId })).created).toBe(1);
  });

  it("says nothing about a review with no deadline at all", async () => {
    await addReview(fixture, { dueHoursAgo: null });

    expect((await notifySlaBreaches({ organizationId: fixture.orgId })).created).toBe(0);
  });

  it("alerts exactly once, however often the sweep runs", async () => {
    // The sweep re-examines rows nothing has touched, so without the dedupe key
    // it would re-alert every five minutes, forever.
    await addReview(fixture, { dueHoursAgo: 2 });

    await notifySlaBreaches({ organizationId: fixture.orgId });
    const second = await notifySlaBreaches({ organizationId: fixture.orgId });

    expect(second.created).toBe(0);
    expect(await breachAlerts(fixture.orgId)).toHaveLength(1);
  });

  it("reaches someone who already read the arrival of the same review", async () => {
    // Two facts, two alerts. The type is part of the dedupe key precisely so a
    // breach is not swallowed by the arrival somebody has already dismissed.
    const id = await addReview(fixture, { dueHoursAgo: 2 });

    await notifyPendingReviews({ organizationId: fixture.orgId });
    await getAdminDb()
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(eq(schema.notifications.reviewId, id));

    await notifySlaBreaches({ organizationId: fixture.orgId });

    const alerts = await breachAlerts(fixture.orgId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.readAt).toBeNull();
  });

  it("reports the whole backlog on the very first sweep", async () => {
    // The first thing a team hears about their backlog should be true. A
    // deadline that lapsed a month ago is still a customer who never got an
    // answer, and hiding it behind the window would say "52 overdue" to a team
    // that has 124.
    await addReview(fixture, { dueHoursAgo: 24 * 30 });

    expect((await notifySlaBreaches({ organizationId: fixture.orgId })).created).toBe(1);
  });

  it("ignores an ancient breach once the backlog has been reported", async () => {
    // After the first sweep the window applies: a routine sweep must not keep
    // dredging up history, or every run re-announces the same old news.
    await addReview(fixture, { dueHoursAgo: 2 });
    await notifySlaBreaches({ organizationId: fixture.orgId });

    await addReview(fixture, { dueHoursAgo: 24 * 30 });

    expect((await notifySlaBreaches({ organizationId: fixture.orgId })).created).toBe(0);
  });

  it("treats a sweep that reported nothing as still the first", async () => {
    // Nothing has been stamped, so nothing has been reported — an organization
    // whose backlog is entirely ancient still gets told about it.
    await notifySlaBreaches({ organizationId: fixture.orgId });
    await addReview(fixture, { dueHoursAgo: 24 * 60 });

    expect((await notifySlaBreaches({ organizationId: fixture.orgId })).created).toBe(1);
  });

  it("does not leak across organizations", async () => {
    const neighbour = await makeFixture(`breach-other-${counter++}`);
    await addReview(neighbour, { dueHoursAgo: 2 });

    expect((await notifySlaBreaches({ organizationId: fixture.orgId })).created).toBe(0);
    expect(await breachAlerts(fixture.orgId)).toHaveLength(0);
    expect((await notifySlaBreaches({ organizationId: neighbour.orgId })).created).toBe(1);
  });
});

describe("rolling a backlog up", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`rollup-${counter++}`);
  });

  it("sends one summary instead of an alert per review", async () => {
    // The first sweep against an existing installation is exactly this shape:
    // every deadline that ever lapsed becomes news at once. Fifty-one urgent
    // items in one feed is accurate and useless.
    const many = SLA_ROLLUP_THRESHOLD + 3;
    for (let index = 0; index < many; index += 1) {
      await addReview(fixture, { dueHoursAgo: 2 });
    }

    const outcome = await notifySlaBreaches({ organizationId: fixture.orgId });

    expect(outcome.reviews).toBe(many);
    expect(await alertsOfType(fixture.orgId, "sla_breach")).toHaveLength(0);

    const rollups = await alertsOfType(fixture.orgId, "sla_rollup");
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.urgency).toBe("urgent");
    expect(rollups[0]?.reviewId).toBeNull();
    expect(rollups[0]?.payload).toMatchObject({ count: many, locationName: "Kadıköy" });
  });

  it("still alerts per review while the number is small enough to act on", async () => {
    for (let index = 0; index < SLA_ROLLUP_THRESHOLD; index += 1) {
      await addReview(fixture, { dueHoursAgo: 2 });
    }

    await notifySlaBreaches({ organizationId: fixture.orgId });

    expect(await alertsOfType(fixture.orgId, "sla_breach")).toHaveLength(SLA_ROLLUP_THRESHOLD);
    expect(await alertsOfType(fixture.orgId, "sla_rollup")).toHaveLength(0);
  });

  it("does not report the same backlog twice", async () => {
    // The reviews are claimed by stamping them, so nothing a rollup covered
    // comes back — which is the whole reason a rollup can exist at all.
    for (let index = 0; index < SLA_ROLLUP_THRESHOLD + 3; index += 1) {
      await addReview(fixture, { dueHoursAgo: 2 });
    }

    await notifySlaBreaches({ organizationId: fixture.orgId });
    const second = await notifySlaBreaches({ organizationId: fixture.orgId });

    expect(second.reviews).toBe(0);
    expect(second.created).toBe(0);
    expect(await alertsOfType(fixture.orgId, "sla_rollup")).toHaveLength(1);
  });

  it("reports later breaches on their own merits", async () => {
    for (let index = 0; index < SLA_ROLLUP_THRESHOLD + 3; index += 1) {
      await addReview(fixture, { dueHoursAgo: 2 });
    }
    await notifySlaBreaches({ organizationId: fixture.orgId });

    // One more lapses afterwards: a backlog was rolled up, this is one review.
    await addReview(fixture, { dueHoursAgo: 1 });
    const second = await notifySlaBreaches({ organizationId: fixture.orgId });

    expect(second.reviews).toBe(1);
    expect(await alertsOfType(fixture.orgId, "sla_breach")).toHaveLength(1);
    expect(await alertsOfType(fixture.orgId, "sla_rollup")).toHaveLength(1);
  });

  it("marks every review it reported, however it reported them", async () => {
    for (let index = 0; index < SLA_ROLLUP_THRESHOLD + 3; index += 1) {
      await addReview(fixture, { dueHoursAgo: 2 });
    }
    await notifySlaBreaches({ organizationId: fixture.orgId });

    const unmarked = await getAdminDb()
      .select()
      .from(schema.reviews)
      .where(
        and(eq(schema.reviews.organizationId, fixture.orgId), isNull(schema.reviews.slaAlertedAt)),
      );

    // Nineteen of twenty left looking unreported is how a rollup would
    // otherwise re-announce the same pile every five minutes, forever.
    expect(unmarked).toHaveLength(0);
  });
});
