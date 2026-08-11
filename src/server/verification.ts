"use server";

import { headers } from "next/headers";
import { auth } from "@/auth/config";
import { requireActor } from "@/auth/session";
import { senderVerification } from "@/auth/verification";
import { childLogger } from "@/lib/logger";
import { toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Sending the verification email again (P5-T4).
 *
 * **The way out of the refusal, attached to the refusal.** `requireVerifiedSender`
 * stops a send and names the reason; a named reason with no action beside it is
 * a dead end, and the product's house style is that a refusal says what to do
 * next. The one thing somebody in that position needs is the email again — the
 * first one is twenty-four hours old, or went to spam, or was read on a phone
 * that is now in another room.
 *
 * Delegated to BetterAuth's own endpoint rather than re-minting a token here,
 * for the same reason `inviteMemberAction` delegates: it owns the token, the
 * expiry and the single-use semantics, and a second implementation would
 * eventually disagree with the first about what a valid link is.
 *
 * **It refuses nothing and reveals nothing.** An already-verified caller gets
 * `alreadyVerified` rather than a second email, because re-verifying is not a
 * thing that can happen and sending mail anyway would be noise. There is no
 * enumeration risk to manage here — unlike password reset, the caller is
 * authenticated and can only ever ask about their own address, which is why
 * this may say plainly what the reset endpoint deliberately will not.
 */

const log = childLogger({ module: "server/verification" });

export async function resendVerificationEmailAction(): Promise<
  ActionResult<{ alreadyVerified?: boolean }>
> {
  try {
    // `requireActor` and not `getSession`: this sends mail, so it needs the
    // same footing as anything else that does. It also means an expired session
    // reports as unauthenticated rather than as a silent no-op.
    const actor = await requireActor();

    const { verified, email } = await senderVerification(actor.userId);
    if (verified) return { ok: true, alreadyVerified: true };

    await auth.api.sendVerificationEmail({
      headers: await headers(),
      body: { email },
    });

    return { ok: true, alreadyVerified: false };
  } catch (error) {
    log.warn({ err: error }, "resendVerificationEmail failed");
    return toActionResult(error);
  }
}
