"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/auth/config";
import { getSession, withAuthenticatedTenant } from "@/auth/session";
import { getLocale } from "@/i18n/locale";
import { getAdminDb, schema } from "@/db/client";
import { childLogger } from "@/lib/logger";
import { onboardingStatus, stepFirstBriefing } from "@/onboarding/first-briefing";
import { fillSampleWorkspace, isSampleOrganization, markSample } from "@/onboarding/sample";
import { toActionResult, invalidInput, type ActionResult } from "@/server/action-result";

/**
 * Onboarding actions: the sample workspace, and the first briefing (W5-14).
 *
 * Two things that look separate and are one pipeline. "Explore with sample
 * data" and "you have just connected Google" both end in the same place — a
 * location with reviews and no analysis — and both want the same next step,
 * which is the product's hero screen composed over what actually arrived rather
 * than a week of waiting.
 *
 * `advanceFirstBriefingAction` is deliberately **driven by the browser** rather
 * than by the queue. One call analyses a batch and reports; the welcome screen
 * calls it until there is a digest. That makes the first briefing work with no
 * worker process at all, and closing the tab half way leaves the existing
 * sweeps to finish — degrading to the behaviour that existed before, which is
 * the right failure for something on the signup path.
 */

const log = childLogger({ module: "server/onboarding" });

/** Slug suffix, so two people exploring at once do not collide. */
function sampleSlug(): string {
  return `ornek-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Creates the sample workspace and makes it the active one.
 *
 * The organization goes through **BetterAuth**, exactly as
 * `CreateOrganizationForm` does: it owns membership, the creator's role and the
 * `afterCreateOrganization` hook that provisions the trial. Writing the rows
 * here would be a second, quietly divergent way to make an organization.
 *
 * Idempotent at the level that matters — a second press finds the existing
 * sample workspace and switches to it rather than minting another café.
 */
export async function createSampleWorkspaceAction(): Promise<
  ActionResult<{ organizationId: string }>
> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Sign in first." };

  try {
    const existing = await existingSampleFor(session.user.id);

    /**
     * The demo speaks the reader's language.
     *
     * The digest is composed in the *location's* locale, so a sample workspace
     * hard-coded to `tr` handed an English-speaking visitor a Turkish briefing
     * — correct behaviour for a Turkish café and the wrong first impression for
     * the one person it was built to impress. The café stays in Kadıköy; only
     * the language the plan is written in follows the reader.
     */
    const locale = await getLocale();

    const organizationId =
      existing ??
      (
        await auth.api.createOrganization({
          headers: await headers(),
          body: { name: "Moda Kahve (örnek)", slug: sampleSlug(), locale },
        })
      )?.id;

    if (!organizationId) return { ok: false, error: "Could not create the sample workspace." };

    // Before anything is written into it: an organization that is going to hold
    // invented reviews must be flagged from the first row, not after them.
    if (!existing) await markSample(organizationId);

    await fillSampleWorkspace(organizationId, locale);

    // The shell reads the active organization from the session, so this has to
    // happen before the welcome screen renders.
    await auth.api.setActiveOrganization({
      headers: await headers(),
      body: { organizationId },
    });

    revalidatePath("/", "layout");
    return { ok: true, organizationId };
  } catch (error) {
    log.warn({ err: error }, "createSampleWorkspace failed");
    return toActionResult(error);
  }
}

/** This person's sample workspace, if they already made one. */
async function existingSampleFor(userId: string): Promise<string | null> {
  const rows = await getAdminDb()
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .innerJoin(schema.memberships, eq(schema.memberships.organizationId, schema.organizations.id))
    .where(eq(schema.memberships.userId, userId))
    .limit(50);

  for (const row of rows) {
    if (await isSampleOrganization(row.id)) return row.id;
  }

  return null;
}

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
      },
    };
  } catch (error) {
    log.warn({ err: error }, "advanceFirstBriefing failed");
    return toActionResult(error);
  }
}

/**
 * Deletes the sample workspace.
 *
 * Refuses anything not flagged `is_sample`, which is the only reason this can
 * be a one-click destructive action at all: there is no argument a caller can
 * pass that makes it delete a real business's data. The cascade on
 * `organizations` takes the reviews, the connection, the digests and the
 * membership with it.
 *
 * Owner role, and the switch away happens first — deleting the organization the
 * session is pointing at would leave a session addressing a row that no longer
 * exists.
 */
export async function deleteSampleWorkspaceAction(): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Sign in first." };

  try {
    const organizationId = await withAuthenticatedTenant(
      async (_tx, actor) => actor.organizationId,
      { minimumRole: "owner" },
    );

    if (!(await isSampleOrganization(organizationId))) {
      return { ok: false, error: "This is not the sample workspace." };
    }

    const other = await getAdminDb()
      .select({ id: schema.organizations.id, isSample: schema.organizations.isSample })
      .from(schema.organizations)
      .innerJoin(schema.memberships, eq(schema.memberships.organizationId, schema.organizations.id))
      .where(eq(schema.memberships.userId, session.user.id))
      .limit(50)
      .then((rows) => rows.find((row) => row.id !== organizationId && !row.isSample) ?? null);

    if (other) {
      await auth.api.setActiveOrganization({
        headers: await headers(),
        body: { organizationId: other.id },
      });
    }

    await getAdminDb()
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, organizationId));

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "deleteSampleWorkspace failed");
    return toActionResult(error);
  }
}
