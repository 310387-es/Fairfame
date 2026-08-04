import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { beyondKnownHolidays, iysUploadDeadline } from "./business-days.ts";

/**
 * Capturing and withdrawing consent (P1b-T5).
 *
 * Two kinds live in one table and mean different things:
 *
 *   - **KVKK** consent is permission to *process* someone's personal data. It
 *     is captured when they submit a review and has no channel.
 *   - **İYS** consent is permission to *send them a commercial message*, per
 *     channel, and the Turkish registry is the system of record — ours is a
 *     copy that must be uploaded within three business days.
 *
 * Conflating them is the mistake this module exists to prevent. Someone who
 * ticked "I agree to my data being processed" on a review form has not agreed
 * to marketing, and treating that tick as an İYS permission would be exactly
 * the violation the registry was created to stop.
 *
 * **A withdrawal never deletes a row.** It sets `revoked_at`. The obligation is
 * to prove the state of a permission at a point in time, and a deleted row
 * proves nothing — including, most importantly, that the person said no.
 */

const log = childLogger({ module: "compliance/consent" });

export type ConsentChannel = "message" | "call" | "email";
export type ConsentSource = "web_form" | "in_person" | "import" | "message_reply" | "iys_sync";

export type RecordConsentInput = {
  tx: TenantDatabase;
  organizationId: string;
  /** The contact id — never the phone or email. See the note in ./gate.ts. */
  contactRef: string;
  channel: ConsentChannel;
  source: ConsentSource;
  /** Points at the artefact proving how consent was obtained. */
  proofRef: string;
  now?: Date;
};

/**
 * Records an İYS permission and starts its upload clock.
 *
 * The deadline is stored rather than derived, so a later change to the holiday
 * calendar cannot silently move a deadline that has already passed or been
 * reported.
 */
export async function recordIysConsent(input: RecordConsentInput): Promise<{ dueAt: Date }> {
  const now = input.now ?? new Date();
  const dueAt = iysUploadDeadline(now);

  if (beyondKnownHolidays(dueAt)) {
    // The movable-holiday list has run out. The deadline is still computed —
    // refusing would block consent capture — but it is knowingly optimistic.
    log.warn(
      { organizationId: input.organizationId, dueAt },
      "İYS deadline computed beyond the known holiday calendar; update MOVABLE_HOLIDAYS",
    );
  }

  await input.tx
    .insert(schema.consentRecords)
    .values({
      organizationId: input.organizationId,
      contactRef: input.contactRef,
      type: "iys",
      channel: input.channel,
      source: input.source,
      proofRef: input.proofRef,
      grantedAt: now,
      revokedAt: null,
      iysUploadDueAt: dueAt,
      iysUploadedAt: null,
      iysUploadError: null,
    })
    .onConflictDoUpdate({
      target: [
        schema.consentRecords.organizationId,
        schema.consentRecords.contactRef,
        schema.consentRecords.type,
        schema.consentRecords.channel,
      ],
      set: {
        // Re-granting after a withdrawal is a new permission with a new
        // deadline, not a resurrection of the old one.
        grantedAt: now,
        revokedAt: null,
        source: input.source,
        proofRef: input.proofRef,
        iysUploadDueAt: dueAt,
        iysUploadedAt: null,
        iysUploadError: null,
        updatedAt: now,
      },
    });

  return { dueAt };
}

/**
 * Withdraws a permission.
 *
 * Applies to every channel when none is named, which is what a "STOP" means: a
 * person telling a business to stop contacting them has not distinguished
 * between calls and messages, and asking them to would be absurd.
 */
export async function revokeConsent(input: {
  tx: TenantDatabase;
  organizationId: string;
  contactRef: string;
  channel?: ConsentChannel;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();

  const rows = await input.tx
    .update(schema.consentRecords)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.consentRecords.organizationId, input.organizationId),
        eq(schema.consentRecords.contactRef, input.contactRef),
        input.channel ? eq(schema.consentRecords.channel, input.channel) : undefined,
        // The first withdrawal is the one that counts; re-stamping it would
        // move the date a business may have to prove.
        isNull(schema.consentRecords.revokedAt),
      ),
    )
    .returning({ id: schema.consentRecords.id });

  if (rows.length > 0) {
    log.info(
      { organizationId: input.organizationId, channel: input.channel ?? "all", count: rows.length },
      "Consent withdrawn",
    );
  }

  return rows.length;
}

export type PendingUpload = {
  id: string;
  organizationId: string;
  contactRef: string;
  channel: ConsentChannel;
  grantedAt: Date | null;
  dueAt: Date | null;
  overdue: boolean;
};

/**
 * İYS consents that have not been uploaded yet, most urgent first.
 *
 * Includes overdue rows rather than skipping them: an obligation that has been
 * missed still has to be discharged, and hiding it would make the queue look
 * healthy precisely when it is not.
 */
export async function pendingIysUploads(
  tx: TenantDatabase,
  organizationId: string,
  now = new Date(),
  limit = 200,
): Promise<PendingUpload[]> {
  const rows = await tx
    .select({
      id: schema.consentRecords.id,
      organizationId: schema.consentRecords.organizationId,
      contactRef: schema.consentRecords.contactRef,
      channel: schema.consentRecords.channel,
      grantedAt: schema.consentRecords.grantedAt,
      dueAt: schema.consentRecords.iysUploadDueAt,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.organizationId, organizationId),
        eq(schema.consentRecords.type, "iys"),
        isNull(schema.consentRecords.iysUploadedAt),
        isNull(schema.consentRecords.revokedAt),
      ),
    )
    .orderBy(asc(schema.consentRecords.iysUploadDueAt))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    channel: (row.channel ?? "message") as ConsentChannel,
    overdue: row.dueAt !== null && row.dueAt.getTime() < now.getTime(),
  }));
}

/** Counts consents whose three business days have already elapsed. */
export async function overdueUploadCount(
  tx: TenantDatabase,
  organizationId: string,
  now = new Date(),
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.organizationId, organizationId),
        eq(schema.consentRecords.type, "iys"),
        isNull(schema.consentRecords.iysUploadedAt),
        isNull(schema.consentRecords.revokedAt),
        lte(schema.consentRecords.iysUploadDueAt, now),
      ),
    );

  return row?.count ?? 0;
}

/**
 * Marks a consent as accepted by İYS.
 *
 * `via` is the accepting gateway's name and is not optional, because this row
 * is the evidence that a permission was registered — and a development adapter
 * accepting it locally is not that. Recording which one answered keeps the
 * claim honest in databases where the answer was `local`.
 */
export async function markUploaded(
  tx: TenantDatabase,
  organizationId: string,
  ids: string[],
  via: string,
  now = new Date(),
): Promise<void> {
  if (ids.length === 0) return;

  await tx
    .update(schema.consentRecords)
    .set({ iysUploadedAt: now, iysUploadedVia: via, iysUploadError: null, updatedAt: now })
    .where(
      and(
        eq(schema.consentRecords.organizationId, organizationId),
        sql`${schema.consentRecords.id} = any(${sql.param(ids)}::uuid[])`,
      ),
    );
}

/** Records why an upload failed, leaving it in the queue. */
export async function markUploadFailed(
  tx: TenantDatabase,
  organizationId: string,
  id: string,
  reason: string,
  now = new Date(),
): Promise<void> {
  await tx
    .update(schema.consentRecords)
    .set({ iysUploadError: reason.slice(0, 300), updatedAt: now })
    .where(
      and(
        eq(schema.consentRecords.organizationId, organizationId),
        eq(schema.consentRecords.id, id),
      ),
    );
}
