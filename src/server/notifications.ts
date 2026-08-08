"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { childLogger } from "@/lib/logger";
import { listFeed, markAllRead, markRead, type FeedItem } from "@/notifications/feed";
import { FEED_PAGE_SIZE } from "@/notifications/types";
import { clearPreference, savePreference } from "@/notifications/preferences";
import { clockToMinutes } from "@/notifications/quiet-hours";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

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
  /**
   * The quiet window as clock times (W5-15), or null.
   *
   * `HH:MM` on the wire and minutes in the database: the form produces what a
   * `<input type="time">` produces, and `quiet-hours.ts` owns the conversion so
   * there is one definition of what a valid time is.
   */
  quiet: z
    .object({ from: z.string(), to: z.string() })
    .nullable()
    .transform((value, ctx) => {
      if (!value) return null;
      const from = clockToMinutes(value.from);
      const to = clockToMinutes(value.to);
      if (from === null || to === null) {
        ctx.addIssue({ code: "custom", message: "Quiet hours must be times of day." });
        return z.NEVER;
      }
      // Equal bounds is a zero-length window, and reading it as 24 hours would
      // silence somebody's alerts for ever without them choosing that.
      return from === to ? null : { from, to };
    }),
});

export async function markNotificationsReadAction(input: { ids: string[] }): Promise<ActionResult> {
  const parsed = markReadSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid selection.");

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

/**
 * The bell's popover contents, fetched when it opens.
 *
 * On demand rather than rendered into the shell on every page load: the layout
 * already pays for the unread *count* on each navigation, and paying for the
 * twenty rows behind it as well — on every screen, whether or not anyone opens
 * the bell — is work almost nobody asked for.
 *
 * Scoped to the signed-in user, never to a user id from the client. RLS keeps
 * tenants apart and nothing else, so this filter is the whole protection
 * against reading a colleague's feed.
 */
export async function listNotificationsAction(
  input: { offset?: number } = {},
): Promise<FeedItem[]> {
  const offset = Number.isInteger(input.offset) && input.offset! >= 0 ? input.offset! : 0;

  try {
    return await withAuthenticatedTenant((tx, actor) =>
      listFeed(tx, actor.organizationId, actor.userId, { limit: FEED_PAGE_SIZE, offset }),
    );
  } catch (error) {
    // An empty bell is a better failure than a broken shell.
    log.warn({ err: error }, "listNotifications failed");
    return [];
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
  /** `HH:MM` pair, or null for no quiet hours (W5-15). */
  quiet: { from: string; to: string } | null;
}): Promise<ActionResult> {
  const parsed = preferenceSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid preference.");

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
  if (!parsed.success) return invalidInput(parsed.error, "Invalid location.");

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
