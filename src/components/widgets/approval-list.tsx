"use client";

import { sourceLabel } from "@/connectors/source-label";
import { ListChecks } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic } from "react";
import { CardLink, SectionCard } from "@/components/ds/section-card";
import { Stars } from "@/components/ds/stars";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAction } from "@/components/ui/use-action";
import { approveAllMatchingAction, setDisplayApprovalAction } from "@/server/widgets";

/**
 * Choosing what the showcase says.
 *
 * Two things this screen has to be honest about, because both are easy to get
 * wrong and expensive to discover later:
 *
 *   1. **Approval is global.** The flag lives on the review, so approving one
 *      here approves it for every widget, badge and public page this business
 *      has. The copy says so rather than letting the surrounding builder imply
 *      otherwise.
 *   2. **"Approve all" is a real action with a real scope.** It approves
 *      everything matching *this widget's current filters* — the same set the
 *      list below is drawn from — and the count is stated before it is pressed.
 *      A business with 800 reviews is not going to tick 800 boxes, so this has
 *      to exist; what it must not be is vague about what it covered.
 */
export type Candidate = {
  id: string;
  rating: number | null;
  text: string | null;
  authorName: string | null;
  source: string;
  postedAt: string | null;
  approved: boolean;
};

export function ApprovalList({
  widgetId,
  candidates,
  matching,
  approved,
  canManage,
  moreHref,
}: {
  widgetId: string;
  candidates: Candidate[];
  matching: number;
  approved: number;
  canManage: boolean;
  /** Where "show more" points, or null when everything is already listed. */
  moreHref: string | null;
}) {
  const t = useTranslations("widgets");
  const router = useRouter();
  const { run, pending } = useAction();

  /**
   * The tick moves when you press it, not when the server agrees.
   *
   * `checked` comes from server data, so without this the control sits
   * unchanged through the whole round trip — which reads as a broken checkbox
   * on any connection slower than localhost, and is exactly what a browser test
   * caught here. If the action fails the optimistic value is discarded when the
   * transition ends, so the row snaps back to the truth rather than lying.
   */
  const [shown, applyOptimistic] = useOptimistic(
    candidates,
    (current, update: { ids: string[]; approved: boolean }) =>
      current.map((candidate) =>
        update.ids.includes(candidate.id) ? { ...candidate, approved: update.approved } : candidate,
      ),
  );

  // No success toast on either: the row's own tick is the confirmation, and a
  // toast per approval would bury the screen during a bulk pass (W1.5).
  const setApproval = (reviewIds: string[], next: boolean) => {
    applyOptimistic({ ids: reviewIds, approved: next });
    run(() => setDisplayApprovalAction({ reviewIds, approved: next }), {
      onSuccess: () => router.refresh(),
      // The optimistic tick has to come back off when the server refuses.
      onError: () => router.refresh(),
    });
  };

  const approveAll = () => {
    applyOptimistic({ ids: candidates.map((candidate) => candidate.id), approved: true });
    run(() => approveAllMatchingAction({ widgetId }), {
      onSuccess: () => router.refresh(),
      onError: () => router.refresh(),
    });
  };

  const remaining = matching - approved;

  return (
    <SectionCard
      title={t("approvalTitle")}
      icon={ListChecks}
      meta={t("approvalMeta", { approved, matching })}
      flush
      action={
        canManage && remaining > 0 ? (
          <Button type="button" size="sm" onClick={approveAll} disabled={pending}>
            {t("approveAll", { count: remaining })}
          </Button>
        ) : null
      }
    >
      <p className="px-(--card-px) pb-3 text-meta text-faint">{t("approvalNote")}</p>

      {shown.length === 0 ? (
        <p className="px-(--card-px) pb-(--card-py) text-body text-ink-400">{t("approvalEmpty")}</p>
      ) : (
        <ul className="border-t border-line-soft">
          {shown.map((candidate) => (
            <li
              key={candidate.id}
              className="flex items-start gap-3 border-b border-line-soft px-(--card-px) py-3 last:border-b-0"
            >
              <Checkbox
                id={`approve-${candidate.id}`}
                checked={candidate.approved}
                // Not disabled while a save is in flight: the tick already
                // moved, so freezing the row would only stop somebody
                // correcting a mis-click for as long as the round trip lasts.
                disabled={!canManage}
                onCheckedChange={(next) => setApproval([candidate.id], next === true)}
                className="mt-0.5"
                // The row's text is the label: a checkbox announced as
                // "checkbox, checked" tells a screen-reader user nothing about
                // which review they are about to publish.
                aria-label={t("approveOne", {
                  author: candidate.authorName ?? t("anonymousAuthor"),
                })}
              />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {candidate.rating !== null ? (
                    <Stars
                      rating={candidate.rating}
                      srLabel={t("starLabel", { rating: candidate.rating })}
                    />
                  ) : null}
                  <span className="text-meta text-faint">
                    {candidate.authorName ?? t("anonymousAuthor")}
                    <span aria-hidden> · </span>
                    {sourceLabel(candidate.source)}
                  </span>
                </div>
                {candidate.text ? (
                  <p className="mt-1 line-clamp-2 text-copy text-ink-400">{candidate.text}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {moreHref ? (
        <div className="px-(--card-px) py-3">
          <Link
            href={moreHref}
            className="rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <CardLink>{t("showMore", { count: matching - shown.length })}</CardLink>
          </Link>
        </div>
      ) : null}
    </SectionCard>
  );
}
