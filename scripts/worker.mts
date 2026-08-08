/**
 * Background worker process.
 *
 *   pnpm worker
 *
 * Runs the review worker and installs the repeating schedules — the connection
 * scan and the analysis, notification, SLA, digest and scheduled-report sweeps. Deliberately
 * a separate process from the web app: a slow or crashing sync must never take
 * request handling down with it.
 */
import { installIysGateway } from "../src/compliance/iys-gateway.ts";
import { closeDatabasePools } from "../src/db/client.ts";
import { getEnv } from "../src/lib/env.ts";
import { childLogger } from "../src/lib/logger.ts";
import {
  createQueue,
  createRedisConnection,
  scheduleAnalyzeSweep,
  scheduleDigestSweep,
  scheduleNotifySweep,
  scheduleScan,
  scheduleIysSweep,
  scheduleAutoReplySweep,
  scheduleBroadcastSweep,
  scheduleReportSweep,
  scheduleSlaSweep,
} from "../src/jobs/queue.ts";
import { createReviewWorker } from "../src/jobs/workers/sync-reviews.ts";

const log = childLogger({ module: "worker" });

const SCAN_INTERVAL_MS = getEnv().SYNC_SCAN_INTERVAL_MS;
const ANALYZE_SWEEP_INTERVAL_MS = getEnv().ANALYZE_SWEEP_INTERVAL_MS;
const NOTIFY_SWEEP_INTERVAL_MS = getEnv().NOTIFY_SWEEP_INTERVAL_MS;
const SLA_SWEEP_INTERVAL_MS = getEnv().SLA_SWEEP_INTERVAL_MS;
const IYS_SWEEP_INTERVAL_MS = getEnv().IYS_SWEEP_INTERVAL_MS;
const DIGEST_SWEEP_INTERVAL_MS = getEnv().DIGEST_SWEEP_INTERVAL_MS;
const REPORT_SWEEP_INTERVAL_MS = getEnv().REPORT_SWEEP_INTERVAL_MS;
const BROADCAST_SWEEP_INTERVAL_MS = getEnv().BROADCAST_SWEEP_INTERVAL_MS;

const queueConnection = createRedisConnection();
const workerConnection = createRedisConnection();

// Installed before the worker starts consuming: a job that sends must never
// run against an unconfigured gate.
const iysGateway = installIysGateway();

const queue = createQueue(queueConnection);
const worker = createReviewWorker({ connection: workerConnection, queue });

await scheduleScan(queue, SCAN_INTERVAL_MS);
await scheduleAnalyzeSweep(queue, ANALYZE_SWEEP_INTERVAL_MS);
await scheduleNotifySweep(queue, NOTIFY_SWEEP_INTERVAL_MS);
await scheduleSlaSweep(queue, SLA_SWEEP_INTERVAL_MS);
await scheduleIysSweep(queue, IYS_SWEEP_INTERVAL_MS);
await scheduleReportSweep(queue, REPORT_SWEEP_INTERVAL_MS);
await scheduleBroadcastSweep(queue, BROADCAST_SWEEP_INTERVAL_MS);
await scheduleDigestSweep(queue, DIGEST_SWEEP_INTERVAL_MS);
await scheduleAutoReplySweep(queue);

log.info(
  {
    scanIntervalMs: SCAN_INTERVAL_MS,
    analyzeSweepIntervalMs: ANALYZE_SWEEP_INTERVAL_MS,
    notifySweepIntervalMs: NOTIFY_SWEEP_INTERVAL_MS,
    broadcastSweepIntervalMs: BROADCAST_SWEEP_INTERVAL_MS,
    slaSweepIntervalMs: SLA_SWEEP_INTERVAL_MS,
    iysSweepIntervalMs: IYS_SWEEP_INTERVAL_MS,
    digestSweepIntervalMs: DIGEST_SWEEP_INTERVAL_MS,
    iysGateway: iysGateway ?? "none (commercial sends refused)",
  },
  "Worker started",
);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info({ signal }, "Shutting down worker");

  // Close the worker first so in-flight jobs finish before the connections
  // they depend on are torn out from under them.
  await worker.close();
  await queue.close();
  await Promise.all([queueConnection.quit(), workerConnection.quit()]);
  await closeDatabasePools();

  log.info("Worker stopped");
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
