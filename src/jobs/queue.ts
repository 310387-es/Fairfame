import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import Redis from "ioredis";
import { getEnv } from "../lib/env.ts";

/**
 * BullMQ wiring: the Redis connection, the queue, and the job contract.
 *
 * There is one queue with two job kinds. `scan` is the scheduled fan-out that
 * finds work; `sync` does the work for a single connection. Keeping them on one
 * queue means one worker process, one place to reason about concurrency, and no
 * chance of the two drifting apart in configuration.
 */

export const REVIEW_QUEUE = "reviews";

export type ScanJob = {
  kind: "scan";
};

export type SyncJob = {
  kind: "sync";
  organizationId: string;
  connectionId: string;
  /** Ignore the stored cursor and re-pull everything. Dedup makes this safe. */
  full?: boolean;
};

export type ReviewJob = ScanJob | SyncJob;

/**
 * BullMQ requires `maxRetriesPerRequest: null`: its blocking commands park on
 * the connection for long stretches, and ioredis' default retry ceiling would
 * tear them down mid-wait.
 */
export function createRedisConnection(url = getEnv().REDIS_URL): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  // 5s, 10s, 20s, 40s — long enough to ride out a provider blip, short enough
  // that a genuinely broken source surfaces within a few minutes.
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  // Keep failures for a day: a vanished job is an undebuggable job.
  removeOnFail: { age: 86_400 },
};

export function createQueue(connection: ConnectionOptions, name = REVIEW_QUEUE): Queue<ReviewJob> {
  return new Queue<ReviewJob>(name, { connection, defaultJobOptions });
}

/**
 * Stable job id per connection, so a backlog cannot accumulate duplicate syncs
 * for the same source while one is already waiting.
 */
export function syncJobId(connectionId: string): string {
  return `sync:${connectionId}`;
}

/** Queues an immediate sync for one connection. */
export async function enqueueSync(
  queue: Queue<ReviewJob>,
  input: { organizationId: string; connectionId: string; full?: boolean },
): Promise<void> {
  await queue.add(
    "sync",
    { kind: "sync", ...input },
    { jobId: `${syncJobId(input.connectionId)}:${Date.now()}` },
  );
}

export const SCAN_SCHEDULER_ID = "scan-connections";

/**
 * Installs the repeating scan. Idempotent — re-running with the same scheduler
 * id updates the schedule instead of stacking another one.
 */
export async function scheduleScan(queue: Queue<ReviewJob>, everyMs = 60_000): Promise<void> {
  await queue.upsertJobScheduler(
    SCAN_SCHEDULER_ID,
    { every: everyMs },
    { name: "scan", data: { kind: "scan" } },
  );
}
