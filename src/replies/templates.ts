import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { roleAtLeast, type Role } from "../auth/permissions.ts";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { MAX_REPLY_CHARS } from "../prompts/index.ts";
import type { TemplateContext } from "./template-vars.ts";

/**
 * Canned replies (P2-T5).
 *
 * A template is a piece of the organization's voice, written once and reused —
 * "thanks for the kind words", "we are sorry about the wait". It is *not* a
 * reply: nothing here posts anything. A template is rendered into the composer,
 * where a human reads it, edits it, and takes the same approve-and-post path
 * every other reply takes. That is deliberate, and it is why this module has no
 * connector import: a canned message that could publish itself is one bad
 * template away from saying the same wrong thing to two hundred customers.
 *
 * Writing templates needs **admin**; using them needs **member**. The asymmetry
 * matches the consequence — a template shapes what the whole team says in the
 * business's name, while using one is ordinary work that a person still has to
 * sign off before it goes anywhere.
 */

/** A template is a reply in waiting, so it lives under the same ceiling. */
export const MAX_TEMPLATE_BODY = MAX_REPLY_CHARS;

/**
 * How many an organization may keep.
 *
 * A picker is only useful while it can be read at a glance; past fifty it is a
 * search problem, and the answer to that is fewer, better templates rather than
 * a longer list.
 */
export const MAX_TEMPLATES = 50;

export const templateNameSchema = z.string().trim().min(1).max(60);
export const templateBodySchema = z.string().trim().min(1).max(MAX_TEMPLATE_BODY);
export const templateTagsSchema = z.array(z.string().trim().min(1).max(32)).max(8);

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export type ReplyTemplateRecord = {
  id: string;
  name: string;
  body: string;
  language: string;
  tags: string[];
};

/**
 * Every template for the organization.
 *
 * Ordered by language then name so the list reads the same way twice. Callers
 * that know the review's language re-sort with `orderForLanguage` rather than
 * filtering — a Turkish template is still the right answer for an English
 * review when it is the only one that fits.
 */
export async function listReplyTemplates(
  tx: TenantDatabase,
  organizationId: string,
): Promise<ReplyTemplateRecord[]> {
  return tx
    .select({
      id: schema.replyTemplates.id,
      name: schema.replyTemplates.name,
      body: schema.replyTemplates.body,
      language: schema.replyTemplates.language,
      tags: schema.replyTemplates.tags,
    })
    .from(schema.replyTemplates)
    .where(eq(schema.replyTemplates.organizationId, organizationId))
    .orderBy(asc(schema.replyTemplates.language), asc(schema.replyTemplates.name));
}

/**
 * The review's own language first, everything else after, each group still
 * alphabetical.
 *
 * Sorting rather than filtering: a team with three Turkish templates and no
 * English ones should still be offered them on an English review — hiding them
 * would look like the feature is broken, and the person can read both.
 */
export function orderForLanguage<T extends { language: string }>(
  templates: T[],
  language: string | null,
): T[] {
  if (!language) return templates;
  const wanted = language.toLowerCase().split("-")[0];

  return [...templates].sort((left, right) => {
    const leftMatch = left.language.toLowerCase().startsWith(wanted ?? "") ? 0 : 1;
    const rightMatch = right.language.toLowerCase().startsWith(wanted ?? "") ? 0 : 1;
    return leftMatch - rightMatch;
  });
}

export type SaveTemplateInput = {
  organizationId: string;
  role: Role;
  /** Absent when creating. */
  id?: string;
  name: string;
  body: string;
  language: string;
  tags?: string[];
};

/** Creates a template, or updates one in place. Admin only. */
export async function saveReplyTemplate(
  tx: TenantDatabase,
  input: SaveTemplateInput,
): Promise<ReplyTemplateRecord> {
  if (!roleAtLeast(input.role, "admin")) {
    throw new TemplateError("Only an admin can change the team's reply templates.");
  }

  const name = templateNameSchema.parse(input.name);
  const body = templateBodySchema.parse(input.body);
  const tags = templateTagsSchema.parse(input.tags ?? []);

  const values = {
    organizationId: input.organizationId,
    name,
    body,
    language: input.language,
    tags,
  };

  if (!input.id) {
    const [existing] = await tx
      .select({ total: sql<number>`count(*)::int`.mapWith(Number) })
      .from(schema.replyTemplates)
      .where(eq(schema.replyTemplates.organizationId, input.organizationId));

    if ((existing?.total ?? 0) >= MAX_TEMPLATES) {
      throw new TemplateError(`A maximum of ${MAX_TEMPLATES} reply templates is allowed.`);
    }
  }

  const [row] = input.id
    ? await tx
        .update(schema.replyTemplates)
        .set({ ...values, updatedAt: new Date() })
        .where(
          and(
            eq(schema.replyTemplates.organizationId, input.organizationId),
            eq(schema.replyTemplates.id, input.id),
          ),
        )
        .returning()
    : await tx
        .insert(schema.replyTemplates)
        .values(values)
        // Saving twice under the same name in the same language reads as
        // "update it", not as a constraint violation nobody can act on.
        .onConflictDoUpdate({
          target: [
            schema.replyTemplates.organizationId,
            schema.replyTemplates.language,
            schema.replyTemplates.name,
          ],
          set: { body, tags, updatedAt: new Date() },
        })
        .returning();

  if (!row) throw new TemplateError("That template no longer exists.");

  return { id: row.id, name: row.name, body: row.body, language: row.language, tags: row.tags };
}

/** Admin only, for the same reason as saving. */
export async function deleteReplyTemplate(
  tx: TenantDatabase,
  input: { organizationId: string; role: Role; id: string },
): Promise<boolean> {
  if (!roleAtLeast(input.role, "admin")) {
    throw new TemplateError("Only an admin can change the team's reply templates.");
  }

  const deleted = await tx
    .delete(schema.replyTemplates)
    .where(
      and(
        eq(schema.replyTemplates.organizationId, input.organizationId),
        eq(schema.replyTemplates.id, input.id),
      ),
    )
    .returning({ id: schema.replyTemplates.id });

  return deleted.length > 0;
}

/**
 * The context a review supplies to a template.
 *
 * Read here rather than passed in from the browser: the author's name and the
 * location's are facts about a row this tenant owns, and accepting them from the
 * client would let anyone put any words into a template that a colleague then
 * posts under the business's name.
 */
export async function templateContextForReview(
  tx: TenantDatabase,
  organizationId: string,
  reviewId: string,
): Promise<{ context: TemplateContext; language: string | null } | null> {
  const [row] = await tx
    .select({
      author: schema.reviews.authorName,
      language: schema.reviews.language,
      location: schema.locations.name,
      business: schema.organizations.name,
    })
    .from(schema.reviews)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.reviews.locationId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.reviews.organizationId))
    .where(and(eq(schema.reviews.organizationId, organizationId), eq(schema.reviews.id, reviewId)))
    .limit(1);

  if (!row) return null;

  return {
    // The review's language is not a variable — it decides which templates are
    // offered first, which is a different job from filling one in.
    language: row.language,
    context: { author: row.author, location: row.location, business: row.business },
  };
}
