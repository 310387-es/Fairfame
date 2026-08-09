"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { weekWindow } from "@/digest/metrics";
import {
  digestProgress,
  setActionStatus,
  windowReadiness,
  type DigestProgress,
} from "@/digest/queries";
import { requestDigest } from "@/jobs/client";
import { childLogger } from "@/lib/logger";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Digest actions (P1a-T7).
 *
 * Generation is queued, never run inline. The pipeline makes two or three model
 * calls and can take the better part of a minute; a server action that waited
 * would hold a request open and time out behind most proxies. The Home screen
 * (T8) shows the previous digest until the new one lands.
 */

const log = childLogger({ module: "server/digests" });

/**
 * What the caller must know to tell a finished refresh from one that has not
 * started (A22-A1).
 *
 * A refresh leaves the row `ready` for its whole duration — that is the fix —
 * so "is it done" cannot be answered by the status any more. The action reports
 * the composition time *at the moment the job was queued*, and the button waits
 * for that to move. Without it the first poll, three seconds in, would find a
 * ready digest that nobody had touched yet and declare success.
 */
export type DigestQueued = { queuedAgainst: string | null };

export async function generateDigestAction(input: {
  locationId: string;
}): Promise<ActionResult<DigestQueued>> {
  const parsed = z.object({ locationId: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid location.");

  try {
    const outcome = await withAuthenticatedTenant(
      async (tx, actor) => {
        const window = weekWindow(new Date());

        // Asked before the job is queued, not after a minute of spinner: the
        // pipeline would decline this window and the owner would read the
        // refusal as a broken button. The screen disables the control for the
        // same reason — this is the half that a disabled control is not.
        const readiness = await windowReadiness(
          tx,
          actor.organizationId,
          parsed.data.locationId,
          window,
        );

        if (!readiness.enough) return { refused: "not_enough_analysed" as const };

        const before = await digestProgress(
          tx,
          actor.organizationId,
          parsed.data.locationId,
          window.start,
        );

        const queued = await requestDigest({
          organizationId: actor.organizationId,
          locationId: parsed.data.locationId,
          force: true,
        });

        return { queued, queuedAgainst: before.generatedAt?.toISOString() ?? null };
      },
      // Regenerating spends the AI allowance, so it is not a member's call.
      { minimumRole: "admin" },
    );

    if ("refused" in outcome) {
      return { ok: false, error: "There is not enough analysed feedback in that week yet." };
    }

    if (!outcome.queued) {
      return { ok: false, error: "Could not queue the digest. Try again shortly." };
    }

    revalidatePath("/", "layout");
    return { ok: true, queuedAgainst: outcome.queuedAgainst };
  } catch (error) {
    log.warn({ err: error }, "generateDigest failed");
    return toActionResult(error);
  }
}

/**
 * How the digest being composed is getting on.
 *
 * Polled by the Home button after it queues one. Read-only and cheap — one
 * indexed row by (organization, location, period) — so a few seconds' interval
 * costs nothing, and it is the same tenant-scoped path as every other read
 * rather than a side channel that skips RLS.
 *
 * It reports on the window the button actually targets, the last *completed*
 * week, not on whatever Home happens to be rendering: during a regeneration
 * those differ, because a pending row stops being the newest ready one.
 */
/**
 * `DigestProgress` with the timestamp as a string.
 *
 * The button compares it with the one `generateDigestAction` handed back, and a
 * comparison between two things that crossed a serialization boundary should be
 * between two of the same thing.
 */
export type DigestProgressPayload = Omit<DigestProgress, "generatedAt"> & {
  generatedAt: string | null;
};

export async function digestProgressAction(input: {
  locationId: string;
}): Promise<ActionResult<DigestProgressPayload>> {
  const parsed = z.object({ locationId: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid location.");

  try {
    const progress = await withAuthenticatedTenant(
      async (tx, actor) =>
        digestProgress(
          tx,
          actor.organizationId,
          parsed.data.locationId,
          weekWindow(new Date()).start,
        ),
      // Reading progress is not spending anything; anyone who can see Home can
      // see whether it is still being written.
      { minimumRole: "member" },
    );

    return { ok: true, ...progress, generatedAt: progress.generatedAt?.toISOString() ?? null };
  } catch (error) {
    log.warn({ err: error }, "digestProgress failed");
    return toActionResult(error);
  }
}

const statusSchema = z.object({
  actionId: z.uuid(),
  status: z.enum(["open", "done", "dismissed"]),
});

/** Marks one of the three recommended actions done, dismissed, or open again. */
export async function setDigestActionStatusAction(input: {
  actionId: string;
  status: string;
}): Promise<ActionResult> {
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid action.");

  try {
    const updated = await withAuthenticatedTenant(
      async (tx, actor) =>
        setActionStatus(tx, {
          organizationId: actor.organizationId,
          actionId: parsed.data.actionId,
          status: parsed.data.status,
          userId: actor.userId,
        }),
      // Doing the work is ordinary work; anyone on the team can record it.
      { minimumRole: "member" },
    );

    if (!updated) return { ok: false, error: "That action does not exist." };

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "setDigestActionStatus failed");
    return toActionResult(error);
  }
}
