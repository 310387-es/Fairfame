"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { parseInboxFilters } from "@/inbox/filters";
import { createSavedView, deleteSavedView, savedViewNameSchema } from "@/inbox/views";
import { childLogger } from "@/lib/logger";
import { toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Saved-view actions (P2-T3).
 *
 * The filter state arrives from the browser as the query string the Inbox is
 * currently showing, and it is re-parsed here rather than trusted: it is user
 * input like any other, and `parseInboxFilters` is the one thing that decides
 * what a filter may contain. Anything unrecognised is dropped, so a hand-crafted
 * payload can save a view — it simply cannot save a *filter* the product does
 * not have.
 *
 * Ownership and role are taken from the session. An action that accepted a user
 * id would let any member write into a colleague's view list, and RLS would not
 * notice: both rows belong to the same organization.
 */

const log = childLogger({ module: "server/saved-views" });

const createSchema = z.object({
  name: savedViewNameSchema,
  shared: z.boolean(),
  /** The current query string, as `URLSearchParams` entries. */
  params: z.record(z.string(), z.string()),
});

export async function createSavedViewAction(input: {
  name: string;
  shared: boolean;
  params: Record<string, string>;
}): Promise<ActionResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the view a name." };

  try {
    await withAuthenticatedTenant(async (tx, actor) => {
      await createSavedView(tx, {
        organizationId: actor.organizationId,
        userId: actor.userId,
        role: actor.role,
        name: parsed.data.name,
        shared: parsed.data.shared,
        filters: parseInboxFilters(parsed.data.params),
      });
    });

    revalidatePath("/inbox");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "createSavedView failed");
    return toActionResult(error);
  }
}

export async function deleteSavedViewAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Unknown view." };

  try {
    const removed = await withAuthenticatedTenant((tx, actor) =>
      deleteSavedView(tx, {
        organizationId: actor.organizationId,
        userId: actor.userId,
        role: actor.role,
        id: parsed.data.id,
      }),
    );

    // Deleting nothing is not an error to shout about — the view is gone either
    // way, which is what the person asked for. It is a refusal only in the sense
    // that a member cannot remove a shared view, and the message says so.
    if (!removed) return { ok: false, error: "That view could not be removed." };

    revalidatePath("/inbox");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "deleteSavedView failed");
    return toActionResult(error);
  }
}
