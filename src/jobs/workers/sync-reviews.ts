import { UnrecoverableError, Worker, type ConnectionOptions, type Job, type Queue } from "bullmq";
import { eq, inArray } from "drizzle-orm";
import { ConnectorError } from "../../connectors/types.ts";
import { syncConnection } from "../../connectors/sync.ts";
import { getAdminDb, schema } from "../../db/client.ts";
import { childLogger } from "../../lib/logger.ts";
import { enqueueSync, REVIEW_QUEUE, type ReviewJob } from "../queue.ts";

/**
 * The review sync worker.
 *
 * `scan` enumerates every syncable connection across all organizations and
 * enqueues one `sync` job each. `sync` runs the connector pipeline for a single
 * connection inside its own tenant context.
 *
 * The scan is the one legitimate cross-tenant read in the system: a scheduler
 * has no session and therefore no organization. It deliberately reads only
 * (id, organization_id, status) — enough to dispatch, and nothing that could
 * leak one tenant's data into another's job.
 */

const log = childLogger({ module: "jobs/sync-reviews" });

/** Statuses worth attempting. `error` is included so a source can recover. */
const SYNCABLE_STATUSES = ["active", "error"] as const;

export type ScanResult = { connections: number };

export async function runScan(queue: Queue<ReviewJob>): Promise<ScanResult> {
  const rows = await getAdminDb()
    .select({
      id: schema.connections.id,
      organizationId: schema.connections.organizationId,
    })
    .from(schema.connections)
    .where(inArray(schema.connections.status, [...SYNCABLE_STATUSES]));

  for (const row of rows) {
    await enqueueSync(queue, { organizationId: row.organizationId, connectionId: row.id });
  }

  log.info({ connections: rows.length }, "Scheduled sync scan dispatched");
  return { connections: rows.length };
}

async function runSync(job: Job<ReviewJob>): Promise<unknown> {
  if (job.data.kind !== "sync") throw new UnrecoverableError("runSync received a non-sync job.");
  const { organizationId, connectionId, full } = job.data;

  try {
    return await syncConnection(organizationId, connectionId, { full: full ?? false });
  } catch (error) {
    // A connector that says "do not retry" means the failure is structural —
    // bad config, unknown provider, a payload that will never parse. Retrying
    // it four more times just delays the signal and burns the backoff budget.
    if (error instanceof ConnectorError && !error.retryable) {
      log.error(
        { organizationId, connectionId, err: error },
        "Connector reported a permanent failure; not retrying",
      );
      throw new UnrecoverableError(error.message);
    }

    log.warn(
      { organizationId, connectionId, attempt: job.attemptsMade + 1, err: error },
      "Sync attempt failed; will retry",
    );
    throw error;
  }
}

export type SyncWorkerOptions = {
  connection: ConnectionOptions;
  queue: Queue<ReviewJob>;
  queueName?: string;
  concurrency?: number;
};

export function createSyncWorker(options: SyncWorkerOptions): Worker<ReviewJob> {
  const { connection, queue, queueName = REVIEW_QUEUE, concurrency = 4 } = options;

  const worker = new Worker<ReviewJob>(
    queueName,
    async (job) => {
      switch (job.data.kind) {
        case "scan":
          return runScan(queue);
        case "sync":
          return runSync(job);
        default:
          // An unknown job kind will never become known by retrying.
          throw new UnrecoverableError(
            `Unknown job kind: ${JSON.stringify((job.data as { kind?: unknown }).kind)}`,
          );
      }
    },
    { connection, concurrency },
  );

  worker.on("failed", (job, error) => {
    log.error(
      {
        jobId: job?.id,
        kind: job?.data.kind,
        attemptsMade: job?.attemptsMade,
        err: error,
      },
      "Job failed",
    );
  });

  return worker;
}

/** Marks a connection disconnected so the scan stops picking it up. */
export async function disableConnection(connectionId: string): Promise<void> {
  await getAdminDb()
    .update(schema.connections)
    .set({ status: "disconnected", updatedAt: new Date() })
    .where(eq(schema.connections.id, connectionId));
}
