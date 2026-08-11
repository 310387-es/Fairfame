import { QueueEvents, type Job, type Queue, type Worker } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import type Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectSource } from "@/connectors/sync";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import {
  createQueue,
  createRedisConnection,
  enqueueAnalyze,
  enqueueSync,
  scheduleAnalyzeSweep,
  ANALYZE_SWEEP_SCHEDULER_ID,
  type ReviewJob,
} from "@/jobs/queue";
import { runNotifySweep } from "@/jobs/workers/notify-reviews";
import { runAnalyze, runAnalyzeSweep } from "@/jobs/workers/analyze-reviews";
import { createReviewWorker } from "@/jobs/workers/sync-reviews";
import { currentPeriod, withinLimit } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";

/**
 * Ingestion to insights, with nothing done by hand (P1a-T4).
 *
 * The claim under test is the Definition of Done's: connecting a Mock source
 * yields *analyzed* reviews with zero manual steps. So these tests drive the
 * queue and assert on `review_insights`, never calling the analysis code
 * directly except where the subject is the job's own logic.
 *
 * The provider is the offline stub — forced in tests/db/setup.ts, since .env
 * carries a real key and a test suite must not spend money.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const QUEUE_NAME = `test-analysis-${suffix}`;

const orgIds: string[] = [];
let queueConnection: Redis;
let workerConnection: Redis;
let eventsConnection: Redis;
let queue: Queue<ReviewJob>;
let worker: Worker<ReviewJob>;
let events: QueueEvents;

async function makeOrgWithLocation(label: string) {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Pipe ${label} ${suffix}`, slug: `pipe-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Şubesi` })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  return { orgId: org.id, locationId: location.id };
}

async function connectMock(orgId: string, locationId: string, backfillCount = 6): Promise<string> {
  const row = await withTenant({ organizationId: orgId }, (tx) =>
    connectSource(tx, {
      organizationId: orgId,
      provider: "mock",
      config: { locationId, backfillCount },
    }),
  );
  return row.id;
}

async function insightsFor(orgId: string) {
  return getAdminDb()
    .select()
    .from(schema.reviewInsights)
    .where(eq(schema.reviewInsights.organizationId, orgId));
}

async function reviewsFor(orgId: string) {
  return getAdminDb()
    .select({ id: schema.reviews.id, text: schema.reviews.text })
    .from(schema.reviews)
    .where(eq(schema.reviews.organizationId, orgId));
}

/**
 * Waits for the queue to go quiet — the jobs chain, so one wait is not enough.
 *
 * **Empty once is not empty.** These jobs enqueue each other: sync enqueues
 * analyze, analyze enqueues notify. Between a processor returning and the child
 * it just added appearing in `wait`, there is a window in which every count
 * reads zero and the queue is not finished. Returning there is a real race, and
 * it produced a flake in "does not notify twice" — `first` was captured before
 * the notify job ran, the alert then landed, and the second half of the test
 * counted one more than it started with. Once in ~40 runs, which is the worst
 * frequency: often enough to fail CI, rare enough to look like someone else's
 * problem.
 *
 * So it waits for the queue to be empty on `QUIET_PASSES` *consecutive* polls.
 * The window is one event-loop hop wide and this spans several hundred
 * milliseconds of them, which is the difference between checking a condition and
 * checking that it has settled.
 */
const QUIET_PASSES = 3;

