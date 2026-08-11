"use client";

import { Loader2, MailWarning, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useAction } from "@/components/ui/use-action";
import { resendVerificationEmailAction } from "@/server/verification";

/**
 * "Confirm your email address" (P5-T4).
 *
 * ## Why a banner, and not only a toast on the refusal
 *
 * The refusal itself already speaks — `requireVerifiedSender` throws a named
 * reason and `useAction` toasts it at whichever send was attempted. That is
 * necessary and not sufficient: a toast fires *after* somebody has composed a
 * campaign, chosen an audience and pressed send, which is the worst possible
 * moment to learn about a precondition. The banner says it beforehand, on every
 * screen, in the same slot the sample-workspace banner uses and for the same
 * reason — a state that changes what the product will do has to be visible from
 * wherever you are when you run into it.
 *
 * ## Why it names what is blocked
 *
 * "Verify your email" with no consequence attached is an instruction without a
 * reason, and it gets ignored. This one lists the three things that wait —
 * review invitations, broadcasts, team invitations — and, by omission, says
 * that everything else works. Somebody who has no intention of sending anything
 * this week can read it and correctly do nothing, which is the honest outcome
 * and the one that keeps the banner credible for the people it does concern.
 *
 * ## Not dismissible
 *
 * Deliberately, and it is the one thing here worth arguing about. A dismissed
 * banner would come back on the next page load (there is no state to remember
 * it) or would need one — and a banner you can permanently hide is one somebody
 * hides in week one and rediscovers in week six, mid-campaign, via a toast. The
 * way to remove it is to press the button in it, which takes one click and
 * about forty seconds.
 */
export function VerifyEmailBanner() {
  const t = useTranslations("auth");
  const { toast } = useToast();
  const { run, pending } = useAction();

  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-line bg-surface-sunken px-3.5 py-2.5">
      <MailWarning className="size-4 shrink-0 text-ink-400" aria-hidden />
      <p className="text-copy text-pretty text-ink-600">
        <span className="font-medium">{t("verifyBannerTitle")}</span> {t("verifyBannerBody")}
      </p>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="ml-auto"
        disabled={pending}
        onClick={() =>
          run(() => resendVerificationEmailAction(), {
            /**
             * Two different successes, and they are not the same news — which
             * is why the outcome is announced from here rather than through
             * `success`, whose string is fixed at the call.
             *
             * The ordinary one is "sent, go and look". The other is that the
             * address was already confirmed, which happens when somebody
             * verifies in a second tab and comes back to this one. Saying an
             * email is on its way would be a lie about a message the server
             * deliberately did not send — and the honest answer is also the
             * more useful one, because it tells them to reload.
             *
             * Failures still report through `useAction`, unchanged.
             */
            onSuccess: (result) =>
              toast("success", result?.alreadyVerified ? t("verifyAlready") : t("verifyResent")),
          })
        }
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Send className="size-4" aria-hidden />
        )}
        {t("verifyResend")}
      </Button>
    </div>
  );
}
