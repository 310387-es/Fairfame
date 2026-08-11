"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "@/auth/config";
import { getSession } from "@/auth/session";
import { organizationAllowance } from "@/auth/organization-limit";
import { EntitlementError } from "@/lib/entitlements";
import { childLogger } from "@/lib/logger";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Creating a workspace, with the plan consulted (11 Aug 2026).
 *
 * **This action exists because there was no server between the button and
 * BetterAuth.** `CreateOrganizationForm` called `organization.create` directly
 * from the browser, so the entitlement layer was never on the path — not
 * bypassed, simply absent. Every organization gets a fresh 14-day top-tier
 * trial from `afterCreateOrganization`, which made unbounded workspace creation
 * unbounded free trials on one account.
 *
 * **Still delegated to BetterAuth**, exactly as `inviteMemberAction` is. It
 * owns the slug uniqueness, the creator's membership, the owner role and the
 * `afterCreateOrganization` hook that provisions the trial. Writing those rows
 * here would be a second, quietly divergent way to make an organization. What
 * this adds is the one thing BetterAuth cannot know: how many workspaces the
 * plan allows.
 *
 * `setActive` stays on the client. It writes to the session cookie, which is
 * the browser's, and the form has to navigate straight afterwards anyway.
 */

const log = childLogger({ module: "server/organizations" });

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  // Built by the form from the name, suffixed for uniqueness. Validated rather
  // than re-derived: the client already showed the customer what it would be.
  slug: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers and hyphens."),
});

export async function createOrganizationAction(input: {
  name: string;
  slug: string;
}): Promise<ActionResult<{ id?: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Check the organization name.");

  try {
    // Not `requireActor`: this person may have no organization at all, which is
    // the ordinary case here — it is the screen straight after signup.
    const session = await getSession();
    if (!session) return { ok: false, error: "Sign in first.", code: "unauthenticated" };

    /**
     * The plan's allowance, checked against organizations this person **owns**.
     *
     * `EntitlementError` rather than a bare refusal, so `toActionResult` gives
     * the UI `entitlement:max_organizations` to hang an upgrade prompt off —
     * the same shape every other limit in the product refuses with.
     */
    const allowance = await organizationAllowance(session.user.id);
    if (!allowance.allowed) {
      throw new EntitlementError(
        `This plan includes ${allowance.limit} workspace${allowance.limit === 1 ? "" : "s"}; ` +
          `you have ${allowance.current}.`,
        "max_organizations",
      );
    }

    const created = await auth.api.createOrganization({
      headers: await headers(),
      body: { name: parsed.data.name, slug: parsed.data.slug },
    });

    if (!created) return { ok: false, error: "Could not create the organization." };

    return { ok: true, id: created.id };
  } catch (error) {
    log.warn({ err: error }, "createOrganization failed");
    return toActionResult(error);
  }
}