async function drain(timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;

  while (Date.now() < deadline) {
    const counts = await queue.getJobCounts("wait", "active", "delayed");
    const outstanding = (counts.wait ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);

    quiet = outstanding === 0 ? quiet + 1 : 0;
    if (quiet >= QUIET_PASSES) return;

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error("Queue did not drain in time.");
}

/** A job object shaped like the one BullMQ hands a processor. */
function fakeJob(data: ReviewJob): Job<ReviewJob> {
  return { data, attemptsMade: 0 } as Job<ReviewJob>;
}

beforeAll(async () => {
  queueConnection = createRedisConnection();
  workerConnection = createRedisConnection();
  eventsConnection = createRedisConnection();

  queue = createQueue(queueConnection, QUEUE_NAME);
  worker = createReviewWorker({ connection: workerConnection, queue, queueName: QUEUE_NAME });
  events = new QueueEvents(QUEUE_NAME, { connection: eventsConnection });

  await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
});

afterAll(async () => {
  await worker.close();
  await events.close();
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await Promise.all([queueConnection.quit(), workerConnection.quit(), eventsConnection.quit()]);

  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("sync to insights", () => {
  it("analyzes reviews a sync ingested, with no manual step", async () => {
    const target = await makeOrgWithLocation("auto");
    const connectionId = await connectMock(target.orgId, target.locationId);

    await enqueueSync(queue, { organizationId: target.orgId, connectionId });
    await drain();

    const reviews = await reviewsFor(target.orgId);
    const insights = await insightsFor(target.orgId);

    // This is the Definition of Done, asserted directly.
    expect(reviews.length).toBeGreaterThan(0);
    expect(insights).toHaveLength(reviews.filter((row) => row.text).length);
  });

  it("gives every insight a sentiment, topics and a content hash", async () => {
    const target = await makeOrgWithLocation("shape");
    const connectionId = await connectMock(target.orgId, target.locationId);

    await enqueueSync(queue, { organizationId: target.orgId, connectionId });
    await drain();

    const insights = await insightsFor(target.orgId);

    expect(insights.length).toBeGreaterThan(0);
    expect(insights.every((row) => row.topics.length > 0)).toBe(true);
    expect(insights.every((row) => row.contentHash !== null)).toBe(true);
    expect(insights.every((row) => row.embedding !== null)).toBe(true);
  });

  it("does no analysis work when a re-sync changes nothing", async () => {
    const target = await makeOrgWithLocation("resync");
    const connectionId = await connectMock(target.orgId, target.locationId);

    await enqueueSync(queue, { organizationId: target.orgId, connectionId });
    await drain();

    const first = await insightsFor(target.orgId);
    const analyzedAt = first.map((row) => row.analyzedAt?.getTime()).sort();

    await enqueueSync(queue, { organizationId: target.orgId, connectionId, full: true });
    await drain();

    const second = await insightsFor(target.orgId);

    // A full re-pull touches every review row. If analysis keyed off that
    // rather than the text, every insight would carry a new timestamp.
    expect(second).toHaveLength(first.length);
    expect(second.map((row) => row.analyzedAt?.getTime()).sort()).toEqual(analyzedAt);
  });

  it("re-analyzes a review whose text was edited", async () => {
    const target = await makeOrgWithLocation("edited");
    const connectionId = await connectMock(target.orgId, target.locationId);

    await enqueueSync(queue, { organizationId: target.orgId, connectionId });
    await drain();

    const [review] = await reviewsFor(target.orgId);
    const [before] = await getAdminDb()
      .select()
      .from(schema.reviewInsights)
      .where(eq(schema.reviewInsights.reviewId, review!.id));

    await getAdminDb()
      .update(schema.reviews)
      .set({ text: "Tamamen farklı bir yorum: servis berbattı ve yemek soğuktu." })
      .where(eq(schema.reviews.id, review!.id));

    await enqueueAnalyze(queue, { organizationId: target.orgId });
    await drain();

    const [after] = await getAdminDb()
      .select()
      .from(schema.reviewInsights)
      .where(eq(schema.reviewInsights.reviewId, review!.id));

    expect(after?.contentHash).not.toBe(before?.contentHash);
    // Upsert, not insert: one review still has exactly one insight.
    expect(await insightsFor(target.orgId)).toHaveLength(
      before ? (await reviewsFor(target.orgId)).length : 0,
    );
  });
});

describe("the sweep", () => {
  it("finds an organization whose reviews were never analyzed", async () => {
    const target = await makeOrgWithLocation("sweep");
    const connectionId = await connectMock(target.orgId, target.locationId);

    // Sync directly, bypassing the worker, so nothing enqueues analysis. This
    // is the shape of a job lost to a crash, or a review predating the feature.
    const { syncConnection } = await import("@/connectors/sync");
    await syncConnection(target.orgId, connectionId);

    expect(await insightsFor(target.orgId)).toHaveLength(0);

    const result = await runAnalyzeSweep(queue);
    await drain();

    expect(result.organizations).toBeGreaterThan(0);
    expect((await insightsFor(target.orgId)).length).toBeGreaterThan(0);
  });

  it("dispatches nothing once everything is analyzed", async () => {
    // Any other org's stale reviews would also be picked up, so this asserts
    // on whether *this* org appears rather than on a global count of zero.
    const target = await makeOrgWithLocation("quiet");
    const connectionId = await connectMock(target.orgId, target.locationId);

    await enqueueSync(queue, { organizationId: target.orgId, connectionId });
    await drain();

    const before = await insightsFor(target.orgId);
    await runAnalyzeSweep(queue);
    await drain();

    const after = await insightsFor(target.orgId);
    expect(after.map((row) => row.analyzedAt?.getTime()).sort()).toEqual(
      before.map((row) => row.analyzedAt?.getTime()).sort(),
    );
  });

  it("registers a repeating schedule, idempotently", async () => {
    await scheduleAnalyzeSweep(queue, 300_000);
    await scheduleAnalyzeSweep(queue, 300_000);

    const schedulers = await queue.getJobSchedulers();
    const sweeps = schedulers.filter((entry) => entry.key === ANALYZE_SWEEP_SCHEDULER_ID);

    expect(sweeps).toHaveLength(1);

    // Remove it again: a scheduler parks a delayed job in the queue forever,
    // and every later test here waits for the queue to reach zero.
    await queue.removeJobScheduler(ANALYZE_SWEEP_SCHEDULER_ID);
  });
});

describe("the monthly plan limit", () => {
  async function setUsage(orgId: string, metric: string, count: number) {
    await getAdminDb()
      .insert(schema.usageCounters)
      .values({ organizationId: orgId, metric, period: currentPeriod(), count })
      .onConflictDoUpdate({
        target: [
          schema.usageCounters.organizationId,
          schema.usageCounters.metric,
          schema.usageCounters.period,
        ],
        set: { count },
      });
  }

  async function usageOf(orgId: string, metric: string): Promise<number> {
    const [row] = await getAdminDb()
      .select({ count: schema.usageCounters.count })
      .from(schema.usageCounters)
      .where(
        and(
          eq(schema.usageCounters.organizationId, orgId),
          eq(schema.usageCounters.metric, metric),
          eq(schema.usageCounters.period, currentPeriod()),
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * The effective ceiling, asked for rather than written down.
   *
   * Since the 11 Aug 2026 repricing the catalog stores a *per-location* figure
   * and the resolver multiplies it by the organization's locations, so a
   * hardcoded 250 here stopped being the allowance and became an arbitrary
   * number below it — which is why these tests failed by analyzing anyway.
   * Deriving it means the next repricing moves them too.
   */
  async function allowanceOf(organizationId: string): Promise<number> {
    const { limit } = await withinLimit(organizationId, "ai_analyses_per_month", { additional: 0 });
    if (limit === null) throw new Error("expected a finite analysis allowance");
    return limit;
  }

  it("meters each analyzed review against the allowance", async () => {
    const target = await makeOrgWithLocation("meter");
    const connectionId = await connectMock(target.orgId, target.locationId);

    await enqueueSync(queue, { organizationId: target.orgId, connectionId });
    await drain();

    const insights = await insightsFor(target.orgId);
    expect(await usageOf(target.orgId, "ai_analyses_per_month")).toBe(insights.length);
  });

  it("stops analyzing once the allowance is spent", async () => {
    const target = await makeOrgWithLocation("capped");
    const connectionId = await connectMock(target.orgId, target.locationId);

    // Spend the whole allowance, whatever the plan currently grants.
    await setUsage(target.orgId, "ai_analyses_per_month", await allowanceOf(target.orgId));

    await enqueueSync(queue, { organizationId: target.orgId, connectionId });
    await drain();

    // Reviews still ingest — ingestion is not the metered resource — but a
    // tenant over its plan must not keep spending our tokens.
    expect((await reviewsFor(target.orgId)).length).toBeGreaterThan(0);
    expect(await insightsFor(target.orgId)).toHaveLength(0);
  });

  it("reports the ceiling as skipped rather than as a failure", async () => {
    const target = await makeOrgWithLocation("skipped");
    await setUsage(target.orgId, "ai_analyses_per_month", await allowanceOf(target.orgId));

    const result = await runAnalyze(
      fakeJob({ kind: "analyze", organizationId: target.orgId }),
      queue,
    );

    // A retry cannot fix a billing period, so this must not throw.
    expect(result.skipped).toBe("limit_reached");
    expect(result.analyzed).toBe(0);
  });

  it("analyzes only what is left of a partial allowance", async () => {
    const target = await makeOrgWithLocation("partial");
    const connectionId = await connectMock(target.orgId, target.locationId, 8);

    // Three left of eight synced: the partial allowance is the point, so it is
    // measured back from the ceiling rather than stated as a literal.
    const allowance = await allowanceOf(target.orgId);
    await setUsage(target.orgId, "ai_analyses_per_month", allowance - 3);

    const { syncConnection } = await import("@/connectors/sync");
    await syncConnection(target.orgId, connectionId);

    const result = await runAnalyze(
      fakeJob({ kind: "analyze", organizationId: target.orgId }),
      queue,
    );

    expect(result.analyzed).toBe(3);
    expect(await usageOf(target.orgId, "ai_analyses_per_month")).toBe(allowance);
  });
});

describe("tenant isolation", () => {
  it("never writes insights for another organization", async () => {
    const mine = await makeOrgWithLocation("iso-mine");
    const theirs = await makeOrgWithLocation("iso-theirs");

    const mineConnection = await connectMock(mine.orgId, mine.locationId);
    await connectMock(theirs.orgId, theirs.locationId);

    await enqueueSync(queue, { organizationId: mine.orgId, connectionId: mineConnection });
    await drain();

    expect((await insightsFor(mine.orgId)).length).toBeGreaterThan(0);
    expect(await insightsFor(theirs.orgId)).toHaveLength(0);
  });
});

describe("sync to notification", () => {
  /**
   * The other half of the Definition of Done for T5: a mock review must reach
   * a person, through the queue, without anyone calling the notifier.
   *
   * A member is needed for that, which the other fixtures here do not have —
   * they only prove insights get written.
   */
  async function makeOrgWithMember(label: string) {
    const target = await makeOrgWithLocation(label);

    const [user] = await getAdminDb()
      .insert(schema.users)
      .values({
        email: `${label}-${suffix}@example.test`,
        name: label,
        locale: "en",
        emailVerified: true,
      })
      .returning({ id: schema.users.id });

    await getAdminDb()
      .insert(schema.memberships)
      .values({ organizationId: target.orgId, userId: user!.id, role: "owner" });

    return { ...target, userId: user!.id };
  }

  async function notificationsFor(orgId: string) {
    return getAdminDb()
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.organizationId, orgId));
  }

  /**
   * Arrives at the review a person is actually told about (W1.3).
   *
   * This test used to sync once and assert one notification per review, which
   * is precisely the behaviour the audit reported: connect a source, and every
   * review the business ever received arrives as an alert. The pipeline half of
   * the T5 Definition of Done — "a mock review reaches a person, through the
   * queue, without anyone calling the notifier" — is unchanged and still
   * asserted; what changed is which review qualifies.
   */
  it("stays quiet through the backfill, then notifies about what arrives after it", async () => {
    const target = await makeOrgWithMember("notify");
    const connectionId = await connectMock(target.orgId, target.locationId);

    await enqueueSync(queue, { organizationId: target.orgId, connectionId });
    await drain();

    // Reviews landed, and nobody was told: a first sync is history.
    expect((await reviewsFor(target.orgId)).length).toBeGreaterThan(0);
    expect(await notificationsFor(target.orgId)).toHaveLength(0);

    const [arrived] = await getAdminDb()
      .insert(schema.reviews)
      .values({
        organizationId: target.orgId,
        locationId: target.locationId,
        source: "mock",
        sourceReviewId: `after-backfill-${suffix}`,
        authorName: "Zeynep",
        rating: 5,
        text: "Bugün geldim, harikaydı.",
        postedAt: new Date(),
        rawPayload: {},
      })
      .returning({ id: schema.reviews.id });

    await runNotifySweep(queue);
    await drain();

    const notifications = await notificationsFor(target.orgId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.reviewId).toBe(arrived!.id);
  });

  it("marks a negative review urgent on its way through the pipeline", async () => {
    const target = await makeOrgWithMember("notify-urgent");
    const connectionId = await connectMock(target.orgId, target.locationId);

    await enqueueSync(queue, { organizationId: target.orgId, connectionId });
    await drain();

    // A review with a rating we control, rather than trusting the mock to seed
    // a low one — its ratings vary per connection, which made this flaky.
    const [angry] = await getAdminDb()
      .insert(schema.reviews)
      .values({
        organizationId: target.orgId,
        locationId: target.locationId,
        source: "mock",
        sourceReviewId: `angry-${suffix}`,
        authorName: "Mehmet",
        rating: 1,
        text: "Bir saat bekledik ve yemek soğuktu.",
        rawPayload: {},
      })
      .returning({ id: schema.reviews.id });

    await runNotifySweep(queue);
    await drain();

    // Assert on this review specifically: the mock also seeds low ratings of
    // its own, so counting urgent rows across the organization proves nothing.
    const forAngry = (await notificationsFor(target.orgId)).filter(
      (row) => row.reviewId === angry!.id,
    );

    expect(forAngry).toHaveLength(1);
    expect(forAngry[0]?.urgency).toBe("urgent");
  });

  it("does not notify twice when the pipeline runs again", async () => {
    const target = await makeOrgWithMember("notify-twice");
    const connectionId = await connectMock(target.orgId, target.locationId);

    await enqueueSync(queue, { organizationId: target.orgId, connectionId });
    await drain();
    const first = (await notificationsFor(target.orgId)).length;

    // Analysis re-enqueues notify, and the sweep may too. Neither may produce
    // a duplicate alert.
    await enqueueAnalyze(queue, { organizationId: target.orgId, recompute: true });
    await drain();
    await runNotifySweep(queue);
    await drain();

    expect((await notificationsFor(target.orgId)).length).toBe(first);
  });

  it("is picked up by the sweep when nothing enqueued it", async () => {
    const target = await makeOrgWithMember("notify-sweep");
    const connectionId = await connectMock(target.orgId, target.locationId);

    // Sync directly, bypassing the worker: the shape of a job lost to a crash.
    const { syncConnection } = await import("@/connectors/sync");
    await syncConnection(target.orgId, connectionId);

    // Something that genuinely arrived after the backfill — otherwise there is
    // nothing for the sweep to find, and this would pass while asleep (W1.3).
    await getAdminDb()
      .insert(schema.reviews)
      .values({
        organizationId: target.orgId,
        locationId: target.locationId,
        source: "mock",
        sourceReviewId: `after-crash-${suffix}`,
        authorName: "Zeynep",
        rating: 4,
        text: "Az önce uğradım.",
        postedAt: new Date(),
        rawPayload: {},
      });

    expect(await notificationsFor(target.orgId)).toHaveLength(0);

    await runNotifySweep(queue);
    await drain();

    expect((await notificationsFor(target.orgId)).length).toBeGreaterThan(0);
  });
});
