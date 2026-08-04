"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ReviewStatus } from "@/db/schema";
import type { SlaState } from "@/inbox/workflow";
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
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const changeStatus = (next: ReviewStatus) => {
    const previous = currentStatus;
    setCurrentStatus(next);
    setError(null);

    startTransition(async () => {
      const result = await setReviewStatusAction({ reviewId, status: next });
      if (!result.ok) {
        setCurrentStatus(previous);
        setError(result.error);
      }
    });
  };

  const changeAssignee = (next: string) => {
    const previous = currentAssignee;
    setCurrentAssignee(next);
    setError(null);

    startTransition(async () => {
      const result = await assignReviewAction({
        reviewId,
        assigneeUserId: next === UNASSIGNED ? null : next,
      });
      if (!result.ok) {
        setCurrentAssignee(previous);
        setError(result.error);
      }
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

      {error ? (
        <span role="alert" className="text-copy text-destructive">
          {error}
        </span>
      ) : null}
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
