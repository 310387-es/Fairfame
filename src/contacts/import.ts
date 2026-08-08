import { and, eq, isNull, or, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { addContactTag } from "./tags.ts";

/**
 * Importing a customer list (W5-13).
 *
 * > **CSV/POS import** (Adisyo/Simpra).
 *
 * The parsing half already exists: `src/collect/csv.ts` was written in W2.2 for
 * the review-request screen, reads columns by header in Turkish and English,
 * and handles RFC 4180 properly. What was missing is the other half — the list
 * lands in `/get-reviews` as a set of recipients for *one send* and nothing is
 * kept, so a business that imports four hundred customers has to import them
 * again next month.
 *
 * ## The rule this feature must not break
 *
 * **An import creates no permission.** Not a consent record, not an İYS entry,
 * nothing. A file exported from a POS is a list of people who bought a coffee;
 * it is not a list of people who agreed to be marketed to, and the two being
 * the same is the assumption that produces the fine. So imported contacts are
 * created exactly as a walk-in is — a name, an address, no consent — and
 * `checkSendAllowed` refuses every commercial message to them until somebody
 * actually asks. That refusal is the feature working, and the screen says so
 * before the file is uploaded rather than after the first broadcast is blocked.
 *
 * ## Matching
 *
 * `contacts` is unique on `(organization, email)` and on `(organization,
 * phone)`, which is what makes an import idempotent: running the same file
 * twice updates rather than duplicating. A row that matches an existing contact
 * **fills gaps and never overwrites** — a POS export with a blank name must not
 * erase a name somebody typed, and an export that abbreviates "A. Yılmaz" must
 * not replace "Ayşe Yılmaz".
 *
 * ## Adisyo and Simpra
 *
 * Named in the plan, and deliberately **not** built as connectors. Both are
 * credential-gated the same way Google and Meta are — an API key per merchant,
 * obtained through a commercial relationship this company does not have yet —
 * and a connector with no credentials behind it is the thing `docs/13` exists
 * to track. What both of them *export* is a CSV, which is what this reads.
 */

const log = childLogger({ module: "contacts/import" });

/** Rows accepted in one import. Bounded so a mis-selected file cannot hang. */
export const MAX_IMPORT_ROWS = 5_000;

export type ImportRow = {
  email: string | null;
  name: string | null;
  phone: string | null;
};

export type ImportResult = {
  created: number;
  /** Matched an existing contact; blanks filled, nothing overwritten. */
  updated: number;
  /** Rows with neither an address nor a number — nothing to key on. */
  skipped: number;
};

/**
 * Creates or updates contacts from a parsed list.
 *
 * One statement per row rather than a batched upsert, and that is deliberate:
 * a row can match on *either* unique key, so a single `ON CONFLICT` would have
 * to nominate one of them and would duplicate on the other. Five thousand
 * statements inside one transaction is a second of work for an operation
 * somebody runs once a month.
 */
export async function importContacts(
  tx: TenantDatabase,
  organizationId: string,
  rows: readonly ImportRow[],
  options: { tagLabel?: string | null; actorUserId?: string | null } = {},
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, skipped: 0 };

  for (const row of rows.slice(0, MAX_IMPORT_ROWS)) {
    const email = normalize(row.email);
    const phone = normalize(row.phone);
    const name = row.name?.trim() || null;

    // The table's own check constraint says the same thing; refusing here turns
    // a constraint violation into a counted row.
    if (!email && !phone) {
      result.skipped += 1;
      continue;
    }

    const [existing] = await tx
      .select({
        id: schema.contacts.id,
        name: schema.contacts.name,
        email: schema.contacts.email,
        phone: schema.contacts.phone,
      })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.organizationId, organizationId),
          or(
            // Case-insensitive on the address. The unique index is on the raw
            // value, so `Ayse@…` and `ayse@…` can both exist — a pre-existing
            // wart, and matching exactly here would make an import add a second
            // row for somebody already in the list rather than update them.
            email ? sql`lower(${schema.contacts.email}) = ${email}` : undefined,
            phone ? eq(schema.contacts.phone, phone) : undefined,
          ),
        ),
      )
      .limit(1);

    if (existing) {
      // Gaps only. A POS export with a blank name must not erase one somebody
      // typed, and an abbreviation must not replace a full name.
      const patch: Record<string, unknown> = {};
      if (!existing.name && name) patch.name = name;
      if (!existing.email && email) patch.email = email;
      if (!existing.phone && phone) patch.phone = phone;

      if (Object.keys(patch).length > 0) {
        await tx
          .update(schema.contacts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(schema.contacts.id, existing.id));
      }

      if (options.tagLabel) {
        await tagQuietly(
          tx,
          organizationId,
          existing.id,
          options.tagLabel,
          options.actorUserId ?? null,
        );
      }
      result.updated += 1;
      continue;
    }

    const [created] = await tx
      .insert(schema.contacts)
      .values({
        organizationId,
        name,
        email,
        phone,
        // No consent, no İYS record, nothing. See the module comment: a POS
        // export is a list of people who bought something.
      })
      .returning({ id: schema.contacts.id });

    if (created) {
      if (options.tagLabel) {
        await tagQuietly(
          tx,
          organizationId,
          created.id,
          options.tagLabel,
          options.actorUserId ?? null,
        );
      }
      result.created += 1;
    }
  }

  log.info({ organizationId, ...result }, "Imported contacts");
  return result;
}

/**
 * Tags an imported contact, and never fails the import over it.
 *
 * `addContactTag` enforces a per-contact ceiling and refuses past it. A contact
 * who is already at the limit is still a contact worth importing, and losing
 * four hundred rows because one of them had too many labels would be the wrong
 * trade by a wide margin.
 */
async function tagQuietly(
  tx: TenantDatabase,
  organizationId: string,
  contactId: string,
  label: string,
  userId: string | null,
): Promise<void> {
  try {
    await addContactTag(tx, { organizationId, contactId, label, userId });
  } catch (error) {
    log.debug({ contactId, err: error }, "Import tag skipped");
  }
}

/**
 * Trims, lower-cases, and turns an empty string into null.
 *
 * Null rather than `""` because the unique keys are on the columns themselves:
 * two contacts with an empty-string email would collide with each other and
 * with nobody real.
 */
function normalize(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

/**
 * How many of these people could actually be messaged today.
 *
 * Shown after an import, because the number that matters to somebody who has
 * just uploaded four hundred customers is not four hundred — it is zero, and
 * finding that out when the first broadcast is refused is the worst possible
 * moment. See `src/compliance/gate.ts` for what actually decides a send; this
 * is a count, never a permission.
 */
export async function messageableCount(
  tx: TenantDatabase,
  organizationId: string,
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.contacts)
    .innerJoin(
      schema.consentRecords,
      and(
        eq(schema.consentRecords.organizationId, schema.contacts.organizationId),
        // `contact_ref` is **text**, not a uuid: its own comment says it holds
        // "a phone/email hash or a contact id", because a consent may be
        // recorded against somebody who is not a contact row yet. So the join
        // casts rather than comparing types Postgres will refuse — which is
        // exactly what it did, in a toast, in front of the file input.
        sql`${schema.consentRecords.contactRef} = ${schema.contacts.id}::text`,
        eq(schema.consentRecords.type, "iys"),
        isNull(schema.consentRecords.revokedAt),
      ),
    )
    .where(
      and(
        eq(schema.contacts.organizationId, organizationId),
        isNull(schema.contacts.unsubscribedAt),
      ),
    );

  return row?.total ?? 0;
}
