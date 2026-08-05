"use client";

import { Send, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/ui/use-action";
import { cancelBroadcastAction, sendBroadcastAction } from "@/server/broadcasts";

/**
 * Sending or cancelling a broadcast (P4-T4).
 *
 * "Send now" runs the same pipeline the sweep does, so pressing this button is
 * how the scheduled path gets exercised in practice rather than only at 3am in
 * a worker nobody watches.
 *
 * The outcome is reported in full: sent, failed, and **refused broken down by
 * the gate's own reason**. "Nothing went out" and "nothing was allowed out" are
 * different problems, and only one of them is something the person reading this
 * can do anything about.
 */
export function BroadcastActions({
  broadcastId,
  canSend,
  canCancel,
}: {
  broadcastId: string;
  canSend: boolean;
  canCancel: boolean;
}) {
  const t = useTranslations("broadcasts");
  const tf = useTranslations("feedback");
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<Record<string, number> | null>(null);
  const { run, pending } = useAction();

  const send = () => {
    setNotice(null);
    setRefusals(null);

    run(() => sendBroadcastAction({ id: broadcastId }), {
      // No `success` string: the outcome below is the message — "2 sent, 3
      // refused" says more than "Sent", and saying both would be two answers
      // to one question.
      onSuccess: (result) => {
        if (!result) return;

        // A half-finished send is a failure the operator has to see, and it
        // arrives on the *ok* path because the broadcast was claimed before it
        // broke (P4-T4). Report it as what it is.
        if (result.abandoned) {
          setNotice(result.abandoned);
          return;
        }

        setNotice(
          t("sendOutcome", {
            sent: result.sent ?? 0,
            refused: result.refused ?? 0,
            failed: result.failed ?? 0,
          }),
        );
        setRefusals(result.refusals ?? null);
        router.refresh();
      },
    });
  };

  const cancel = () => {
    run(() => cancelBroadcastAction({ id: broadcastId }), {
      success: tf("saved"),
      onSuccess: () => {
        router.refresh();
      },
    });
  };

  return (
    <div className="flex flex-col gap-2 pb-(--card-py)">
      <div className="flex flex-wrap items-center gap-2">
        {canSend ? (
          <Button size="sm" onClick={send} disabled={pending}>
            <Send aria-hidden />
            {pending ? t("sending") : t("sendNow")}
          </Button>
        ) : null}

        {canCancel ? (
          <Button size="sm" variant="ghost" onClick={cancel} disabled={pending}>
            <X aria-hidden />
            {t("cancel")}
          </Button>
        ) : null}
      </div>

      {notice ? (
        <p role="status" className="text-copy text-foreground">
          {notice}
        </p>
      ) : null}

      {refusals && Object.keys(refusals).length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {Object.entries(refusals).map(([reason, count]) => (
            <li key={reason} className="text-meta text-faint">
              {REFUSALS.has(reason) ? t(`refusal.${reason}`) : reason} — {count}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The gate's vocabulary. An unknown reason prints as itself, so it is noticed. */
const REFUSALS = new Set([
  "no_consent",
  "opted_out",
  "iys_not_configured",
  "iys_rejected",
  "no_open_session",
  "unknown_contact",
]);
