import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import Redis from "ioredis";
import { getEnv } from "../lib/env.ts";

/**
 * BullMQ wiring: the Redis connection, the queue, and the job contract.
 *
 * One queue, nine job kinds, in four pairs that follow the same shape — a
 * scheduled fan-out that finds work, and a job that does it for one tenant:
 *
 *   `scan` → `sync`             poll every due connection for new reviews
 *   `analyze_sweep` → `analyze` analyze every review that lacks fresh insights
 *   `notify_sweep` → `notify`   alert the team about reviews they have not seen
 *   `digest_sweep` → `digest`   compose the weekly briefing, per *location*
 *
 * The ninth breaks the pattern: `digest_deliver` mails a briefing that is
 * already composed, and the same `digest_sweep` fans it out, because composing
 * and sending are the two halves of one weekly cadence rather than two
 * schedules that would have to be kept in step.
 *
 * Keeping them on one queue means one worker process, one place to reason about
 * concurrency, and no chance of the two drifting apart in configuration.
 *
 * The sweep is what makes the pipeline self-healing. Analysis is also enqueued
 * directly by a sync that changed something — the fast path — but a job lost to
 * a crash, a review that predates the feature, or a run cut short by a monthly
 * limit would otherwise sit unanalyzed forever. The sweep finds all three.
 */

export const REVIEW_QUEUE = "reviews";

/**
 * Builds a custom job id.
 *
 * **Never a colon.** BullMQ 6 rejects a custom id containing `:` *unless it
 * splits into exactly three parts* — a compatibility shim its own source marks
 * for removal ("TODO: replace this check in next breaking change with
 * include(':')"). Ids that happen to have three segments pass today and would
 * break on that change; one with an embedded ISO timestamp fails immediately,
 * because the timestamp brings colons of its own. That is a real bug this
 * project shipped, caught by pressing "Generate now".
 *
 * So the separator is `~`, and every part is stripped of colons. Nothing here
 * depends on how BullMQ counts segments.
 */
export function jobId(...parts: (string | number)[]): string {
  return parts.map((part) => String(part).replaceAll(":", "-")).join("~");
}

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

export type AnalyzeJob = {
  kind: "analyze";
  organizationId: string;
  /** Ignore the content-hash cache and re-analyze everything in scope. */
  recompute?: boolean;
};

export type AnalyzeSweepJob = {
  kind: "analyze_sweep";
};

export type NotifyJob = {
  kind: "notify";
  organizationId: string;
};

export type NotifySweepJob = {
  kind: "notify_sweep";
};

/**
 * Alerts on response deadlines that have lapsed (P2-T7).
 *
 * Its own sweep rather than a branch of `notify_sweep`, because the two are
 * triggered by different things. An arrival alert is caused by an *event* — a
 * row appeared — and the sweep is a safety net behind the sync that already
 * enqueued one. A breach is caused by *time passing*, so nothing will ever
 * enqueue it; the sweep is the only thing that can notice, and it has to keep
 * looking at rows that have not changed.
 */
export type SlaSweepJob = {
  kind: "sla_sweep";
};

/**
 * Reports collected marketing permissions to İYS (P1b-T5).
 *
 * A sweep for the same reason the SLA one is: the trigger is a deadline, and
 * deadlines are not events. Turkish law gives three business days from the
 * moment the box was ticked, and nothing will happen at the end of them.
 *
 * It is deliberately not enqueued by the collection form either. A consent that
 * failed to upload has to be retried, so something must re-read rows that have
 * not changed — and once that exists, having the form enqueue as well would
 * only add a second path to keep correct.
 */
export type IysSweepJob = {
  kind: "iys_sweep";
};

export type DigestJob = {
  kind: "digest";
  organizationId: string;
  locationId: string;
  /** ISO date of the window start. Carried so a job cannot drift weeks. */
  periodStart?: string;
  force?: boolean;
};

export type DigestSweepJob = {
  kind: "digest_sweep";
};

/**
 * Mails the composed digest to everyone who asked for weekly delivery.
 *
 * Per organization rather than per location: one manager usually covers
 * several branches, and the recipient resolution is a single query for the
 * whole tenant. Idempotency lives in `digest_deliveries`, not here, so
 * re-running this job is safe by construction.
 */
