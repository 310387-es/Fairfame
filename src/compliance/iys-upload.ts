import * as schema from "../db/schema.ts";
import { withTenant } from "../lib/tenancy.ts";
import { childLogger } from "../lib/logger.ts";
import { getEnv } from "../lib/env.ts";
import { markUploaded, markUploadFailed, pendingIysUploads } from "./consent.ts";
import { getIysGateway, iysRequired, type IysUploadOutcome } from "./gate.ts";

/**
 * Drains the İYS upload queue (P1b-T5, completing the compliance layer).
 *
 * Collecting a marketing permission is only half of what Turkish law asks. The
 * other half is reporting it to İYS within **three business days**, and until
 * that happens the permission is one we hold and the registry does not — which
 * is precisely the state `checkSendAllowed` refuses to send on. So a consent
 * that is never uploaded is not a filing oversight; it is a customer who ticked
 * the box and will never hear from the business.
 *
 * Nothing here decides *whether* a permission is valid. That was settled when
 * the row was written. This only reports it, and records what the registry said.
 */

const log = childLogger({ module: "compliance/iys-upload" });

/**
 * How many consents one pass reports per organization.
 *
 * Matches `pendingIysUploads`' own default. The deadline is three business days
 * and the sweep runs many times an hour, so a backlog larger than this drains
 * across passes long before anything is late — while a single tenant with a
 * large import cannot monopolise a pass.
 */
export const IYS_UPLOAD_BATCH = 200;

export type IysUploadResult = {
  organizationId: string;
  /** Consents handed to the gateway. */
  attempted: number;
  uploaded: number;
  failed: number;
  /** Still queued and already past their three business days. */
  overdue: number;
  /** Why nothing was attempted, when nothing was. */
  skipped: "no_gateway" | "not_required" | "nothing_pending" | null;
};

function emptyResult(
  organizationId: string,
  skipped: NonNullable<IysUploadResult["skipped"]>,
): IysUploadResult {
  return { organizationId, attempted: 0, uploaded: 0, failed: 0, overdue: 0, skipped };
}

/**
 * Reports one organization's outstanding consents to İYS.
 *
 * Tenant-scoped throughout: the sweep picks the organization, and every read
 * and write happens inside that organization's `withTenant` transaction under
 * RLS. The gateway is handed a contact reference and a channel — never a row
 * belonging to anyone else.
 */
export async function runIysUploads(
  input: { organizationId: string; now?: Date },
  env: { IYS_REQUIRED: boolean } = getEnv(),
): Promise<IysUploadResult> {
  const { organizationId } = input;
  const now = input.now ?? new Date();

  // A deployment outside Türkiye has no registry to report to. The same flag
  // that exempts it from the send-time check exempts it here — and it is passed
  // in, exactly as `checkSendAllowed` takes it, so the two cannot be reading
  // different answers to "does İYS apply".
  if (!iysRequired(env)) return emptyResult(organizationId, "not_required");

  const gateway = getIysGateway();
  if (!gateway) {
    // Not an error, and deliberately not a failure written to the rows: there
    // is nothing wrong with these consents. The deployment simply cannot report
    // them yet, and `installIysGateway` has already said so at boot.
    return emptyResult(organizationId, "no_gateway");
  }

  const pending = await withTenant({ organizationId }, (tx) =>
    pendingIysUploads(tx, organizationId, now, IYS_UPLOAD_BATCH),
  );

  if (pending.length === 0) return emptyResult(organizationId, "nothing_pending");

  let outcomes: IysUploadOutcome[];
  try {
    outcomes = await gateway.upload({
      organizationId,
      records: pending.map((record) => ({
        id: record.id,
        contactRef: record.contactRef,
        channel: record.channel,
        grantedAt: record.grantedAt,
      })),
    });
  } catch (error) {
    // The gateway threw rather than answering. Every row stays queued: an
    // unreachable registry is a reason to try again, never a reason to stop
    // asking.
    const detail = error instanceof Error ? error.message : String(error);
    log.warn({ organizationId, pending: pending.length, detail }, "İYS upload attempt failed");

    await withTenant({ organizationId }, async (tx) => {
      for (const record of pending) {
        await markUploadFailed(tx, organizationId, record.id, `gateway error: ${detail}`, now);
      }
    });

    return {
      organizationId,
      attempted: pending.length,
      uploaded: 0,
      failed: pending.length,
      overdue: pending.filter((record) => record.overdue).length,
      skipped: null,
    };
  }

  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  const accepted: string[] = [];
  const rejected: { id: string; reason: string }[] = [];

  for (const record of pending) {
    const outcome = byId.get(record.id);

    if (!outcome) {
      // A gateway that skipped a row told us nothing about it. Treating silence
      // as acceptance would mark an unregistered permission registered, so it
      // stays queued.
      rejected.push({ id: record.id, reason: "gateway returned no outcome for this record" });
      continue;
    }

    if (outcome.status === "accepted") {
      accepted.push(record.id);
    } else {
      rejected.push({
        id: record.id,
        reason: `${outcome.retryable ? "retryable" : "permanent"}: ${outcome.detail}`,
      });
    }
  }

  await withTenant({ organizationId }, async (tx) => {
    await markUploaded(tx, organizationId, accepted, gateway.name, now);

    for (const failure of rejected) {
      await markUploadFailed(tx, organizationId, failure.id, failure.reason, now);
    }

    if (accepted.length > 0) {
      // Audit-logged because this is the moment a permission becomes usable:
      // before it, every commercial send to that contact is refused. Actor is
      // null — the worker acts for the organization, not for a person.
      await tx.insert(schema.auditLogs).values({
        organizationId,
        actorUserId: null,
        action: "consent.iys_uploaded",
        // A batch has no single entity, so the ids go in the meta rather than
        // being flattened into a count that could not be traced back.
        entity: "consent:iys_batch",
        meta: {
          gateway: gateway.name,
          uploaded: accepted.length,
          failed: rejected.length,
          consentIds: accepted,
        },
      });
    }
  });

  const overdue = pending.filter((record) => record.overdue).length;

  if (overdue > 0) {
    // Worth a warning on its own: past three business days the business is out
    // of compliance regardless of what happens on the next pass.
    log.warn(
      { organizationId, overdue },
      "İYS consents are past their three-business-day upload deadline",
    );
  }

  log.info(
    { organizationId, uploaded: accepted.length, failed: rejected.length, gateway: gateway.name },
    "İYS upload pass complete",
  );

  return {
    organizationId,
    attempted: pending.length,
    uploaded: accepted.length,
    failed: rejected.length,
    overdue,
    skipped: null,
  };
}
