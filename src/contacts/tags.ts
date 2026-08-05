import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/client.ts";
import { slugify } from "../seo/slug.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";

/**
 * Labels a business puts on people (P4-T1).
 *
 * The vocabulary is derived, not stored. `contact_tags` holds the normalised
 * `slug` and the typed `label` on every row, and the organization's list of
 * labels is `select distinct` over it — see the schema comment for why there is
 * no second table.
 *
 * The rule that keeps that honest is here: **a slug already in use adopts the
 * label already in use.** Without it "VIP", "Vip" and "vip " would each keep
 * their own casing on different people while filtering as one tag, and the chip
 * row would show three spellings of one thing.
 */

/** Long enough for "kurumsal müşteri", short enough to render as a chip. */
export const contactTagLabelSchema = z.string().trim().min(1).max(40);

/** How many labels one contact may carry. A profile is not a taxonomy. */
export const MAX_TAGS_PER_CONTACT = 12;

export class ContactTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactTagError";
  }
}

/**
 * What a typed label becomes.
 *
 * Reuses the Turkish-aware slugifier written for hosted-page addresses, and for
 * the same reason: `ı` is not `i` with a mark, `İ.toLowerCase()` depends on the
 * server's locale, and a naive NFD pass silently drops `ğ`. A business tagging
 * people "Şikayet" must get one tag whatever anyone's keyboard did.
 */
export function contactTagSlug(label: string): string {
  return slugify(label);
}

export type ContactTag = { slug: string; label: string };

/**
 * Applies a label to a contact.
 *
 * Returns the tag as it was actually stored, which may not be what was typed —
 * see the label-adoption rule above. Idempotent: applying a label the contact
 * already carries is a no-op rather than an error, because the button that
 * calls this reads as "make sure this person is a VIP".
 */
export async function addContactTag(
  tx: TenantDatabase,
  input: { organizationId: string; contactId: string; label: string; userId: string | null },
): Promise<ContactTag> {
  const typed = contactTagLabelSchema.parse(input.label);
  const slug = contactTagSlug(typed);

  // A label made entirely of punctuation, or of a script the transliterator
  // does not cover, reduces to nothing — and a tag with no slug can never be
  // filtered for or removed by name.
  if (!slug) throw new ContactTagError("That label cannot be used as a tag.");

  const [existing] = await tx
    .select({ label: schema.contactTags.label })
    .from(schema.contactTags)
    .where(
      and(
        eq(schema.contactTags.organizationId, input.organizationId),
        eq(schema.contactTags.slug, slug),
      ),
    )
    .limit(1);

  const label = existing?.label ?? typed;

  const [count] = await tx
    .select({ value: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.contactTags)
    .where(eq(schema.contactTags.contactId, input.contactId));

  // Checked before the insert rather than after, and only when the tag is
  // genuinely new — re-applying an existing label must not fail at the cap.
  if ((count?.value ?? 0) >= MAX_TAGS_PER_CONTACT) {
    const [already] = await tx
      .select({ id: schema.contactTags.id })
      .from(schema.contactTags)
      .where(
        and(eq(schema.contactTags.contactId, input.contactId), eq(schema.contactTags.slug, slug)),
      )
      .limit(1);

    if (!already) {
      throw new ContactTagError(`A contact can carry at most ${MAX_TAGS_PER_CONTACT} tags.`);
    }
  }

  await tx
    .insert(schema.contactTags)
    .values({
      organizationId: input.organizationId,
      contactId: input.contactId,
      slug,
      label,
      taggedByUserId: input.userId,
    })
    .onConflictDoUpdate({
      target: [schema.contactTags.contactId, schema.contactTags.slug],
      // Re-applying refreshes the label to whatever the organization now uses,
      // so a rename that raced with this write does not leave one row behind.
      set: { label, updatedAt: new Date() },
    });

  return { slug, label };
}

/** Removes one label from one contact. Returns false when it was not there. */
export async function removeContactTag(
  tx: TenantDatabase,
  input: { organizationId: string; contactId: string; slug: string },
): Promise<boolean> {
  const removed = await tx
    .delete(schema.contactTags)
    .where(
      and(
        eq(schema.contactTags.organizationId, input.organizationId),
        eq(schema.contactTags.contactId, input.contactId),
        eq(schema.contactTags.slug, input.slug),
      ),
    )
    .returning({ id: schema.contactTags.id });

  return removed.length > 0;
}

export type ContactTagSummary = ContactTag & { contactCount: number };

/**
 * The organization's labels, most-used first.
 *
 * Grouped by slug, and the label taken with `min()` so the answer is stable
 * even if two spellings survived an import — the adoption rule keeps them from
 * arising, and this keeps the list deterministic if one ever does.
 */
export async function listContactTags(
  tx: TenantDatabase,
  organizationId: string,
): Promise<ContactTagSummary[]> {
  const rows = await tx
    .select({
      slug: schema.contactTags.slug,
      label: sql<string>`min(${schema.contactTags.label})`,
      contactCount: sql<number>`count(distinct ${schema.contactTags.contactId})::int`.mapWith(
        Number,
      ),
    })
    .from(schema.contactTags)
    .where(eq(schema.contactTags.organizationId, organizationId))
    .groupBy(schema.contactTags.slug)
    .orderBy(
      desc(sql`count(distinct ${schema.contactTags.contactId})`),
      asc(schema.contactTags.slug),
    );

  return rows;
}

/** Every label on a set of contacts, keyed by contact id — for the list screen. */
export async function tagsForContacts(
  tx: TenantDatabase,
  organizationId: string,
  contactIds: string[],
): Promise<Map<string, ContactTag[]>> {
  if (contactIds.length === 0) return new Map();

  const rows = await tx
    .select({
      contactId: schema.contactTags.contactId,
      slug: schema.contactTags.slug,
      label: schema.contactTags.label,
    })
    .from(schema.contactTags)
    .where(
      and(
        eq(schema.contactTags.organizationId, organizationId),
        inArray(schema.contactTags.contactId, contactIds),
      ),
    )
    .orderBy(asc(schema.contactTags.slug));

  const byContact = new Map<string, ContactTag[]>();
  for (const row of rows) {
    const list = byContact.get(row.contactId) ?? [];
    list.push({ slug: row.slug, label: row.label });
    byContact.set(row.contactId, list);
  }

  return byContact;
}
