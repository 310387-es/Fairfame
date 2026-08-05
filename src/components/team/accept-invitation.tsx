"use client";

import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/ui/use-action";
import { acceptInvitationAction } from "@/server/invitations";

/**
 * The button that turns an invitation into a membership (W1.9).
 *
 * Lands on Home rather than staying put, and refreshes: accepting changes which
 * organization the session is in, so every figure on the page behind this is
 * about somewhere the reader has just left.
 */
export function AcceptInvitation({ invitationId }: { invitationId: string }) {
  const t = useTranslations("team");
  const router = useRouter();
  const { run, pending } = useAction();

  return (
    <Button
      className="w-fit"
      disabled={pending}
      onClick={() =>
        run(() => acceptInvitationAction({ invitationId }), {
          onSuccess: () => {
            router.push("/home");
            router.refresh();
          },
        })
      }
    >
      <Check className="size-4" aria-hidden />
      {pending ? t("inviteAccepting") : t("inviteAccept")}
    </Button>
  );
}
