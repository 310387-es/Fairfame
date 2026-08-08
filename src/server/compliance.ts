"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { schema } from "@/db/client";
import { eraseSubject, exportSubject, type SubjectExport } from "@/compliance/subject-rights";
import { findContactByIdentifier } from "@/compliance/overview";
import { childLogger } from "@/lib/logger";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * KVKK subject requests, handled from the compliance page (positioning win 3).
 *
 * `exportSubject` and `eraseSubject` have existed since P1b-T5 and were
 * reachable only from an individual contact's profile — which assumes the
 * operator has already found the person. A real subject request arrives as an
 * email saying "delete my data, my number is 0532…", so the entry point has to
 * be the identifier the person actually gave, not a row id.
 *
 * Admin on both, and both audit-logged. Erasure especially: the whole value of
 * a compliance record is being able to say *when* somebody was erased and *who*
 * did it, and an append-only log is the only place that survives the erasure
 * itself.
 */

const log = childLogger({ module: "server/compliance" });

const lookupSchema = z.object({ identifier: z.string().trim().min(3).max(200) });

export type SubjectLookup = {
  contactId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
};

/**
 * Finds the person a subject request is about.
 *
 * A miss is `{ ok: true, match: null }`, not an error. "We hold nothing about
 * this person" is a legitimate answer to a subject request — often the correct
 * one — and dressing it as a failure would make an operator doubt a true
 * result.
 */
export async function lookupSubjectAction(input: {
  identifier: string;
}): Promise<ActionResult<{ match: SubjectLookup | null }>> {
  const parsed = lookupSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Enter an email address or phone number.");

  try {
    const match = await withAuthenticatedTenant(
      (tx, actor) => findContactByIdentifier(tx, actor.organizationId, parsed.data.identifier),
      { minimumRole: "admin" },
    );

    return {
      ok: true,
      match: match
        ? { contactId: match.id, name: match.name, email: match.email, phone: match.phone }
        : null,
    };
  } catch (error) {
    log.warn({ err: error }, "lookupSubject failed");
    return toActionResult(error);
  }
}

/** Everything held about one person, as data. Audit-logged: an export is a disclosure. */
export async function exportSubjectAction(input: {
  contactId: string;
}): Promise<ActionResult<{ subject: SubjectExport }>> {
  const parsed = z.object({ contactId: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Unknown contact.");

  try {
    const subject = await withAuthenticatedTenant(
      async (tx, actor) => {
        const result = await exportSubject(tx, actor.organizationId, parsed.data.contactId);
        if (!result) throw new Error("That contact does not exist.");

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "kvkk.exported",
          entity: `contact:${parsed.data.contactId}`,
          // Never the exported data itself — an append-only log is the worst
          // place to keep a second copy of what somebody may ask us to erase.
          meta: { via: "compliance_page" },
        });

        return result;
      },
      { minimumRole: "admin" },
    );

    return { ok: true, subject };
  } catch (error) {
    log.warn({ err: error }, "exportSubject failed");
    return toActionResult(error);
  }
}

/** Erases a person. Irreversible, admin-only, and logged with what it touched. */
export async function eraseSubjectAction(input: {
  contactId: string;
}): Promise<ActionResult<{ reviewsAnonymised: number }>> {
  const parsed = z.object({ contactId: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Unknown contact.");

  try {
    const result = await withAuthenticatedTenant(
      async (tx, actor) => {
        const outcome = await eraseSubject(tx, actor.organizationId, parsed.data.contactId);

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "kvkk.erased",
          entity: `contact:${parsed.data.contactId}`,
          // Counts, not content. This row is the evidence the obligation was
          // discharged, and it has to outlive the data it is about.
          meta: { ...outcome, via: "compliance_page" },
        });

        return outcome;
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/compliance");
    revalidatePath("/contacts");
    return { ok: true, reviewsAnonymised: result.reviewsAnonymised };
  } catch (error) {
    log.warn({ err: error }, "eraseSubject failed");
    return toActionResult(error);
  }
}
