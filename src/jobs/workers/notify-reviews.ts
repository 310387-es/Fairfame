import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getAdminDb, schema } from "../../db/client.ts";
import { childLogger } from "../../lib/logger.ts";
import { sendPendingEmails } from "../../notifications/email.ts";
import {
  notifyPendingReviews,
  notifySlaBreaches,
  upgradeUrgencyFromInsights,
} from "../../notifications/service.ts";
import { enqueueNotify, type ReviewJob } from "../queue.ts";

/**
 * The notification worker (P1a-T5).
 *
 * `notify_sweep` finds organizations with reviews nobody has been told about
 * and enqueues one `notify` job each. `notify` does three things for a single
 * organization, in this order:
 *
 *   1. create feed rows for un-notified reviews,
 *   2. raise urgency where analysis has since found negative sentiment,
 *   3. drain the pending emails.
 *
 * The order is the point. Urgency is upgraded *before* the mail goes out, so a
 * review that analysis flagged negative between ingestion and this job leaves
 * with the urgent subject line rather than a correction nobody will see.
 *
 * A separate scheduler from the analysis sweep, rather than one combined
 * "review sweep", because the two answer different questions and fail
 * independently: an organization over its analysis allowance still needs its
 * notifications, and an SMTP outage must not stop insights being written.
 */

const log = childLogger({ module: "jobs/notify-reviews" });

/** Organizations dispatched per sweep. */
const SWEEP_LIMIT = 100;

export type NotifySweepResult = { organizations: number };

/**
 * Finds organizations with un-notified reviews and enqueues a job for each.
 *
 * Cross-tenant, like the connection scan and the analysis sweep, and for the
 * same reason: a scheduler has no session. It reads organization ids only.
 *
 * The `notifications` left join mirrors `pendingReviews` in
 * ../../notifications/service.ts — including the seven-day window, without
 * which every organization would appear here forever once a member turned
 * notifications off.
 */
export async function runNotifySweep(queue: Queue<ReviewJob>): Promise<NotifySweepResult> {
  const rows = await getAdminDb()
    .select({ organizationId: schema.reviews.organizationId })
    .from(schema.reviews)
    .leftJoin(schema.notifications, eq(schema.notifications.reviewId, schema.reviews.id))
    .where(
      and(
        isNull(schema.notifications.id),
        sql`${schema.reviews.createdAt} > now() - interval '7 days'`,
      ),
    )
    .groupBy(schema.reviews.organizationId)
    .limit(SWEEP_LIMIT);

  for (const row of rows) {
    await enqueueNotify(queue, { organizationId: row.organizationId });
  }

  if (rows.length > 0) {
    log.info({ organizations: rows.length }, "Notification sweep dispatched");
  }

  return { organizations: rows.length };
}

export type SlaSweepResult = { organizations: number };

/**
 * Alerts every organization holding a lapsed, unanswered deadline (P2-T7).
 *
 * The one legitimate cross-tenant read, on the same footing as the connector
 * scan: a scheduler has no session and therefore no organization. It reads only
 * the organization ids of rows that qualify — never the reviews themselves —
 * and the per-tenant work happens inside `withTenant` in the service.
 *
 * Unlike the arrival sweep this cannot be replaced by an event: nothing happens
 * when a deadline passes, which is exactly why something has to keep looking.
 */
export async function runSlaSweep(now = new Date()): Promise<SlaSweepResult> {
  const rows = await getAdminDb()
    .select({ organizationId: schema.reviews.organizationId })
    .from(schema.reviews)
    .where(
      and(
        // The same claim condition the service uses, minus the locking: this is
        // only deciding which tenants are worth opening a transaction for.
        isNull(schema.reviews.slaAlertedAt),
        isNull(schema.reviews.firstResponseAt),
        sql`${schema.reviews.slaDueAt} is not null and ${schema.reviews.slaDueAt} < ${now}`,
        sql`${schema.reviews.status} in ('open', 'in_progress')`,
      ),
    )
    .groupBy(schema.reviews.organizationId)
    .limit(SWEEP_LIMIT);

  let created = 0;
  for (const row of rows) {
    const outcome = await notifySlaBreaches({ organizationId: row.organizationId, now });
    created += outcome.created;
  }

  if (created > 0) {
    log.info({ organizations: rows.length, created }, "SLA sweep created breach alerts");
  }

  return { organizations: rows.length };
}

export type NotifyJobResult = {
  organizationId: string;
  created: number;
  upgraded: number;
  emailsSent: number;
  emailsFailed: number;
};

export async function runNotify(job: Job<ReviewJob>): Promise<NotifyJobResult> {
  if (job.data.kind !== "notify") {
    throw new UnrecoverableError("runNotify received a non-notify job.");
  }

  const { organizationId } = job.data;

  const created = await notifyPendingReviews({ organizationId });
  const upgraded = await upgradeUrgencyFromInsights({ organizationId });
  const emails = await sendPendingEmails({ organizationId });

  const result: NotifyJobResult = {
    organizationId,
    created: created.created,
    upgraded,
    emailsSent: emails.sent,
    emailsFailed: emails.failed,
  };

  if (result.created + result.upgraded + result.emailsSent + result.emailsFailed > 0) {
    log.info(result, "Notification job completed");
  }

  return result;
}
