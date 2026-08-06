"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ReviewStatus } from "@/db/schema";
import type { SlaState } from "@/reviews/workflow";
import { useAction } from "@/components/ui/use-action";
import { assignReviewAction, setReviewStatusAction } from "@/server/triage";

/**
 * Status, assignee and the SLA clock, on one row of the card (P2-T4).
 *
 * Two selects rather than a menu behind a button. Triage is repetitive — a
 * person works down a list changing the same two things — and a control that
 * shows its current value without being opened is one the reader can *scan*,
 * which is what makes a queue of thirty reviews readable at all.
 *
 * Optimistic in the narrow sense: the select shows the new value immediately and
 * puts it back if the server refuses. The server is the authority on whether the
 * change is allowed (`src/inbox/triage.ts`); this only decides how long the
 * screen looks wrong when it is not.
 */

export type AssigneeOption = { userId: string; name: string };

const UNASSIGNED = "unassigned";

export function TriageBar({
  reviewId,
  status,
  assigneeUserId,
  sla,
  dueAt,
  assignees,
  canTriage,
}: {
  reviewId: string;
  status: ReviewStatus;
  assigneeUserId: string | null;
  sla: SlaState;
  /** Already formatted and localised, or null when there is no deadline. */
  dueAt: string | null;
  assignees: AssigneeOption[];
  /** False for a client, whose role may read but not run the queue. */
  canTriage: boolean;
}) {
  const t = useTranslations("inbox");
  const [currentStatus, setCurrentStatus] = useState(status);
  const [currentAssignee, setCurrentAssignee] = useState(assigneeUserId ?? UNASSIGNED);
  const { run, pending } = useAction();

  /**
   * Re-sync when the server sends a different value (W4.1).
   *
   * These two pieces of state exist to make the select feel instant, and they
   * were initialised from the prop and then never looked at it again. That was
   * invisible while this row was the only thing that could change a status —
   * and then `e` (mark done, from the list beside it) and bulk assignment
   * arrived, both of which write and call `router.refresh()`. The server tree
   * re-rendered with `done`, React kept the mounted component's `open`, and the
   * operator got a success toast sitting next to a control still reading
   * "Açık". A screen that contradicts its own confirmation is worse than one
   * that never confirmed.
   *
   * Adjusted during render rather than in an effect: this is React's documented
   * shape for "reset state when a prop changes", it re-renders before anything
   * is painted, and an effect here would be the `useEffect`+`setState` cascade
   * lint already rejected twice in P4-T4.
   */
  const [lastStatus, setLastStatus] = useState(status);
  if (status !== lastStatus) {
    setLastStatus(status);
    setCurrentStatus(status);
  }

  const assigneeProp = assigneeUserId ?? UNASSIGNED;
  const [lastAssignee, setLastAssignee] = useState(assigneeProp);
  if (assigneeProp !== lastAssignee) {
    setLastAssignee(assigneeProp);
    setCurrentAssignee(assigneeProp);
  }

  const changeStatus = (next: ReviewStatus) => {
    const previous = currentStatus;
    setCurrentStatus(next);

    // No success toast: the control the reader just changed already shows the
    // new value, and narrating it back would be noise on every card (W1.5).
    run(() => setReviewStatusAction({ reviewId, status: next }), {
      onError: () => setCurrentStatus(previous),
    });
  };

  const changeAssignee = (next: string) => {
    const previous = currentAssignee;
    setCurrentAssignee(next);

    run(() => assignReviewAction({ reviewId, assigneeUserId: next === UNASSIGNED ? null : next }), {
      onError: () => setCurrentAssignee(previous),
    });
  };

  const statusLabel: Record<ReviewStatus, string> = {
    open: t("statusOpen"),
    in_progress: t("statusInProgress"),
    done: t("statusDone"),
    ignored: t("statusIgnored"),
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
      <Select
        value={currentStatus}
        disabled={!canTriage || pending}
        onValueChange={(next) => changeStatus(next as ReviewStatus)}
      >
        <SelectTrigger aria-label={t("filterStatus")} className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(["open", "in_progress", "done", "ignored"] as const).map((value) => (
            <SelectItem key={value} value={value}>
              {statusLabel[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={currentAssignee}
        disabled={!canTriage || pending}
        onValueChange={changeAssignee}
      >
        <SelectTrigger aria-label={t("assignee")} className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNASSIGNED}>{t("assigneeNobody")}</SelectItem>
          {assignees.map((option) => (
            <SelectItem key={option.userId} value={option.userId}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <SlaBadge state={sla} dueAt={dueAt} />
    </div>
  );
}

/**
 * The deadline, as a word.
 *
 * Colour *and* a word, never colour alone — an overdue item has to still read as
 * overdue in a monochrome screenshot and to someone who cannot tell the two hues
 * apart (docs/15 §Colour). `none` renders nothing: an item that never had a
 * deadline should not be given a badge implying it met one.
 */
function SlaBadge({ state, dueAt }: { state: SlaState; dueAt: string | null }) {
  const t = useTranslations("inbox");

  if (state === "none") return null;

  const variant =
    state === "overdue" || state === "missed"
      ? "negative"
      : state === "met"
        ? "positive"
        : state === "due_soon"
          ? "rating"
          : "secondary";

  const label =
    state === "overdue"
      ? t("slaOverdue")
      : state === "missed"
        ? t("slaMissed")
        : state === "met"
          ? t("slaMet")
          : state === "due_soon"
            ? t("slaDueSoon")
            : t("slaDue", { at: dueAt ?? "" });

  return (
    <Badge variant={variant} title={dueAt ?? undefined}>
      {label}
    </Badge>
  );
}
