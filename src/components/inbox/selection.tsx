"use client";

import { useAction } from "@/components/ui/use-action";
import type { ActionResult } from "@/server/action-result";
import { Loader2, Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useContext, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AssigneeOption } from "@/components/inbox/triage-bar";
import {
  bulkAssignAction,
  bulkDraftFromTemplateAction,
  bulkDraftWithAiAction,
  bulkSetStatusAction,
  bulkTagAction,
  bulkUntagAction,
} from "@/server/bulk";

/**
 * Selecting reviews, and acting on the selection (P2-T6).
 *
 * The provider is a client component wrapping *server-rendered* cards — which
 * works, and is why the list did not have to become a client component to gain
 * a checkbox. Each card renders `<SelectCheckbox>`, which is the only client
 * code inside it; everything else about the card is still rendered on the
 * server.
 *
 * The bar itself offers status, assignee, tag, and drafting from a template or
 * with AI. It does **not** offer post or approve, and it never will: see the
 * guardrail in `src/inbox/bulk.ts`. Publishing forty replies is not a bulk
 * operation, it is forty decisions.
 */

type SelectionState = {
  selected: Set<string>;
  toggle: (id: string) => void;
  clear: () => void;
};

const SelectionContext = createContext<SelectionState | null>(null);

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const value = useMemo<SelectionState>(
    () => ({
      selected,
      toggle: (id) =>
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
      clear: () => setSelected(new Set()),
    }),
    [selected],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

function useSelection(): SelectionState {
  const value = useContext(SelectionContext);
  if (!value) throw new Error("Selection controls must be rendered inside a SelectionProvider.");
  return value;
}

export function SelectCheckbox({ reviewId, label }: { reviewId: string; label: string }) {
  const { selected, toggle } = useSelection();

  return (
    <Checkbox
      checked={selected.has(reviewId)}
      onCheckedChange={() => toggle(reviewId)}
      aria-label={label}
    />
  );
}

export type BulkTemplateOption = { id: string; name: string; language: string };

/**
 * The action bar, shown only when something is selected.
 *
 * Sticky at the bottom rather than at the top of the list: on a phone the
 * selection is made by thumbing down through cards, and a bar at the top would
 * be off-screen by the time there is anything to do with it.
 */
export function BulkBar({
  assignees,
  templates,
  canUseAi,
}: {
  assignees: AssigneeOption[];
  templates: BulkTemplateOption[];
  canUseAi: boolean;
}) {
  const t = useTranslations("inbox");
  const { selected, clear } = useSelection();
  const [tag, setTag] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const { run: runAction, pending } = useAction();

  const reviewIds = [...selected];
  if (reviewIds.length === 0) return null;

  /**
   * Every bulk control goes through here (W1.5).
   *
   * No `success` string: the bar's own message says how many rows actually
   * changed, and "Saved" beside "40 updated" would be two answers to one
   * question. A *failure* still toasts, which is the half that was missing.
   */
  const run = (action: () => Promise<ActionResult<{ changed?: number }>>) => {
    setMessage(null);

    runAction(action, {
      onSuccess: (result) => {
        // The count is what actually changed, not what was selected — a bar
        // that says "40 updated" after skipping nine is a bar nobody can trust.
        setMessage(t("bulkDone", { count: result?.changed ?? 0 }));
        clear();
      },
    });
  };

  return (
    <div className="sticky bottom-3 z-20 flex flex-col gap-2 rounded-lg border border-line bg-card p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-copy font-semibold">
          {t("bulkSelected", { count: reviewIds.length })}
        </span>

        <Select
          disabled={pending}
          value=""
          onValueChange={(status) => run(() => bulkSetStatusAction({ reviewIds, status }))}
        >
          <SelectTrigger className="w-36" aria-label={t("filterStatus")}>
            <SelectValue placeholder={t("filterStatus")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">{t("statusOpen")}</SelectItem>
            <SelectItem value="in_progress">{t("statusInProgress")}</SelectItem>
            <SelectItem value="done">{t("statusDone")}</SelectItem>
            <SelectItem value="ignored">{t("statusIgnored")}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          disabled={pending}
          value=""
          onValueChange={(userId) =>
            run(() =>
              bulkAssignAction({
                reviewIds,
                assigneeUserId: userId === "unassigned" ? null : userId,
              }),
            )
          }
        >
          <SelectTrigger className="w-44" aria-label={t("assignee")}>
            <SelectValue placeholder={t("assignee")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unassigned">{t("assigneeNobody")}</SelectItem>
            {assignees.map((option) => (
              <SelectItem key={option.userId} value={option.userId}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {templates.length > 0 ? (
          <Select
            disabled={pending}
            value=""
            onValueChange={(templateId) =>
              run(() => bulkDraftFromTemplateAction({ reviewIds, templateId }))
            }
          >
            <SelectTrigger className="w-44" aria-label={t("bulkTemplate")}>
              <SelectValue placeholder={t("bulkTemplate")} />
            </SelectTrigger>
            <SelectContent>
              {templates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {canUseAi ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => run(() => bulkDraftWithAiAction({ reviewIds }))}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="size-4" aria-hidden />
            )}
            {t("bulkDraftAi")}
          </Button>
        ) : null}

        <div className="flex items-center gap-1.5">
          <Input
            value={tag}
            disabled={pending}
            maxLength={48}
            placeholder={t("bulkTagPlaceholder")}
            aria-label={t("bulkTag")}
            className="h-8 w-36"
            onChange={(event) => setTag(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={pending || tag.trim().length === 0}
            onClick={() =>
              run(async () => {
                const result = await bulkTagAction({ reviewIds, slug: tag.trim() });
                if (result.ok) setTag("");
                return result;
              })
            }
          >
            {t("bulkTag")}
          </Button>

          {/* Paired with tagging rather than hidden behind a menu: the whole
              point is that a tag applied to forty reviews by mistake can be
              taken off the same forty without hunting for the undo. */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending || tag.trim().length === 0}
            onClick={() =>
              run(async () => {
                const result = await bulkUntagAction({ reviewIds, slug: tag.trim() });
                if (result.ok) setTag("");
                return result;
              })
            }
          >
            {t("bulkUntag")}
          </Button>
        </div>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={pending}
          onClick={clear}
        >
          <X className="size-4" aria-hidden />
          {t("bulkClear")}
        </Button>
      </div>

      {/*
        Drafting in bulk writes drafts and nothing else. Said out loud, because
        the difference between "40 replies drafted" and "40 replies sent" is the
        entire reason this bar has no post button.
      */}
      <p className="text-meta text-faint">{t("bulkDraftNote")}</p>

      {message ? (
        <p role="status" className="text-copy text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
