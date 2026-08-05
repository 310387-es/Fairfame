import { and, eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { getSession } from "@/auth/session";
import { AcceptInvitation } from "@/components/team/accept-invitation";
import { Card, CardContent } from "@/components/ui/card";
import { getAdminDb, schema } from "@/db/client";

/**
 * Where an invitation link lands (W1.9).
 *
 * **In `(auth)`, not `(app)`, and that is not a style choice.** The app shell's
 * layout guards every route beneath it, and an unauthenticated visitor is sent
 * to `/sign-in` with no memory of where they were going — so an invitation
 * link, followed by somebody who does not yet have an account, dropped them on
 * Home with the invitation lost. The guard runs before the page, so the page
 * could not fix it. A layout cannot see its child's pathname in the App Router,
 * so the answer is to live outside it and carry the destination ourselves.
 *
 * It is also the right home on its own terms: the recipient may have no
 * account, no organization and no idea what this product is, which is exactly
 * the audience `(auth)` is laid out for.
 *
 * **The lookup is deliberately not the accept.** This page reads the invitation
 * to *show* who is asking and for what role — an unauthenticated-shaped read on
 * a signed-in page — and `acceptInvitationAction` does the accepting through
 * BetterAuth, which is what checks the invitation actually belongs to this
 * person's email. Two responsibilities, and only one of them is a security
 * decision.
 *
 * `adminDb` for the read, because by definition the reader is not yet in this
 * organization and RLS would show them nothing. The projection is three fields
 * and no tenant data: an organization's name, a role, and an expiry.
 */
export default async function InvitePage({ params }: { params: Promise<{ id: string }> }) {
  const [t, session, { id }] = await Promise.all([getTranslations("team"), getSession(), params]);

  // Not signed in: send them to sign-in with a way back. `/sign-up` is one
  // click from there, which is the more common case for a new teammate.
  if (!session) redirect(`/sign-in?next=${encodeURIComponent(`/invite/${id}`)}`);

  const [invitation] = await getAdminDb()
    .select({
      id: schema.invitations.id,
      email: schema.invitations.email,
      role: schema.invitations.role,
      status: schema.invitations.status,
      expiresAt: schema.invitations.expiresAt,
      organizationName: schema.organizations.name,
    })
    .from(schema.invitations)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.invitations.organizationId))
    .where(and(eq(schema.invitations.id, id)))
    .limit(1);

  const usable =
    invitation !== undefined &&
    invitation.status === "pending" &&
    invitation.expiresAt > new Date() &&
    // Addressed to *this* person. BetterAuth checks it again on accept — this
    // only decides whether to show a button that would be refused.
    invitation.email.toLowerCase() === session.user.email.toLowerCase();

  return (
    <Card>
      <div className="px-(--card-px)">
        <h1 className="text-display text-balance">
          {usable ? invitation.organizationName : t("inviteInvalid")}
        </h1>
        <p className="mt-1 text-body text-pretty text-ink-400">
          {usable
            ? t("inviteBody", { role: t(`roles.${invitation.role}`) })
            : /* One message for expired, withdrawn, already-used and
                 addressed-to-somebody-else. Telling a stranger *which* would
                 confirm that an invitation exists for an address they typed. */
              t("inviteInvalidBody")}
        </p>
      </div>

      {usable ? (
        <CardContent>
          <AcceptInvitation invitationId={invitation.id} />
        </CardContent>
      ) : null}
    </Card>
  );
}
