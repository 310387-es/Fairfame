"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { requireFeature, requireWithinLimit } from "@/lib/entitlements";
import { childLogger } from "@/lib/logger";
import { toActionResult, type ActionResult } from "@/server/action-result";
import { approveAllMatching, setDisplayApproval } from "@/widgets/approval";
import { widgetFiltersSchema, widgetStyleSchema } from "@/widgets/config";
import {
  createWidget,
  deleteWidget,
  getWidget,
  updateWidget,
  type WidgetSummary,
} from "@/widgets/store";

/**
 * Widget actions (P3-T1).
 *
 * Two kinds of write live here and they are not the same weight. Configuring a
 * widget is reversible and private until published. **Approving a review for
 * display puts a customer's words on the business's public website**, which is
 * why both require `admin` and why approval is audit-logged in
 * `src/widgets/approval.ts` rather than here — the record belongs next to the
 * write that earns it, not next to the form that triggered it.
 *
 * Nothing in this file talks to a connector or to a platform. A widget is a
 * read of our own database rendered onto someone's site; there is no outbound
 * call to get wrong.
 */

const log = childLogger({ module: "server/widgets" });

const nameSchema = z.string().trim().min(1).max(80);

/** A location id, or the explicit "every location" choice. */
const locationSchema = z.union([z.uuid(), z.literal("")]).transform((v) => (v === "" ? null : v));

export type WidgetActionResult = ActionResult<{ widget?: WidgetSummary }>;

export async function createWidgetAction(input: {
  name: string;
  locationId: string;
}): Promise<ActionResult<{ id?: string }>> {
  const parsed = z.object({ name: nameSchema, locationId: locationSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the widget a name." };

  try {
    const widget = await withAuthenticatedTenant(
      async (tx, actor) => {
        const org = { organizationId: actor.organizationId, tx };
        await requireFeature(org, "widgets");
        // The plan limit, checked before the row exists rather than after —
        // `max_widgets` counts rows, so creating first and checking second
        // would always pass.
        await requireWithinLimit(org, "max_widgets");

        return createWidget(tx, {
          organizationId: actor.organizationId,
          name: parsed.data.name,
          locationId: parsed.data.locationId,
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/widgets");
    return { ok: true, id: widget.id };
  } catch (error) {
    log.warn({ err: error }, "createWidget failed");
    return toActionResult(error);
  }
}

const saveSchema = z.object({
  id: z.uuid(),
  name: nameSchema,
  locationId: locationSchema,
  filters: widgetFiltersSchema,
  style: widgetStyleSchema,
});

export async function saveWidgetAction(input: unknown): Promise<WidgetActionResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Those settings are not valid." };

  const { id, ...update } = parsed.data;

  try {
    const widget = await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "widgets");
        return updateWidget(tx, actor.organizationId, id, update);
      },
      { minimumRole: "admin" },
    );

    if (!widget) return { ok: false, error: "That widget no longer exists." };

    revalidatePath("/widgets");
    revalidatePath(`/widgets/${id}`);
    return { ok: true, widget };
  } catch (error) {
    log.warn({ err: error }, "saveWidget failed");
    return toActionResult(error);
  }
}

/**
 * Publishing is its own action, never a field on save.
 *
 * Putting a widget on the internet and adjusting its corner radius should not
 * be the same button. Separating them also means the confirmation copy can say
 * what publishing actually does, which a generic "Save" cannot.
 */
export async function setWidgetPublishedAction(input: {
  id: string;
  published: boolean;
}): Promise<WidgetActionResult> {
  const parsed = z.object({ id: z.uuid(), published: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Unknown widget." };

  try {
    const widget = await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "widgets");
        return updateWidget(tx, actor.organizationId, parsed.data.id, {
          published: parsed.data.published,
        });
      },
      { minimumRole: "admin" },
    );

    if (!widget) return { ok: false, error: "That widget no longer exists." };

    revalidatePath("/widgets");
    revalidatePath(`/widgets/${parsed.data.id}`);
    return { ok: true, widget };
  } catch (error) {
    log.warn({ err: error }, "setWidgetPublished failed");
    return toActionResult(error);
  }
}

export async function deleteWidgetAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Unknown widget." };

  try {
    const removed = await withAuthenticatedTenant(
      (tx, actor) => deleteWidget(tx, actor.organizationId, parsed.data.id),
      { minimumRole: "admin" },
    );

    if (!removed) return { ok: false, error: "That widget no longer exists." };

    revalidatePath("/widgets");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "deleteWidget failed");
    return toActionResult(error);
  }
}

// ---------------------------------------------------------------------------
// Display approval
// ---------------------------------------------------------------------------

/**
 * Approve or withdraw specific reviews.
 *
 * The ids come from the browser, so they are validated as UUIDs and then
 * constrained by RLS plus an explicit `organization_id` predicate — a caller
 * pasting another tenant's id changes nothing and is reported as zero.
 */
export async function setDisplayApprovalAction(input: {
  reviewIds: string[];
  approved: boolean;
}): Promise<ActionResult<{ changed?: number }>> {
  const parsed = z
    .object({ reviewIds: z.array(z.uuid()).min(1).max(200), approved: z.boolean() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Nothing to change." };

  try {
    const changed = await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "widgets");
        return setDisplayApproval(
          tx,
          {
            organizationId: actor.organizationId,
            actorUserId: actor.userId,
            approved: parsed.data.approved,
          },
          parsed.data.reviewIds,
        );
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/widgets");
    return { ok: true, changed };
  } catch (error) {
    log.warn({ err: error }, "setDisplayApproval failed");
    return toActionResult(error);
  }
}

/**
 * Approve everything this widget's current selection matches.
 *
 * The widget is re-read server-side rather than trusting a filter posted from
 * the browser. Otherwise "approve all matching" would be an endpoint that
 * approves anything the caller describes, which is a very different feature.
 */
export async function approveAllMatchingAction(input: {
  widgetId: string;
}): Promise<ActionResult<{ changed?: number }>> {
  const parsed = z.object({ widgetId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Unknown widget." };

  try {
    const result = await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "widgets");

        const widget = await getWidget(tx, actor.organizationId, parsed.data.widgetId);
        if (!widget) return null;

        return approveAllMatching(
          tx,
          { organizationId: actor.organizationId, actorUserId: actor.userId },
          {
            organizationId: actor.organizationId,
            locationId: widget.locationId,
            sources: widget.filters.sources,
          },
          widget.filters,
        );
      },
      { minimumRole: "admin" },
    );

    if (result === null) return { ok: false, error: "That widget no longer exists." };

    revalidatePath(`/widgets/${parsed.data.widgetId}`);
    return { ok: true, changed: result };
  } catch (error) {
    log.warn({ err: error }, "approveAllMatching failed");
    return toActionResult(error);
  }
}
