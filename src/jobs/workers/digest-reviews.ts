import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import { sendDigestEmails } from "../../digest/delivery.ts";
import { generateDigest } from "../../digest/pipeline.ts";
import { weekWindow } from "../../digest/metrics.ts";
import { getAdminDb, schema } from "../../db/client.ts";
import { childLogger } from "../../lib/logger.ts";
import { enqueueDigest, enqueueDigestDelivery, type ReviewJob } from "../queue.ts";

/**
 * The digest worker (P1a-T7).
 *
 * `digest_sweep` enumerates every location that does not yet have a digest for
 * the last completed week and enqueues one `digest` job each; `digest` runs the
 * pipeline for a single location.
 *
 * Per location, not per organization, because that is what the digest *is* — a
 * chain's Kadıköy branch and its airport kiosk have different customers,
 * different themes and different work to do, and one merged briefing would be
 * useless to both managers.
 *
 * The sweep runs hourly rather than weekly on purpose. A weekly cron is a
 * single point of failure with a seven-day retry interval: miss it because the
 * worker was restarting and the week is simply gone. Checking hourly for a
 * *missing* digest is idempotent — the unique key on (location, period) means
 * an extra check costs one query and produces nothing.
 */

const log = childLogger({ module: "jobs/digest-reviews" });

/** Locations dispatched per sweep. */
const SWEEP_LIMIT = 200;

export type DigestSweepResult = { locations: number; deliveries: number };

export async function runDigestSweep(
  queue: Queue<ReviewJob>,
  now = new Date(),
): Promise<DigestSweepResult> {
  const window = weekWindow(now);

  // Cross-tenant, like every other sweep: a scheduler has no session. Reads
  // location and organization ids only.
  const locations = await getAdminDb()
    .select({ id: schema.locations.id, organizationId: schema.locations.organizationId })
    .from(schema.locations)
    .limit(SWEEP_LIMIT);

  if (locations.length === 0) return { locations: 0, deliveries: 0 };

  const existing = await getAdminDb()
    .select({
      locationId: schema.digests.locationId,
      organizationId: schema.digests.organizationId,
    })
    .from(schema.digests)
    .where(
      and(
        eq(schema.digests.periodStart, window.start),
        inArray(
          schema.digests.locationId,
          locations.map((location) => location.id),
        ),
        // A failed digest is retried by the next sweep; a pending one is
        // either running now or died mid-flight, and re-enqueuing it is safe
        // because the pipeline claims the row again.
        eq(schema.digests.status, "ready"),
      ),
    );

  const done = new Set(existing.map((row) => row.locationId));
  const pending = locations.filter((location) => !done.has(location.id));

  for (const location of pending) {
    await enqueueDigest(queue, {
      organizationId: location.organizationId,
      locationId: location.id,
      periodStart: window.start.toISOString(),
    });
  }

  if (pending.length > 0) {
    log.info(
      { locations: pending.length, periodStart: window.start.toISOString() },
      "Digest sweep dispatched",
    );
  }

  // Delivery rides the same hourly sweep rather than a scheduler of its own.
  // A digest composed on this pass is mailed on the next one, an hour later,
  // which is the right trade: the alternative is enqueuing a send before the
  // pipeline that feeds it has finished. Re-enqueuing costs nothing, because
  // `digest_deliveries` — not the queue — is what stops a second email.
  const organizations = [...new Set(existing.map((row) => row.organizationId))];

  for (const organizationId of organizations) {
    await enqueueDigestDelivery(queue, {
      organizationId,
      periodStart: window.start.toISOString(),
    });
  }

  return { locations: pending.length, deliveries: organizations.length };
}

export type DigestJobResult = {
  locationId: string;
  digestId: string;
  status: string;
  pulse: number | null;
  actions: number;
};

export async function runDigest(job: Job<ReviewJob>): Promise<DigestJobResult> {
  if (job.data.kind !== "digest") {
    throw new UnrecoverableError("runDigest received a non-digest job.");
  }

  const { organizationId, locationId, periodStart, force } = job.data;

  // The window travels on the job rather than being recomputed here. A job
  // enqueued at 23:59 on Sunday and run at 00:01 on Monday would otherwise
  // generate a different week than the one the sweep decided was missing.
  const window = periodStart ? windowFrom(new Date(periodStart)) : undefined;

  const result = await generateDigest({
    organizationId,
    locationId,
    ...(window ? { window } : {}),
    ...(force ? { force: true } : {}),
  });

  return {
    locationId,
    digestId: result.digestId,
    status: result.reason ?? result.status,
    pulse: result.pulse,
    actions: result.actions,
  };
}

export type DigestDeliverJobResult = {
  organizationId: string;
  sent: number;
  failed: number;
  skipped: number;
  held: number;
};

/**
 * Mails the composed digest for one organization.
 *
 * Thin on purpose: everything interesting — who wants it, who already had it,
 * which held alerts it closes out — lives in `digest/delivery.ts`, where it can
 * be tested without a queue.
 */
export async function runDigestDeliver(job: Job<ReviewJob>): Promise<DigestDeliverJobResult> {
  if (job.data.kind !== "digest_deliver") {
    throw new UnrecoverableError("runDigestDeliver received a non-delivery job.");
  }

  const { organizationId, periodStart } = job.data;

  const result = await sendDigestEmails({
    organizationId,
    ...(periodStart ? { periodStart: new Date(periodStart) } : {}),
  });

  return { organizationId, ...result };
}

function windowFrom(start: Date): { start: Date; end: Date } {
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}
