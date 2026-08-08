"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { resolveLocationScope } from "@/auth/scope";
import { addContactTag, contactTagLabelSchema, removeContactTag } from "@/contacts/tags";
import { createSegment, deleteSegment, segmentNameSchema } from "@/contacts/segments";
import { parseContactFilters } from "@/contacts/filters";
import { importContacts, messageableCount, type ImportResult } from "@/contacts/import";
import { parseRecipientCsv } from "@/collect/csv";
import { getContact } from "@/contacts/queries";
import { eraseSubject, exportSubject } from "@/compliance/subject-rights";
import { schema } from "@/db/client";
import { requireFeature } from "@/lib/entitlements";
import { childLogger } from "@/lib/logger";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";
import type { TenantDatabase } from "@/lib/tenancy";
import type { AuthenticatedActor } from "@/auth/session";

/**
 * Contact mutations (P4-T1).
 *
 * Every action here is gated three times, and the third is the one that is new
 * in Phase 4. Role decides *what* a person may do; the `crm` entitlement decides
 * whether the plan includes any of it; and **location scope decides which
 * people they may do it to** — a member pinned to one branch may not tag,
 * unsubscribe or erase a customer they are not allowed to see. That last check
 * is not re-derived here: it goes through `getContact`, which builds its clause
 * from `src/contacts/scope.ts`, so the screen and the mutation cannot disagree
 * about who is visible.
 */

const log = childLogger({ module: "server/contacts" });

/**
 * Loads a contact the actor is actually allowed to touch, or throws.
 *
 * Deliberately one helper rather than a check copied into five actions: the
 * failure mode of the copied version is the sixth action, written later, that
 * quietly does not have it.
 */
async function requireVisibleContact(
  tx: TenantDatabase,
  actor: AuthenticatedActor,
  contactId: string,
): Promise<{ id: string; name: string | null }> {
  await requireFeature({ organizationId: actor.organizationId, tx }, "crm");

  const scope = await resolveLocationScope(tx, actor.organizationId, actor.userId, actor.role);
  const contact = await getContact({
    tx,
    organizationId: actor.organizationId,
    scope,
    contactId,
  });

  // "Not yours to see" and "does not exist" get the same message on purpose —
  // the difference is exactly what the scope was hiding.
  if (!contact) throw new Error("That contact does not exist.");

  return { id: contact.id, name: contact.name };
}

const contactIdSchema = z.object({ contactId: z.uuid() });

export async function addContactTagAction(input: {
  contactId: string;
  label: string;
}): Promise<ActionResult<{ slug?: string; label?: string }>> {
  const parsed = contactIdSchema.extend({ label: contactTagLabelSchema }).safeParse(input);
  if (!parsed.success)
    return invalidInput(parsed.error, parsed.error.issues[0]?.message ?? "Invalid tag.");

  try {
    const tag = await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireVisibleContact(tx, actor, parsed.data.contactId);

        return addContactTag(tx, {
          organizationId: actor.organizationId,
          contactId: parsed.data.contactId,
          label: parsed.data.label,
          userId: actor.userId,
        });
      },
      { minimumRole: "member" },
    );

    revalidatePath(`/contacts/${parsed.data.contactId}`);
    revalidatePath("/contacts");
    return { ok: true, slug: tag.slug, label: tag.label };
  } catch (error) {
    log.warn({ err: error }, "addContactTag failed");
    return toActionResult(error);
  }
}

export async function removeContactTagAction(input: {
  contactId: string;
  slug: string;
}): Promise<ActionResult> {
  const parsed = contactIdSchema.extend({ slug: z.string().min(1).max(80) }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid tag.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireVisibleContact(tx, actor, parsed.data.contactId);

        await removeContactTag(tx, {
          organizationId: actor.organizationId,
          contactId: parsed.data.contactId,
          slug: parsed.data.slug,
        });
      },
      { minimumRole: "member" },
    );

    revalidatePath(`/contacts/${parsed.data.contactId}`);
    revalidatePath("/contacts");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "removeContactTag failed");
    return toActionResult(error);
  }
}