export type DigestDeliverJob = {
  kind: "digest_deliver";
  organizationId: string;
  /** ISO date of the window start. Omitted, every ready digest is considered. */
  periodStart?: string;
};

export type ReviewJob =
  | ScanJob
  | SyncJob
  | AnalyzeJob
  | AnalyzeSweepJob
  | NotifyJob
  | NotifySweepJob
  | SlaSweepJob
  | IysSweepJob
  | DigestJob
  | DigestSweepJob
  | DigestDeliverJob;

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
  return jobId("sync", connectionId);
}

/** Queues an immediate sync for one connection. */
export async function enqueueSync(
  queue: Queue<ReviewJob>,
  input: { organizationId: string; connectionId: string; full?: boolean },
): Promise<void> {
  await queue.add(
    "sync",
    { kind: "sync", ...input },
    { jobId: jobId(syncJobId(input.connectionId), Date.now()) },
  );
}

/**
 * Queues analysis for one organization.
 *
 * The job id is stable per organization *per second*. Fully stable would be
 * better for deduplication, but BullMQ ignores an add whose id matches a job
 * that is currently **active**, so a review arriving mid-run would be dropped
 * and only picked up by the next sweep. A one-second bucket keeps a burst of
 * syncs from queuing dozens of jobs while still admitting work that arrives
 * after a run has started.
 */
export async function enqueueAnalyze(
  queue: Queue<ReviewJob>,
  input: { organizationId: string; recompute?: boolean },
  now = Date.now(),
): Promise<void> {
  await queue.add(
    "analyze",
    { kind: "analyze", ...input },
    {
      jobId: jobId("analyze", input.organizationId, Math.floor(now / 1000)),
      // A brief delay lets a multi-connection sync settle, so one analysis run
      // covers every source instead of one run per connection.
      delay: 2_000,
    },
  );
}

/**
 * Queues notification work for one organization.
 *
 * Same one-second job-id bucket as `enqueueAnalyze`, for the same reason — see
 * the note there. The delay is shorter: an alert is the thing a user is waiting
 * for, whereas analysis can afford to let a multi-connection sync settle.
 */
export async function enqueueNotify(
  queue: Queue<ReviewJob>,
  input: { organizationId: string },
  now = Date.now(),
): Promise<void> {
  await queue.add(
    "notify",
    { kind: "notify", ...input },
    { jobId: jobId("notify", input.organizationId, Math.floor(now / 1000)), delay: 1_000 },
  );
}

/**
 * Queues a digest for one location and window.
 *
 * The job id is the location and period rather than a time bucket, because a
 * digest genuinely is once per week per location — unlike analysis, where more
 * work can always arrive mid-run. `force` gets its own id so an owner pressing
 * "generate now" is never swallowed as a duplicate of the scheduled job.
 */
export async function enqueueDigest(
  queue: Queue<ReviewJob>,
  input: { organizationId: string; locationId: string; periodStart?: string; force?: boolean },
): Promise<void> {
  // The date alone, not the full ISO instant: windows are day-aligned, and the
  // time part only ever added noise (and, before `jobId()`, colons).
  const period = input.periodStart?.slice(0, 10) ?? "current";

  await queue.add(
    "digest",
    { kind: "digest", ...input },
    {
      jobId: input.force
        ? jobId("digest-force", input.locationId, Date.now())
        : jobId("digest", input.locationId, period),
    },
  );
}

/**
 * Queues the send for one organization and window.
 *
 * The job id is the organization and period, so the hourly sweep does not pile
 * up duplicates within an hour. It deliberately does *not* try to be the
 * idempotency guarantee — BullMQ forgets completed jobs after an hour, and the
 * next sweep should be free to retry a recipient whose send failed. What stops
 * a second email is the ledger.
 */
export async function enqueueDigestDelivery(
  queue: Queue<ReviewJob>,
  input: { organizationId: string; periodStart?: string },
): Promise<void> {
  const period = input.periodStart?.slice(0, 10) ?? "all";

  await queue.add(
    "digest_deliver",
    { kind: "digest_deliver", ...input },
    { jobId: jobId("digest-deliver", input.organizationId, period) },
  );
}

