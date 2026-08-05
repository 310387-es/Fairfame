"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/auth/config";
import { assertRoleAtLeast, requireActor } from "@/auth/session";
import { requireWithinLimit } from "@/lib/entitlements";
import { childLogger } from "@/lib/logger";
import { withTenant } from "@/lib/tenancy";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Inviting somebody to the team (W1.9).
 *
 * **Delegated to BetterAuth, for the same reason `switchOrganizationAction`
 * is.** Its endpoints own the invitation lifecycle — the token, the expiry, the
 * "already a member" check, the accept that creates the membership — and
 * re-implementing any of that here would mean two answers to "may this person
 * join", with the second one eventually wrong. What this file adds is the two
 * things BetterAuth cannot know: the *seat limit*, which is ours, and the role
 * ceiling.
 *
 * Team size is checked against the plan **before** the invitation is created,
 * not when it is accepted. Sending three invitations on a two-seat plan and
 * then refusing the third person at the door is a worse experience than
 * refusing the third invitation.
 */

const log = childLogger({ module: "server/invitations" });

/**
 * Roles an invitation may grant.
 *
 * `owner` is absent deliberately: an organization has one owner, transferring
 * it is a different act with different consequences, and an invitation is not
 * the place to do it by accident.
 */
const inviteSchema = z.object({
  email: z.email().max(200),
  role: z.enum(["admin", "member", "client"]),
});

export async function inviteMemberAction(input: {
  email: string;
  role: string;
}): Promise<ActionResult> {
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Check the email address and role.");

  try {
    const actor = await requireActor();
    assertRoleAtLeast(actor, "admin");

    // Seats are counted inside the tenant transaction, against live rows, so
    // two admins inviting at once cannot both slip past the limit.
    await withTenant({ organizationId: actor.organizationId, userId: actor.userId }, (tx) =>
      requireWithinLimit({ organizationId: actor.organizationId, tx }, "max_team_members"),
    );

    await auth.api.createInvitation({
      headers: await headers(),
      body: {
        email: parsed.data.email,
        role: parsed.data.role,
        organizationId: actor.organizationId,
      },
    });

    revalidatePath("/team");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "inviteMember failed");
    return toActionResult(error);
  }
}

/** Withdraws an invitation that has not been accepted. */
export async function cancelInvitationAction(input: {
  invitationId: string;
}): Promise<ActionResult> {
  const parsed = z.object({ invitationId: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Unknown invitation.");

  try {
    const actor = await requireActor();
    assertRoleAtLeast(actor, "admin");

    await auth.api.cancelInvitation({
      headers: await headers(),
      body: { invitationId: parsed.data.invitationId },
    });

    revalidatePath("/team");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "cancelInvitation failed");
    return toActionResult(error);
  }
}

/**
 * Accepts an invitation on behalf of the signed-in person.
 *
 * BetterAuth checks that the invitation is theirs — it matches on the session's
 * email — which is the only thing standing between this and "join any
 * organization whose invitation id you can guess". That check is why this is a
 * thin wrapper and not a hand-rolled lookup.
 */
export async function acceptInvitationAction(input: {
  invitationId: string;
}): Promise<ActionResult> {
  const parsed = z.object({ invitationId: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Unknown invitation.");

  try {
    await auth.api.acceptInvitation({
      headers: await headers(),
      body: { invitationId: parsed.data.invitationId },
    });

    // The whole shell changes — a different organization, different nav,
    // different entitlements.
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "acceptInvitation failed");
    return { ok: false, error: "That invitation is not valid any more." };
  }
}
