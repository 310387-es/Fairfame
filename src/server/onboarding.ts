"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { childLogger } from "@/lib/logger";
import { onboardingStatus, stepFirstBriefing } from "@/onboarding/first-briefing";
import { toActionResult, invalidInput, type ActionResult } from "@/server/action-result";

/**
 * The first briefing (W5-14).
 *
 * What happens after a source is connected: a location with reviews and no
 * analysis wants the product's hero screen composed over what actually arrived,
 * rather than a week of waiting for the sweep.
 *
 * `advanceFirstBriefingAction` is deliberately **driven by the browser** rather
 * than by the queue. One call analyses a batch and reports; the welcome screen
 * calls it until there is a digest. That makes the first briefing work with no
 * worker process at all, and closing the tab half way leaves the existing
 * sweeps to finish — degrading to the behaviour that existed before, which is
 * the right failure for something on the signup path.
 *
 * **The sample workspace used to share this file** and was removed on 11 Aug
 * 2026 — "Explore with sample data" ended in the same place as a real connect,
 * which is why the two lived together. See `docs/23` for why it went.
 */

const log = childLogger({ module: "server/onboarding" });

export type FirstBriefingProgress = {
  /** Reviews with text in this branch — the denominator on screen. */
  analysable: number;
  analysed: number;
  /** Set once the briefing exists; the screen navigates to it. */
  digestId: string | null;
  /** True when there is nothing left to compose — with or without a digest. */
  finished: boolean;
  /** No reviews to brief on, so waiting would never end. */
  empty: boolean;
  /**
   * A source is connected and still fetching (A22-B1).
   *
   * `empty` and this together are what the screen needs to tell "nothing to
   * brief on" from "not here yet": with both true it keeps waiting and says so,
   * with only `empty` it stops. Before this the two were the same state, so a
   * new account met a motionless **0/0** bar and a message saying its branch
   * had nothing in it, seconds after connecting a source that did.
   */
  awaitingSync: boolean;
};

/**
 * Reads how far the first briefing has got, and changes nothing.
 *
 * Separate from `advance` because the two have very different durations. A
 * batch is ten model calls, which at the free tier's twelve-a-minute is the
 * better part of a minute — so a screen that only learned the count when a
 * batch *returned* showed a motionless "0 of 15" for fifty seconds, which is
 * what a hang looks like. This is one query, polled every couple of seconds
 * beside the work, so the number moves while the work is still happening.
 */
export async function onboardingProgressAction(input: {
  locationId: string;
}): Promise<ActionResult<{ progress: FirstBriefingProgress }>> {
  const parsed = z.object({ locationId: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Unknown branch.");

  try {
    const status = await withAuthenticatedTenant(
      (tx, actor) => onboardingStatus(tx, actor.organizationId, parsed.data.locationId),
      { minimumRole: "member" },
    );

    return {
      ok: true,
      progress: {
        analysable: status.analysable,
        analysed: status.analysed,
        digestId: status.digestId,
        // Only `advance` knows whether it is finished; a reader must never say
        // so, or the screen would navigate away mid-batch.
        finished: false,
        empty: false,
        awaitingSync: status.awaitingSync,
      },
    };
  } catch (error) {
    log.warn({ err: error }, "onboardingProgress failed");
    return toActionResult(error);
  }
}

/**
 * Advances the first briefing by one step and reports where it is.
 *
 * One call is one batch, so the screen has a number that moves; the caller
 * repeats until `finished`. Safe to call after it is done — `stepFirstBriefing`
 * finds nothing pending and returns the digest that already exists.
 */
export async function advanceFirstBriefingAction(input: {
  locationId: string;
}): Promise<ActionResult<{ progress: FirstBriefingProgress }>> {
  const parsed = z.object({ locationId: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Unknown branch.");

  try {
    const organizationId = await withAuthenticatedTenant(
      async (_tx, actor) => actor.organizationId,
      { minimumRole: "member" },
    );

    const step = await stepFirstBriefing({
      organizationId,
      locationId: parsed.data.locationId,
    });

    const status = await withAuthenticatedTenant(
      (tx, actor) => onboardingStatus(tx, actor.organizationId, parsed.data.locationId),
      { minimumRole: "member" },
    );

    if (step.status === "ready") revalidatePath("/", "layout");

    return {
      ok: true,
      progress: {
        analysable: status.analysable,
        analysed: status.analysed,
        digestId: step.status === "ready" ? step.digestId : status.digestId,
        finished: step.status !== "analysing",
        empty: step.status === "no_reviews",
        awaitingSync: status.awaitingSync,
      },
    };
  } catch (error) {
    log.warn({ err: error }, "advanceFirstBriefing failed");
    return toActionResult(error);
  }
}
