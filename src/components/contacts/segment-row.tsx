"use client";

import { Plus, Users, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Chip, ChipGroup, chipClassName } from "@/components/ds/chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteSegmentAction, saveSegmentAction } from "@/server/contacts";

/**
 * Segments — saved contact filters (P4-T1).
 *
 * Modelled on the Inbox's saved views, and the chips are ordinary links for the
 * same reason: a segment *is* a URL, so opening one is a navigation and nothing
 * here needs to know what is currently on screen beyond comparing two query
 * strings.
 *
 * The count is the thing that makes a segment worth saving rather than
 * re-typing — "regulars we can message: 214" is a number somebody plans around,
 * and P4-T4 points a campaign at exactly this list.
 */

export type SegmentChip = {
  id: string;
  name: string;
  href: string;
  count: number;
};

export function SegmentRow({
  segments,
  currentQuery,
  canManage,
  canSave,
}: {
  segments: SegmentChip[];
  /** The list's current query string, for comparing against a segment's href. */
  currentQuery: string;
  /** Only an admin may save or delete one — a segment is an audience. */
  canManage: boolean;
  /** False when nothing is filtered: there would be nothing to save. */
  canSave: boolean;
}) {
  const t = useTranslations("contacts");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const activeId = segments.find((segment) => hrefQuery(segment.href) === currentQuery)?.id ?? null;

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await saveSegmentAction({ name, query: currentQuery });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      setOpen(false);
    });
  };

  const remove = (id: string) => {
    setError(null);
    startTransition(async () => {
      const result = await deleteSegmentAction({ id });
      if (!result.ok) setError(result.error);
    });
  };

  if (segments.length === 0 && !(canManage && canSave)) return null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-card px-(--card-px) py-3">
      <ChipGroup label={t("segments")}>
        {segments.map((segment) => (
          <span key={segment.id} className="inline-flex items-center">
            <Chip
              href={segment.href}
              active={segment.id === activeId}
              count={segment.count}
              className={segment.id === activeId && canManage ? "rounded-r-none pr-2" : undefined}
            >
              <Users className="size-3" aria-hidden />
              {segment.name}
            </Chip>

            {/*
              Removal is offered only on the segment you are currently in. A
              delete button beside every chip is a row of ways to lose an
              audience somebody's campaign points at with one mis-tap.
            */}
            {segment.id === activeId && canManage ? (
              <button
                type="button"
                onClick={() => remove(segment.id)}
                disabled={pending}
                aria-label={t("deleteSegment", { name: segment.name })}
                className={`${chipClassName(true)} -ml-px rounded-l-none border-l-white/30 px-2 disabled:opacity-60`}
              >
                <X className="size-3" aria-hidden />
              </button>
            ) : null}
          </span>
        ))}

        {canManage && canSave && !open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={`${chipClassName(false)} border-dashed`}
          >
            <Plus className="size-3" aria-hidden />
            {t("saveSegment")}
          </button>
        ) : null}
      </ChipGroup>

      {open ? (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-48 flex-1 gap-1.5">
              <Label htmlFor="segment-name">{t("segmentName")}</Label>
              <Input
                id="segment-name"
                value={name}
                maxLength={60}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                placeholder={t("segmentPlaceholder")}
              />
            </div>

            <div className="flex items-center gap-2 pb-1">
              <Button size="sm" onClick={save} disabled={pending || name.trim().length === 0}>
                {t("saveSegmentSubmit")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  setError(null);
                }}
                disabled={pending}
              >
                {t("cancel")}
              </Button>
            </div>
          </div>

          <p className="text-meta text-faint">{t("segmentHint")}</p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-copy text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The query part of a segment's href, for comparison against the current one. */
function hrefQuery(href: string): string {
  const index = href.indexOf("?");
  return index === -1 ? "" : href.slice(index + 1);
}