/** Renames a contact. Name only — see the note below. */
export async function renameContactAction(input: {
  contactId: string;
  name: string;
}): Promise<ActionResult> {
  /**
   * Email and phone are deliberately not editable here.
   *
   * They are the contact's identity: they carry unique constraints, they are
   * what `contacts` was created to hold in one place, and every consent record
   * and İYS upload was made against the person those addresses reach. Changing
   * one is not an edit, it is pointing an existing permission at a different
   * human — so it is a new contact, made the way every other contact is made.
   */
  const parsed = contactIdSchema.extend({ name: z.string().trim().max(120) }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid name.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireVisibleContact(tx, actor, parsed.data.contactId);

        await tx
          .update(schema.contacts)
          .set({
            // An emptied field means "we do not know their name", which is a
            // real state — the column is nullable for it.
            name: parsed.data.name.length > 0 ? parsed.data.name : null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.contacts.organizationId, actor.organizationId),
              eq(schema.contacts.id, parsed.data.contactId),
            ),
          );
      },
      { minimumRole: "member" },
    );

    revalidatePath(`/contacts/${parsed.data.contactId}`);
    revalidatePath("/contacts");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "renameContact failed");
    return toActionResult(error);
  }
}

/**
 * Opting a contact out, or lifting the opt-out.
 *
 * Setting it needs only membership: honouring "stop contacting me" must never
 * wait for a manager. **Lifting it needs admin and is audit-logged**, because a
 * business clearing somebody's opt-out on their behalf is the shape of the
 * mistake that ends in a complaint.
 *
 * Lifting it is nonetheless not a way to start messaging someone again. It
 * clears a blanket block; it does not grant permission. The İYS record stays
 * revoked — `revokeConsent` never deletes a row — so `checkSendAllowed` still
 * refuses with `opted_out` until the person themself grants a fresh permission.
 * That separation is what makes this button safe to have at all.
 */
export async function setContactSubscriptionAction(input: {
  contactId: string;
  subscribed: boolean;
}): Promise<ActionResult> {
  const parsed = contactIdSchema.extend({ subscribed: z.boolean() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid input.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireVisibleContact(tx, actor, parsed.data.contactId);

        if (parsed.data.subscribed && actor.role !== "owner" && actor.role !== "admin") {
          throw new Error("Only an admin can clear an opt-out.");
        }

        const now = new Date();

        await tx
          .update(schema.contacts)
          .set({
            unsubscribedAt: parsed.data.subscribed ? null : now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.contacts.organizationId, actor.organizationId),
              eq(schema.contacts.id, parsed.data.contactId),
            ),
          );

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: parsed.data.subscribed ? "contact.opt_out_cleared" : "contact.opted_out",
          entity: `contact:${parsed.data.contactId}`,
          meta: {},
        });
      },
      { minimumRole: "member" },
    );

    revalidatePath(`/contacts/${parsed.data.contactId}`);
    revalidatePath("/contacts");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "setContactSubscription failed");
    return toActionResult(error);
  }
}

/**
 * Saves the current filter as a segment.
 *
 * Takes the **query string**, not a parsed object, so what is stored is exactly
 * what the URL said and there is one parser between the two. See
 * `src/contacts/segments.ts`.
 */
export async function saveSegmentAction(input: {
  name: string;
  query: string;
}): Promise<ActionResult<{ id?: string }>> {
  const parsed = z
    .object({ name: segmentNameSchema, query: z.string().max(2_000) })
    .safeParse(input);
  if (!parsed.success) {
    return invalidInput(parsed.error, parsed.error.issues[0]?.message ?? "Invalid segment.");
  }

  try {
    const segment = await withAuthenticatedTenant(
      async (tx, actor) => {
        const params = Object.fromEntries(new URLSearchParams(parsed.data.query).entries());

        return createSegment(tx, {
          organizationId: actor.organizationId,
          userId: actor.userId,
          role: actor.role,
          name: parsed.data.name,
          filters: parseContactFilters(params),
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/contacts");
    return { ok: true, id: segment.id };
  } catch (error) {
    log.warn({ err: error }, "saveSegment failed");
    return toActionResult(error);
  }
}

export async function deleteSegmentAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid segment.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) =>
        deleteSegment(tx, {
          organizationId: actor.organizationId,
          role: actor.role,
          id: parsed.data.id,
        }),
      { minimumRole: "admin" },
    );

    revalidatePath("/contacts");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "deleteSegment failed");
    return toActionResult(error);
  }
}

/**
 * KVKK: everything held about one person, as JSON.
 *
 * `exportSubject` and `eraseSubject` were written in P1b-T5 and have had no way
 * to be reached since — the contact profile is the screen they were always for,
 * and a legal obligation that only a test can discharge is not discharged.
 *
 * Returned as a string for the browser to save rather than written to a file on
 * the server: the export is a copy of somebody's personal data, and the fewer
 * places it comes to rest, the better.
 */
