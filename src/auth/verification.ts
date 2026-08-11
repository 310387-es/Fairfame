import { eq } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";

/**
 * Whether the person driving a send has proved their own address (P5-T4).
 *
 * ## The rule, in one sentence
 *
 * An account that has not verified its email may use the product, and may not
 * make the product write to somebody else.
 *
 * ## Why the rule exists
 *
 * Every review-and-reputation SaaS is a spam cannon with a nice dashboard on
 * it, and the cheapest way to fire one is a throwaway signup: create an
 * account, paste two thousand addresses into a review-request campaign, send,
 * abandon. Nothing before this stopped that — sign-up needed an address that
 * *parsed*, not one that existed. The cost of a single such run is not ours to
 * absorb either: it lands on the sending domain's reputation, which is shared
 * by every customer's password resets and weekly digests.
 *
 * Requiring verification at the *door* would also stop it, and is the usual
 * answer. It is refused here deliberately — see `emailVerification` in
 * `src/auth/config.ts`. The product's stated target is ten minutes from signup
 * to something worth having, and a wall spends the first of those on a round
 * trip to a mail client that may be on another device. So the wall is moved to
 * where the risk actually is. Connecting a source, reading the sample
 * workspace, running analysis, replying inside the product, inviting nobody:
 * all open. The three things that put mail in a stranger's inbox: gated.
 *
 * ## Why this is a module and not four `if`s
 *
 * It is the same argument `src/compliance/gate.ts` makes about consent, and the
 * same shape: **one function decides, every send path asks it, and a refusal is
 * a named reason rather than a silent drop.** A per-feature check is a rule
 * that holds until somebody adds a fifth send path and does not know the rule
 * exists. `tests/lib/verification-gate.test.ts` enumerates the send paths from
 * disk and fails when one arrives without asking.
 *
 * It is deliberately *not* folded into `checkSendAllowed`. That gate answers a
 * question about the **recipient** — has this person agreed to hear from this
 * business — and it is keyed on a `contactId`. This one asks about the
 * **sender**, has no contact in hand, and must also cover team invitations,
 * which reach somebody who is not a contact at all and never pass the consent
 * gate. Two questions, two answers; conflating them would mean a broadcast
 * refused for "no İYS record" when the truth was an unverified founder.
 *
 * ## Reading the user table directly
 *
 * `users` is a BetterAuth table and is not tenant-owned — one person belongs to
 * many organizations — so it carries no `organization_id` and is not reachable
 * through `withTenant`. `getAdminDb` is the same connection
 * `src/auth/active-organization.ts` uses for the same reason, and the query is
 * keyed on the acting user's own id, which the session established.
 *
 * ## Relative imports, and why that matters here
 *
 * `../db/client.ts` rather than `@/db/client`, because `src/broadcasts/
 * pipeline.ts` reaches this module and therefore so does `pnpm worker`. Nothing
 * here may acquire an import that touches a request API. The trap is that
 * `src/auth/session.ts` — one file away, the obvious place to have put this —
 * imports `next/headers` and is for that reason unreachable from the worker;
 * Vitest resolves either perfectly well, and only the worker fails, at startup,
 * in the process nobody is watching.
 */

/** Why a send was refused before it began. One reason, named. */
export class UnverifiedSenderError extends Error {
  /** The address that needs confirming, so the UI can say which one. */
  readonly email: string;

  constructor(email: string) {
    super("Confirm your email address before sending to people outside your team.");
    this.name = "UnverifiedSenderError";
    this.email = email;
  }
}

export type SenderVerification = {
  verified: boolean;
  email: string;
};

/**
 * Has this user proved their address?
 *
 * Read live rather than taken from the session, on the same grounds as the
 * membership re-read in `requireActor`: somebody who verifies in a second tab
 * must be able to press the button again immediately, and a session cookie
 * minted before the click would say no for another thirty days.
 *
 * A user id with no row is reported as unverified rather than throwing. It
 * cannot happen from a live session, and if it somehow does, the safe answer to
 * "may this unknown account send mail to strangers" is no.
 */
export async function senderVerification(userId: string): Promise<SenderVerification> {
  const [row] = await getAdminDb()
    .select({ email: schema.users.email, emailVerified: schema.users.emailVerified })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!row) return { verified: false, email: "" };

  return { verified: row.emailVerified, email: row.email };
}

/**
 * Throws unless the acting user has verified their address. For guarding a
 * send.
 *
 * Shaped exactly like `requireFeature` — assert, throw a typed error, let
 * `toActionResult` turn it into a code the UI can key an action off. The code
 * is `unverified_email`, and the UI's answer to it is a "resend the email"
 * button rather than a shrug, which is the product's stated-refusal voice:
 * a refusal names itself and offers the way out.
 */
export async function requireVerifiedSender(userId: string): Promise<void> {
  const { verified, email } = await senderVerification(userId);
  if (!verified) throw new UnverifiedSenderError(email);
}
