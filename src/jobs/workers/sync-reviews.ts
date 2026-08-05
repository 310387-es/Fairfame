import { UnrecoverableError, Worker, type ConnectionOptions, type Job, type Queue } from "bullmq";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { getConnector } from "../../connectors/registry.ts";
import { ConnectorError } from "../../connectors/types.ts";
import { syncConnection } from "../../connectors/sync.ts";
import { getAdminDb, schema } from "../../db/client.ts";
import { childLogger } from "../../lib/logger.ts";
import {
  enqueueAnalyze,
  enqueueNotify,
  enqueueSync,
  REVIEW_QUEUE,
  type ReviewJob,
} from "../queue.ts";
import { runAnalyze, runAnalyzeSweep } from "./analyze-reviews.ts";
import { runDigest, runDigestDeliver, runDigestSweep } from "./digest-reviews.ts";
import { runIysSweep } from "./iys-upload.ts";
import { runReportSweep } from "./scheduled-reports.ts";
import { runNotify, runNotifySweep, runSlaSweep } from "./notify-reviews.ts";

/**
 * The review worker.
 *
 * `scan` enumerates every syncable connection across all organizations and
 * enqueues one `sync` job each. `sync` runs the connector pipeline for a single
 * connection inside its own tenant context, then hands off to analysis if it
 * changed anything. The analysis handlers live in ./analyze-reviews.ts and the
 * notification handlers in ./notify-reviews.ts and the digest handlers in
 * ./digest-reviews.ts; this module owns the worker that dispatches all eight.
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

export async function runScan(queue: Queue<ReviewJob>, now = new Date()): Promise<ScanResult> {
  const rows = await getAdminDb()
    .select({
      id: schema.connections.id,
      organizationId: schema.connections.organizationId,
      provider: schema.connections.provider,
    })
    .from(schema.connections)
    .where(
      and(
        inArray(schema.connections.status, [...SYNCABLE_STATUSES]),
        // Honour backoff and rate-limit deferral. A null next_sync_at means no
        // pacing decision has been made yet, so the connection is due.
        or(isNull(schema.connections.nextSyncAt), lte(schema.connections.nextSyncAt, now)),
      ),
    );

  let dispatched = 0;
  let skipped = 0;

  for (const row of rows) {
    // A source that cannot be read has nothing to sync — WhatsApp is outbound
    // messaging, not a review feed. Enqueuing it would fail every scan tick.
    if (!isReadable(row.provider)) {
      skipped += 1;
      continue;
    }

    await enqueueSync(queue, { organizationId: row.organizationId, connectionId: row.id });
    dispatched += 1;
  }

  log.info({ connections: dispatched, skipped }, "Scheduled sync scan dispatched");
  return { connections: dispatched };
}

/** Can this provider be polled at all? Unknown providers are left alone. */
function isReadable(provider: string): boolean {
  try {
    return getConnector(provider).capabilities.read !== "none";
  } catch {
    return false;
  }
}

async function runSync(job: Job<ReviewJob>, queue: Queue<ReviewJob>): Promise<unknown> {
  if (job.data.kind !== "sync") throw new UnrecoverableError("runSync received a non-sync job.");
  const { organizationId, connectionId, full } = job.data;

  try {
    const outcome = await syncConnection(organizationId, connectionId, {
      full: full ?? false,
      // A retry belongs to a dispatch the scan already admitted, so the
      // backoff written by the previous attempt must not turn attempt two into
      // a silent no-op — that would make the queue's own retry policy
      // meaningless and hide a failing source behind a "success".
      ignoreSchedule: job.attemptsMade > 0,
    });

    // The fast path from ingestion to insights: a sync that moved rows queues
    // analysis for the tenant. `updated` counts too — a review whose text was
    // edited needs re-analyzing, and the content hash decides whether it
    // actually does, so enqueuing costs nothing when nothing changed.
    if (outcome.inserted + outcome.updated > 0) {
      await enqueueAnalyze(queue, { organizationId });
      // Notification does not wait for analysis. A rating is enough to know a
      // review is negative, and putting an LLM on the critical path of an
      // alert means a capped plan or a provider outage silently mutes it. The
      // analysis job re-enqueues notify afterwards to correct urgency.
      await enqueueNotify(queue, { organizationId });
    }

    return outcome;
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

export type ReviewWorkerOptions = {
  connection: ConnectionOptions;
  queue: Queue<ReviewJob>;
  queueName?: string;
  concurrency?: number;
};

export function createReviewWorker(options: ReviewWorkerOptions): Worker<ReviewJob> {
  const { connection, queue, queueName = REVIEW_QUEUE, concurrency = 4 } = options;

  const worker = new Worker<ReviewJob>(
    queueName,
    async (job) => {
      switch (job.data.kind) {
        case "scan":
          return runScan(queue);
        case "sync":
          return runSync(job, queue);
        case "analyze_sweep":
          return runAnalyzeSweep(queue);
        case "analyze":
          return runAnalyze(job, queue);
        case "notify_sweep":
          return runNotifySweep(queue);
        case "notify":
          return runNotify(job);
        case "sla_sweep":
          return runSlaSweep();
        case "iys_sweep":
          return runIysSweep();
        case "report_sweep":
          return runReportSweep();
        case "digest_sweep":
          return runDigestSweep(queue);
        case "digest":
          return runDigest(job);
        case "digest_deliver":
          return runDigestDeliver(job);
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