export async function exportContactAction(input: {
  contactId: string;
}): Promise<ActionResult<{ json?: string }>> {
  const parsed = contactIdSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid contact.");

  try {
    const json = await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireVisibleContact(tx, actor, parsed.data.contactId);

        const data = await exportSubject(tx, actor.organizationId, parsed.data.contactId);
        if (!data) throw new Error("That contact does not exist.");

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "contact.exported",
          entity: `contact:${parsed.data.contactId}`,
          meta: {},
        });

        return JSON.stringify(data, null, 2);
      },
      { minimumRole: "admin" },
    );

    return { ok: true, json };
  } catch (error) {
    log.warn({ err: error }, "exportContact failed");
    return toActionResult(error);
  }
}

/**
 * KVKK erasure. Irreversible, and admin-only.
 *
 * What it does and does not delete is decided in
 * `src/compliance/subject-rights.ts` — reviews are anonymised rather than
 * removed, and consent records are kept and revoked, because the obligation is
 * to be able to prove the state of a permission over time and a deleted row
 * proves nothing, including that the person said no.
 */
export async function eraseContactAction(input: { contactId: string }): Promise<ActionResult> {
  const parsed = contactIdSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid contact.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireVisibleContact(tx, actor, parsed.data.contactId);

        const result = await eraseSubject(tx, actor.organizationId, parsed.data.contactId);

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "contact.erased",
          entity: `contact:${parsed.data.contactId}`,
          meta: {
            reviewsAnonymised: result.reviewsAnonymised,
            consentsRetained: result.consentsRetained,
          },
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/contacts");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "eraseContact failed");
    return toActionResult(error);
  }
}

/**
 * Imports a customer list from a CSV file (W5-13).
 *
 * Parsing is `parseRecipientCsv` — the header-aware reader W2.2 wrote for the
 * review-request screen — so an Adisyo or Simpra export lands the same way here
 * as it does there, and there is one definition of what a column called
 * "e-posta" means.
 *
 * **It grants nothing.** An imported contact has no consent record and no İYS
 * entry, because a POS export is a list of people who bought a coffee rather
 * than a list of people who agreed to be marketed to. `checkSendAllowed`
 * refuses them until somebody actually asks, and the screen says so before the
 * upload rather than after the first broadcast is blocked.
 *
 * Admin: it writes personal data in bulk under the organization's name.
 */
export async function importContactsAction(input: {
  csv: string;
  tagLabel?: string | null;
}): Promise<ActionResult<{ result: ImportResult; invalid: number; messageable: number }>> {
  const parsed = z
    .object({
      // 2 MB of text. Five thousand rows is well under it; the ceiling is
      // against a mis-selected file rather than against a real list.
      csv: z.string().min(1).max(2_000_000),
      tagLabel: z.string().trim().max(60).nullish(),
    })
    .safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "That file could not be read.");

  /*
    `allowPhoneOnly`, and it is not a detail.

    The default refuses a row with no email, which is right for the caller this
    parser was written for — a review request is sent by email. A POS export is
    frequently phone-only, because that is what a till captures, and `contacts`
    accepts either. Without this flag the first real Turkish café file loses
    every customer who paid at the counter and left a number.
  */
  const list = parseRecipientCsv(parsed.data.csv, { allowPhoneOnly: true });

  if (list.recipients.length === 0) {
    return {
      ok: false,
      error: "No email addresses or phone numbers were found in that file.",
    };
  }

  try {
    const outcome = await withAuthenticatedTenant(
      async (tx, actor) => {
        const result = await importContacts(
          tx,
          actor.organizationId,
          list.recipients.map((recipient) => ({
            // Empty means the row was phone-only; `importContacts` turns that
            // into null so the unique key stays usable.
            email: recipient.email,
            name: recipient.name,
            phone: recipient.phone,
          })),
          {
            tagLabel: parsed.data.tagLabel ?? null,
            actorUserId: actor.userId,
          },
        );

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "contacts.imported",
          entity: `organization:${actor.organizationId}`,
          // Counts, never the rows. An append-only log is the worst place for a
          // second copy of personal data somebody may ask us to erase.
          meta: { ...result, invalid: list.invalid.length },
        });

        return {
          result,
          messageable: await messageableCount(tx, actor.organizationId),
        };
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/contacts");
    return { ok: true, ...outcome, invalid: list.invalid.length };
  } catch (error) {
    log.warn({ err: error }, "importContacts failed");
    return toActionResult(error);
  }
}
