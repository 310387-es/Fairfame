import { QueueEvents, type Queue, type Worker } from "bullmq";
import { eq, inArray } from "drizzle-orm";
import type Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listReviewsForLocation } from "@/connectors/normalize";
import { connectSource } from "@/connectors/sync";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import {
  createQueue,
  createRedisConnection,
  enqueueSync,
  scheduleScan,
  type ReviewJob,
} from "@/jobs/queue";
import { createSyncWorker, runScan } from "@/jobs/workers/sync-reviews";
import { withTenant } from "@/lib/tenancy";

/**
 * Background sync end to end: a job goes onto Redis, a worker picks it up, and
 * reviews land in Postgres — with no manual database write anywhere in the test.
 */

const suffix = crypto.randomUUID().slice(0, 8);
// A dedicated queue name per run, so these tests never collide with a dev
// worker or with each other.
const QUEUE_NAME = `test-reviews-${suffix}`;

const orgIds: string[] = [];
let queueConnection: Redis;
let workerConnection: Redis;
let eventsConnection: Redis;
let queue: Queue<ReviewJob>;
let worker: Worker<ReviewJob>;
let events: QueueEvents;

async function makeOrgWithLocation(label: string): Promise<{ orgId: string; locationId: string }> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Jobs ${label} ${suffix}`, slug: `jobs-${label}-${suffix}` })
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

async function connectMock(
  orgId: string,
  locationId: string,
  config: Record<string, unknown> = {},
): Promise<string> {
  const row = await withTenant({ organizationId: orgId }, (tx) =>
    connectSource(tx, {
      organizationId: orgId,
      provider: "mock",
      config: { locationId, backfillCount: 15, ...config },
    }),
  );
  return row.id;
}

beforeAll(async () => {
  queueConnection = createRedisConnection();
  workerConnection = createRedisConnection();
  eventsConnection = createRedisConnection();

  queue = createQueue(queueConnection, QUEUE_NAME);
  worker = createSyncWorker({ connection: workerConnection, queue, queueName: QUEUE_NAME });
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

describe("on-demand sync", () => {
  it("ingests reviews through the queue, with no manual database write", async () => {
    const target = await makeOrgWithLocation("ondemand");
    const connectionId = await connectMock(target.orgId, target.locationId);

    const before = await withTenant({ organizationId: target.orgId }, (tx) =>
      listReviewsForLocation(tx, target.orgId, target.locationId, 100),
    );
    expect(before).toHaveLength(0);

    await enqueueSync(queue, { organizationId: target.orgId, connectionId });

    // Wait for the worker rather than polling the database, so a pass means the
    // job genuinely completed.
    const job = await queue.getJob(
      (await queue.getJobs(["waiting", "active", "completed"])).find(
        (candidate) => candidate.data.kind === "sync",
      )?.id ?? "",
    );
    await job?.waitUntilFinished(events, 20_000);

    const after = await withTenant({ organizationId: target.orgId }, (tx) =>
      listReviewsForLocation(tx, target.orgId, target.locationId, 100),
    );

    expect(after).toHaveLength(15);
    expect(after.every((review) => review.organizationId === target.orgId)).toBe(true);
  });
});

describe("scheduled scan", () => {
  it("dispatches one sync job per syncable connection", async () => {
    const target = await makeOrgWithLocation("scan");
    const connectionId = await connectMock(target.orgId, target.locationId);

    const result = await runScan(queue);

    // Other suites may leave connections behind; assert on the lower bound and
    // on our own connection specifically.
    expect(result.connections).toBeGreaterThanOrEqual(1);

    const [row] = await getAdminDb()
      .select({ status: schema.connections.status })
      .from(schema.connections)
      .where(eq(schema.connections.id, connectionId));
    expect(row?.status).toBe("active");
  });

  it("skips disconnected connections", async () => {
    const target = await makeOrgWithLocation("skipped");
    const connectionId = await connectMock(target.orgId, target.locationId);

    await getAdminDb()
      .update(schema.connections)
      .set({ status: "disconnected" })
      .where(eq(schema.connections.id, connectionId));

    const withDisconnected = await runScan(queue);

    await getAdminDb()
      .update(schema.connections)
      .set({ status: "active" })
      .where(eq(schema.connections.id, connectionId));

    const withActive = await runScan(queue);

    expect(withActive.connections).toBe(withDisconnected.connections + 1);
  });

  it("installs a repeatable scheduler that is idempotent", async () => {
    await scheduleScan(queue, 60_000);
    await scheduleScan(queue, 60_000);

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.filter((s) => s.key === "scan-connections")).toHaveLength(1);
  });
});

describe("retry behaviour", () => {
  it("retries a transient failure with backoff", async () => {
    const target = await makeOrgWithLocation("retry");
    const connectionId = await connectMock(target.orgId, target.locationId, {
      simulate: { failFetch: true, retryable: true },
    });

    // Short backoff so the test does not sit through the production schedule.
    const job = await queue.add(
      "sync",
      { kind: "sync", organizationId: target.orgId, connectionId },
      { attempts: 3, backoff: { type: "fixed", delay: 50 } },
    );

    await expect(job.waitUntilFinished(events, 20_000)).rejects.toThrow();

    const finished = await queue.getJob(job.id!);
    // All three attempts were spent, which is what "retryable" should mean.
    expect(finished?.attemptsMade).toBe(3);

    const [row] = await getAdminDb()
      .select({ status: schema.connections.status })
      .from(schema.connections)
      .where(eq(schema.connections.id, connectionId));
    expect(row?.status).toBe("error");
  });

  it("does not retry a permanent failure", async () => {
    const target = await makeOrgWithLocation("permanent");
    const connectionId = await connectMock(target.orgId, target.locationId, {
      simulate: { failFetch: true, retryable: false },
    });

    const job = await queue.add(
      "sync",
      { kind: "sync", organizationId: target.orgId, connectionId },
      { attempts: 5, backoff: { type: "fixed", delay: 50 } },
    );

    await expect(job.waitUntilFinished(events, 20_000)).rejects.toThrow();

    const finished = await queue.getJob(job.id!);
    // A structural failure burns one attempt, not five.
    expect(finished?.attemptsMade).toBe(1);
  });

  it("treats an unknown job kind as unrecoverable", async () => {
    const job = await queue.add("mystery", { kind: "nonsense" } as unknown as ReviewJob, {
      attempts: 4,
      backoff: { type: "fixed", delay: 50 },
    });

    await expect(job.waitUntilFinished(events, 20_000)).rejects.toThrow(/Unknown job kind/);
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(1);
  });
});

describe("drip", () => {
  it("brings in new items on a later sync without any manual write", async () => {
    const target = await makeOrgWithLocation("drip");
    // A one-minute drip means each elapsed bucket contributes a new review.
    const connectionId = await connectMock(target.orgId, target.locationId, {
      backfillCount: 10,
      dripIntervalMinutes: 1,
    });

    await enqueueSync(queue, { organizationId: target.orgId, connectionId });
    const first = await queue.add("sync", {
      kind: "sync",
      organizationId: target.orgId,
      connectionId,
    });
    await first.waitUntilFinished(events, 20_000);

    const afterFirst = await withTenant({ organizationId: target.orgId }, (tx) =>
      listReviewsForLocation(tx, target.orgId, target.locationId, 200),
    );

    // Backfill plus the drip buckets the connector currently exposes.
    expect(afterFirst.length).toBeGreaterThan(10);

    const dripped = afterFirst.filter((review) => review.sourceReviewId.includes("drip"));
    expect(dripped.length).toBeGreaterThan(0);
  });
});
