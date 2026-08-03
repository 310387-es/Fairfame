"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { childLogger } from "@/lib/logger";
import { markAllRead, markRead } from "@/notifications/feed";
import { clearPreference, savePreference } from "@/notifications/preferences";
import { toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Notification actions (P1a-T5).
 *
 * Every one of these acts on the *caller's own* notifications. The user id
 * comes from the session, never from the client — an action that accepted a
 * user id would let any member mark another's alerts read or rewrite their
 * preferences, and RLS would not notice, because both rows belong to the same
 * organization.
 */

const log = childLogger({ module: "server/notifications" });

const markReadSchema = z.object({ ids: z.array(z.uuid()).min(1).max(200) });

const preferenceSchema = z.object({
  // Null is the organization-wide default row; a uuid overrides one location.
  locationId: z.uuid().nullable(),
  scope: z.enum(["all", "negative_only", "off"]),
  delivery: z.enum(["instant", "digest"]),
  inApp: z.boolean(),
  email: z.boolean(),
});

export async function markNotificationsReadAction(input: { ids: string[] }): Promise<ActionResult> {
  const parsed = markReadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid selection." };

  try {
    await withAuthenticatedTenant(async (tx, actor) => {
      await markRead(tx, actor.organizationId, actor.userId, parsed.data.ids);
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "markNotificationsRead failed");
    return toActionResult(error);
  }
}

export async function markAllNotificationsReadAction(): Promise<ActionResult> {
  try {
    await withAuthenticatedTenant(async (tx, actor) => {
      await markAllRead(tx, actor.organizationId, actor.userId);
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "markAllNotificationsRead failed");
    return toActionResult(error);
  }
}

export async function saveNotificationPreferenceAction(input: {
  locationId: string | null;
  scope: string;
  delivery: string;
  inApp: boolean;
  email: boolean;
}): Promise<ActionResult> {
  const parsed = preferenceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid preference." };

  try {
    await withAuthenticatedTenant(async (tx, actor) => {
      await savePreference(tx, {
        organizationId: actor.organizationId,
        userId: actor.userId,
        ...parsed.data,
      });
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "saveNotificationPreference failed");
    return toActionResult(error);
  }
}

/** Removes a location override so the user's default applies again. */
export async function clearNotificationPreferenceAction(input: {
  locationId: string;
}): Promise<ActionResult> {
  const parsed = z.object({ locationId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid location." };

  try {
    await withAuthenticatedTenant(async (tx, actor) => {
      await clearPreference(tx, actor.organizationId, actor.userId, parsed.data.locationId);
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "clearNotificationPreference failed");
    return toActionResult(error);
  }
}
