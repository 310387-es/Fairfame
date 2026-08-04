import { and, isNull, eq, sql } from "drizzle-orm";
import { getAdminDb, schema } from "../../db/client.ts";
import { runIysUploads } from "../../compliance/iys-upload.ts";
import { getIysGateway, iysRequired } from "../../compliance/gate.ts";
import { getEnv } from "../../lib/env.ts";
import { childLogger } from "../../lib/logger.ts";

/**
 * The İYS upload sweep (P1b-T5).
 *
 * Finds every organization holding a marketing permission the registry has not
 * been told about, and reports each one's backlog. This is the last step
 * between a ticked consent box and a message the send gate will actually let
 * through — without it `checkSendAllowed` correctly refuses forever, because a
 * permission we hold and İYS does not is not a permission to send.
 */

const log = childLogger({ module: "jobs/iys-upload" });

/** Organizations examined per pass. Same ceiling as the other sweeps. */
const SWEEP_LIMIT = 100;

export type IysSweepResult = {
  organizations: number;
  uploaded: number;
  failed: number;
  overdue: number;
};

export async function runIysSweep(now = new Date()): Promise<IysSweepResult> {
  const empty: IysSweepResult = { organizations: 0, uploaded: 0, failed: 0, overdue: 0 };

  // Checked here as well as in the service so a deployment with no registry to
  // report to does not run a cross-tenant scan every fifteen minutes to
  // discover that again.
  if (!iysRequired(getEnv())) return empty;
  if (!getIysGateway()) return empty;

  // The same legitimate cross-tenant read the other sweeps make: a scheduler
  // has no session and therefore no organization. It selects organization ids
  // only — never a contact reference — and all per-tenant work happens inside
  // `withTenant` in the service.
  const rows = await getAdminDb()
    .select({ organizationId: schema.consentRecords.organizationId })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.type, "iys"),
        isNull(schema.consentRecords.iysUploadedAt),
        isNull(schema.consentRecords.revokedAt),
      ),
    )
    .groupBy(schema.consentRecords.organizationId)
    .orderBy(sql`min(${schema.consentRecords.iysUploadDueAt}) asc nulls last`)
    .limit(SWEEP_LIMIT);

  let uploaded = 0;
  let failed = 0;
  let overdue = 0;

  for (const row of rows) {
    // One organization's gateway trouble must not stop the rest: each tenant's
    // deadline is its own, and a shared loop that aborted would let one failure
    // put every other business out of compliance.
    try {
      const result = await runIysUploads({ organizationId: row.organizationId, now });
      uploaded += result.uploaded;
      failed += result.failed;
      overdue += result.overdue;
    } catch (error) {
      log.error(
        { organizationId: row.organizationId, err: error },
        "İYS upload pass threw; continuing with the remaining organizations",
      );
    }
  }

  if (uploaded > 0 || failed > 0) {
    log.info(
      { organizations: rows.length, uploaded, failed, overdue },
      "İYS upload sweep complete",
    );
  }

  return { organizations: rows.length, uploaded, failed, overdue };
}
