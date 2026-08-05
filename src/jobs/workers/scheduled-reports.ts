import { eq, sql } from "drizzle-orm";
import { getAdminDb, schema } from "../../db/client.ts";
import { childLogger } from "../../lib/logger.ts";
import { can } from "../../lib/entitlements.ts";
import { withTenant } from "../../lib/tenancy.ts";
import { runScheduledReports } from "../../reports/pipeline.ts";

/**
 * The scheduled-report sweep (P3-T5).
 *
 * Finds the organizations that have somebody waiting for a report and runs the
 * pipeline for each. Nothing about *when* lives here — the pipeline decides
 * which period has closed and the ledger decides whether it has already been
 * sent, so this worker is only a fan-out.
 *
 * Hourly, and safe to run more often. See `scheduleReportSweep` for why a cron
 * pinned to Monday morning would be a single point of failure with a seven-day
 * retry interval.
 */

const log = childLogger({ module: "jobs/scheduled-reports" });

/** Organizations per sweep. Far more than a single deployment will have soon. */
const SWEEP_LIMIT = 200;

export type ReportSweepResult = {
  organizations: number;
  sent: number;
  failed: number;
  skipped: number;
  /** Organizations skipped because their plan does not include reports. */
  notEntitled: number;
};

export async function runReportSweep(now = new Date()): Promise<ReportSweepResult> {
  const result: ReportSweepResult = {
    organizations: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    notEntitled: 0,
  };

  // The same legitimate cross-tenant read every other sweep makes: a scheduler
  // has no session and therefore no organization. It selects organization ids
  // only — no recipient, no location, no numbers — and every per-tenant read
  // afterwards happens inside `withTenant` in the pipeline.
  const rows = await getAdminDb()
    .select({ organizationId: schema.reportSchedules.organizationId })
    .from(schema.reportSchedules)
    .where(eq(schema.reportSchedules.enabled, true))
    .groupBy(schema.reportSchedules.organizationId)
    .orderBy(sql`min(${schema.reportSchedules.createdAt})`)
    .limit(SWEEP_LIMIT);

  for (const { organizationId } of rows) {
    // Checked at send time, not only when the schedule was created. A plan can
    // lapse, and a report that kept arriving after a downgrade would be the
    // product quietly ignoring its own entitlement — the schedule stays,
    // because it should resume if they upgrade again.
    const entitled = await withTenant({ organizationId }, (tx) =>
      can({ organizationId, tx }, "scheduled_reports"),
    );

    if (!entitled) {
      result.notEntitled += 1;
      continue;
    }

    try {
      const outcome = await runScheduledReports(organizationId, { now });
      result.organizations += 1;
      result.sent += outcome.sent;
      result.failed += outcome.failed;
      result.skipped += outcome.skipped;
    } catch (error) {
      // One tenant's failure must not abandon the rest of the sweep.
      log.error({ err: error, organizationId }, "Scheduled reports failed for organization");
      result.failed += 1;
    }
  }

  if (result.sent > 0 || result.failed > 0) {
    log.info(result, "Scheduled report sweep finished");
  }

  return result;
}