export const SCAN_SCHEDULER_ID = "scan-connections";
export const ANALYZE_SWEEP_SCHEDULER_ID = "analyze-sweep";
export const NOTIFY_SWEEP_SCHEDULER_ID = "notify-sweep";
export const SLA_SWEEP_SCHEDULER_ID = "sla-sweep";
export const IYS_SWEEP_SCHEDULER_ID = "iys-sweep";
export const DIGEST_SWEEP_SCHEDULER_ID = "digest-sweep";

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

/**
 * Installs the repeating analysis sweep. Idempotent, like `scheduleScan`.
 *
 * Runs far less often than the connection scan: the sweep is a safety net for
 * work the fast path missed, and its query touches every tenant's reviews. Once
 * every few minutes catches a lost job long before anyone notices, at a
 * fraction of the cost of running it every minute.
 */
export async function scheduleAnalyzeSweep(
  queue: Queue<ReviewJob>,
  everyMs = 300_000,
): Promise<void> {
  await queue.upsertJobScheduler(
    ANALYZE_SWEEP_SCHEDULER_ID,
    { every: everyMs },
    { name: "analyze_sweep", data: { kind: "analyze_sweep" } },
  );
}

/**
 * Installs the repeating notification sweep.
 *
 * Faster than the analysis sweep by default: a late insight is invisible, while
 * a late alert is the product failing at the thing PRD N1 promises.
 */
export async function scheduleNotifySweep(
  queue: Queue<ReviewJob>,
  everyMs = 120_000,
): Promise<void> {
  await queue.upsertJobScheduler(
    NOTIFY_SWEEP_SCHEDULER_ID,
    { every: everyMs },
    { name: "notify_sweep", data: { kind: "notify_sweep" } },
  );
}

/**
 * Installs the repeating SLA sweep.
 *
 * Every five minutes. A deadline is a promise measured in hours, so the
 * resolution that matters is "within a few minutes of lapsing", not "within
 * seconds" — and unlike the notification sweep, this one has to re-examine rows
 * that nothing has touched, so a tighter interval buys precision nobody can use
 * at a cost that scales with the whole open backlog.
 */
export async function scheduleSlaSweep(queue: Queue<ReviewJob>, everyMs = 300_000): Promise<void> {
  await queue.upsertJobScheduler(
    SLA_SWEEP_SCHEDULER_ID,
    { every: everyMs },
    { name: "sla_sweep", data: { kind: "sla_sweep" } },
  );
}

/**
 * Installs the repeating İYS upload sweep.
 *
 * Every fifteen minutes against a three-business-day deadline, which sounds
 * generous until you count what the margin is for: a gateway outage has to be
 * survivable without an operator, and retries only happen when the sweep comes
 * round. Ninety-six attempts a day means a registry can be down for most of a
 * day and still cost nobody a deadline.
 *
 * Tighter would buy nothing — a consent registered five minutes sooner changes
 * no outcome, since the customer is not waiting on this message today.
 */
export async function scheduleIysSweep(queue: Queue<ReviewJob>, everyMs = 900_000): Promise<void> {
  await queue.upsertJobScheduler(
    IYS_SWEEP_SCHEDULER_ID,
    { every: everyMs },
    { name: "iys_sweep", data: { kind: "iys_sweep" } },
  );
}

/**
 * Installs the repeating digest sweep.
 *
 * Hourly, not weekly. A weekly cron is a single point of failure with a
 * seven-day retry interval — miss it because the worker happened to be
 * restarting and that week's briefing never exists. An hourly check for a
 * *missing* digest is idempotent: the unique key on (location, period) means a
 * redundant check costs one query and produces nothing.
 */
export async function scheduleDigestSweep(
  queue: Queue<ReviewJob>,
  everyMs = 3_600_000,
): Promise<void> {
  await queue.upsertJobScheduler(
    DIGEST_SWEEP_SCHEDULER_ID,
    { every: everyMs },
    { name: "digest_sweep", data: { kind: "digest_sweep" } },
  );
}
