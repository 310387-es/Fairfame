import type { Queue } from "bullmq";
import type Redis from "ioredis";
import { childLogger } from "../lib/logger.ts";
import {
  createQueue,
  createRedisConnection,
  enqueueAnalyze,
  enqueueDigest,
  enqueueNotify,
  enqueueSync,
  type ReviewJob,
} from "./queue.ts";

/**
 * Enqueuing jobs from the web process (P1a-T4).
 *
 * The worker owns a queue for its whole lifetime; a request handler cannot —
 * opening a Redis connection per action would exhaust the server under any real
 * load. So the queue is a lazily created process singleton, built on first use
 * and reused thereafter.
 *
 * **Enqueuing never fails the caller.** A user who connects a source and gets
 * "could not reach Redis" learns nothing useful, and the connection itself
 * succeeded. Every enqueue here has a slower backstop — the analysis sweep in
 * ./workers/analyze-reviews.ts — so a dropped job costs minutes of latency
 * rather than data. The failure is logged loudly; it is not the user's problem.
 */

const log = childLogger({ module: "jobs/client" });

let queue: Queue<ReviewJob> | undefined;
let connection: Redis | undefined;

function getQueue(): Queue<ReviewJob> {
  if (!queue) {
    connection = createRedisConnection();
    queue = createQueue(connection);
  }
  return queue;
}

/**
 * Asks for an organization's reviews to be analyzed, if a queue is reachable.
 *
 * Returns whether the job was queued, so a caller that wants to report "we are
 * working on it" can tell the difference. Most callers can ignore it.
 */
export async function requestAnalysis(organizationId: string): Promise<boolean> {
  try {
    await enqueueAnalyze(getQueue(), { organizationId });
    return true;
  } catch (error) {
    log.error(
      { organizationId, err: error },
      "Could not queue analysis; the sweep will pick it up",
    );
    return false;
  }
}

/**
 * Asks for an organization's new reviews to be turned into notifications.
 *
 * Same contract as `requestAnalysis`: never throws, and the notification sweep
 * is the backstop if the queue is unreachable.
 */
export async function requestNotifications(organizationId: string): Promise<boolean> {
  try {
    await enqueueNotify(getQueue(), { organizationId });
    return true;
  } catch (error) {
    log.error(
      { organizationId, err: error },
      "Could not queue notifications; the sweep will pick it up",
    );
    return false;
  }
}

/**
 * Asks for a location's digest to be composed.
 *
 * Unlike analysis and notifications, this one's return value matters to the
 * caller: an owner pressing "generate now" is waiting for a specific thing, and
 * "we could not queue it" is more useful than a spinner that never resolves.
 * There is no sweep fast enough to cover it within the minute they are looking.
 */
export async function requestDigest(input: {
  organizationId: string;
  locationId: string;
  force?: boolean;
}): Promise<boolean> {
  try {
    await enqueueDigest(getQueue(), input);
    return true;
  } catch (error) {
    log.error({ ...input, err: error }, "Could not queue the digest");
    return false;
  }
}

/**
 * Asks for one connection to be synced now.
 *
 * Used by the Instagram webhook (P1b-T4): a real-time signal that waited for
 * the next polling tick would not be real time. Same never-throws contract as
 * the others — the scheduled scan is the backstop.
 */
export async function requestSync(input: {
  organizationId: string;
  connectionId: string;
  full?: boolean;
}): Promise<boolean> {
  try {
    await enqueueSync(getQueue(), input);
    return true;
  } catch (error) {
    log.error({ ...input, err: error }, "Could not queue a sync; the scan will pick it up");
    return false;
  }
}

/** Releases the shared queue. For scripts and tests, not for request handlers. */
export async function closeJobQueue(): Promise<void> {
  await queue?.close();
  await connection?.quit();
  queue = undefined;
  connection = undefined;
}
