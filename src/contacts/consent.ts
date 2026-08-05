import { and, asc, eq } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";

/**
 * A contact's permissions, as a record rather than as a verdict (P4-T1).
 *
 * **This module reports; it never decides.** The question "may we message this
 * person" has exactly one answer in this product and it lives in
 * `src/compliance/gate.ts`, because answering it needs an İYS call, the opt-out
 * flag, and the 24-hour service window — none of which a profile screen holds.
 * What a profile screen needs is the evidence: what was granted, when, through
 * what, whether it ever reached the registry, and which gateway accepted it.
 *
 * `iys_uploaded_via` is surfaced deliberately. A row uploaded by the `local`
 * adapter looks identical to a registered one in every column but that, and the
 * whole reason the column exists (P1b-T5) is so the difference stays visible to
 * a human. A screen that hid it would undo that.
 */

export type ConsentState =
  /** Granted, still standing. */
  | "granted"
  /** Granted once, since withdrawn. A row is never deleted on withdrawal. */
  | "revoked";

export type ContactConsent = {
  type: "kvkk" | "iys";
  /** Null for KVKK, which is about processing rather than about a channel. */
  channel: "message" | "call" | "email" | null;
  state: ConsentState;
  grantedAt: Date | null;
  revokedAt: Date | null;
  source: string | null;
  /** İYS only: the three-business-day deadline, and whether it was met. */
  uploadDueAt: Date | null;
  uploadedAt: Date | null;
  /** Which gateway accepted it. `local` is not a registration — see above. */
  uploadedVia: string | null;
  uploadError: string | null;
};

/**
 * Every permission on file for one contact.
 *
 * Keyed on the contact **id**, because that is what `contact_ref` holds — the
 * table is documented as storing a pointer to the contact rather than the PII
 * itself, which is what makes a KVKK erasure one row.
 */
export async function listContactConsent(
  tx: TenantDatabase,
  organizationId: string,
  contactId: string,
): Promise<ContactConsent[]> {
  const rows = await tx
    .select({
      type: schema.consentRecords.type,
      channel: schema.consentRecords.channel,
      grantedAt: schema.consentRecords.grantedAt,
      revokedAt: schema.consentRecords.revokedAt,
      source: schema.consentRecords.source,
      uploadDueAt: schema.consentRecords.iysUploadDueAt,
      uploadedAt: schema.consentRecords.iysUploadedAt,
      uploadedVia: schema.consentRecords.iysUploadedVia,
      uploadError: schema.consentRecords.iysUploadError,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.organizationId, organizationId),
        eq(schema.consentRecords.contactRef, contactId),
      ),
    )
    .orderBy(asc(schema.consentRecords.type), asc(schema.consentRecords.channel));

  return rows.map((row) => ({
    ...row,
    // `revoked_at` is decisive, exactly as it is in the gate: a withdrawn
    // permission that still shows a grant date is how somebody who said stop
    // gets messaged again.
    state: row.revokedAt === null && row.grantedAt !== null ? "granted" : "revoked",
  }));
}
