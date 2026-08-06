"use client";

import { Check } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { ProviderMark } from "@/components/connections/provider-mark";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/ui/use-action";
import type { RoadmapCard } from "@/connections/facts";
import { requestIntegrationAction } from "@/server/connections";

/**
 * A source we have not built, and the button that records wanting it (W4.2).
 *
 * **It never says "coming soon".** We do not know that, and a date we invent is
 * one we get held to. What the card claims is exactly what is true: we do not
 * read this yet, and pressing tells us you want us to.
 *
 * **The pressed state is optimistic and permanent.** A request is a fact about
 * this organization that cannot be untrue afterwards, so there is nothing to
 * revert to on failure — and `useAction` surfaces a failed press as a toast
 * either way. What must not happen is the button springing back to "Request"
 * while the row exists, which is what a strictly-correct rollback would do to
 * somebody pressing twice on a slow connection.
 */
export function RoadmapSourceCard({ card }: { card: RoadmapCard }) {
  const t = useTranslations("connections");
  const { run, pending } = useAction();
  const [requested, setRequested] = useState(card.requested);

  const request = () => {
    setRequested(true);
    run(() => requestIntegrationAction({ providerKey: card.key }), {
      success: t("requestRecorded", { label: card.label }),
    });
  };

  return (
    <div className="flex items-center gap-3 rounded-md border border-line px-3 py-2.5">
      <ProviderMark provider={card.key} size={24} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-copy font-medium text-foreground">{card.label}</p>
        <p className="text-meta text-faint">{t(`roadmapNote.${card.note}`)}</p>
      </div>

      {requested ? (
        <span className="flex shrink-0 items-center gap-1 text-meta font-medium text-state-accent-text">
          <Check className="size-3.5" aria-hidden />
          {t("requested")}
        </span>
      ) : (
        <Button size="sm" variant="outline" onClick={request} disabled={pending}>
          {t("request")}
        </Button>
      )}
    </div>
  );
}
