"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { LOCALES } from "@/i18n/config";
import { childLogger } from "@/lib/logger";
import { renderTemplate } from "@/replies/template-vars";
import {
  deleteReplyTemplate,
  listReplyTemplates,
  orderForLanguage,
  saveReplyTemplate,
  templateBodySchema,
  templateContextForReview,
  templateNameSchema,
  templateTagsSchema,
  TemplateError,
} from "@/replies/templates";
import { toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Reply-template actions (P2-T5).
 *
 * The rendered body is produced **here**, on the server, from the review's own
 * row — never assembled in the browser. The author's name is untrusted text that
 * ends up in a message published under the business's name, so the one place it
 * gets substituted is the one place that also owns the single-pass rule in
 * `renderTemplate`.
 *
 * Nothing in this file posts anything. A chosen template lands in the composer
 * as editable text and then takes the ordinary draft → approve → post path,
 * which is what keeps a canned message from becoming an automated one.
 */

const log = childLogger({ module: "server/reply-templates" });

const saveSchema = z.object({
  id: z.uuid().optional(),
  name: templateNameSchema,
  body: templateBodySchema,
  language: z.enum(LOCALES),
  tags: templateTagsSchema.optional(),
});

function toTemplateResult(error: unknown): ActionResult {
  if (error instanceof TemplateError) return { ok: false, error: error.message };
  return toActionResult(error);
}

export type PickableTemplate = {
  id: string;
  name: string;
  language: string;
  /** Already filled in for this review. */
  body: string;
};

/**
 * The templates offered on one review, ready to insert.
 *
 * Fetched when the picker opens rather than shipped with every card: twenty
 * cards each carrying every template is the same list serialized twenty times,
 * for a control most readers never open.
 */
export async function listTemplatesForReviewAction(input: {
  reviewId: string;
}): Promise<PickableTemplate[]> {
  const parsed = z.object({ reviewId: z.uuid() }).safeParse(input);
  if (!parsed.success) return [];

  try {
    return await withAuthenticatedTenant(
      async (tx, actor) => {
        const resolved = await templateContextForReview(
          tx,
          actor.organizationId,
          parsed.data.reviewId,
        );
        // RLS already hides another tenant's review, so this is the "no such
        // review here" case rather than a permission failure.
        if (!resolved) return [];

        const templates = await listReplyTemplates(tx, actor.organizationId);

        return orderForLanguage(templates, resolved.language).map((template) => ({
          id: template.id,
          name: template.name,
          language: template.language,
          body: renderTemplate(template.body, resolved.context),
        }));
      },
      { minimumRole: "member" },
    );
  } catch (error) {
    // An empty picker is a better failure than a broken composer — writing by
    // hand and drafting with AI both still work.
    log.warn({ err: error }, "listTemplatesForReview failed");
    return [];
  }
}

export async function saveReplyTemplateAction(input: {
  id?: string;
  name: string;
  body: string;
  language: string;
  tags?: string[];
}): Promise<ActionResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Give the template a name and something to say." };
  }

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await saveReplyTemplate(tx, {
          organizationId: actor.organizationId,
          role: actor.role,
          ...parsed.data,
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/settings");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "saveReplyTemplate failed");
    return toTemplateResult(error);
  }
}

export async function deleteReplyTemplateAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Unknown template." };

  try {
    const removed = await withAuthenticatedTenant(
      (tx, actor) =>
        deleteReplyTemplate(tx, {
          organizationId: actor.organizationId,
          role: actor.role,
          id: parsed.data.id,
        }),
      { minimumRole: "admin" },
    );

    if (!removed) return { ok: false, error: "That template no longer exists." };

    revalidatePath("/settings");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "deleteReplyTemplate failed");
    return toTemplateResult(error);
  }
}
