/**
 * Background worker process.
 *
 *   pnpm worker
 *
 * Runs the review sync worker and installs the repeating scan. Deliberately a
 * separate process from the web app: a slow or crashing sync must never take
 * request handling down with it.
 */
import { closeDatabasePools } from "../src/db/client.ts";
import { getEnv } from "../src/lib/env.ts";
import { childLogger } from "../src/lib/logger.ts";
import { createQueue, createRedisConnection, scheduleScan } from "../src/jobs/queue.ts";
import { createSyncWorker } from "../src/jobs/workers/sync-reviews.ts";

const log = childLogger({ module: "worker" });

const SCAN_INTERVAL_MS = getEnv().SYNC_SCAN_INTERVAL_MS;

const queueConnection = createRedisConnection();
const workerConnection = createRedisConnection();

const queue = createQueue(queueConnection);
const worker = createSyncWorker({ connection: workerConnection, queue });

await scheduleScan(queue, SCAN_INTERVAL_MS);

log.info({ scanIntervalMs: SCAN_INTERVAL_MS }, "Worker started");

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
