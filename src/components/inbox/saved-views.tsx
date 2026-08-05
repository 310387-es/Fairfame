"use client";

import { Bookmark, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Chip, ChipGroup, chipClassName } from "@/components/ds/chip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSavedViewAction, deleteSavedViewAction } from "@/server/saved-views";

/**
 * Saved views (P2-T3).
 *
 * A named filter combination, kept per person or shared with the team. The chips
 * are ordinary links — a saved view *is* a URL, so opening one is a navigation
 * and nothing here needs to know what the Inbox is currently showing beyond
 * comparing two query strings.
 *
 * The only client state is the little save form. It is a client component rather
 * than a server-rendered form because the thing being saved is "what I am
 * looking at right now", which the browser knows and a form post would have to
 * be told.
 */

export type SavedViewChip = {
  id: string;
  name: string;
  shared: boolean;
  href: string;
};

export function SavedViews({
  views,
  currentParams,
  currentQuery,
  canShare,
  canSave,
}: {
  views: SavedViewChip[];
  /** The Inbox's current query string, as the action wants it. */
  currentParams: Record<string, string>;
  /** The same thing, serialized — for comparing against a view's href. */
  currentQuery: string;
  /** Only an admin may save a view for the whole team. */
  canShare: boolean;
  /** False when nothing is filtered: there would be nothing to save. */
  canSave: boolean;
}) {
  const t = useTranslations("inbox");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const activeId = views.find((view) => hrefQuery(view.href) === currentQuery)?.id ?? null;

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await createSavedViewAction({ name, shared, params: currentParams });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      setShared(false);
      setOpen(false);
    });
  };

  const remove = (id: string) => {
    setError(null);
    startTransition(async () => {
      const result = await deleteSavedViewAction({ id });
      if (!result.ok) setError(result.error);
    });
  };

  if (views.length === 0 && !canSave) return null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-card px-(--card-px) py-3">
      <ChipGroup label={t("savedViews")}>
        {views.map((view) => (
          <span key={view.id} className="inline-flex items-center">
            <Chip
              href={view.href}
              active={view.id === activeId}
              className={view.id === activeId ? "rounded-r-none pr-2" : undefined}
            >
              <Bookmark className="size-3" aria-hidden />
              {view.name}
              {view.shared ? (
                <span className="text-[10px] uppercase opacity-70">{t("viewShared")}</span>
              ) : null}
            </Chip>

            {/*
              Removal is offered only on the view you are currently in. A row of
              delete buttons beside every chip is a row of ways to lose a
              teammate's saved queue with one mis-tap, and the one you are
              looking at is the one you have decided about.
            */}
            {view.id === activeId ? (
              <button
                type="button"
                onClick={() => remove(view.id)}
                disabled={pending}
                aria-label={t("deleteView", { name: view.name })}
                className={`${chipClassName(true)} -ml-px rounded-l-none border-l-white/30 px-2 disabled:opacity-60`}
              >
                <X className="size-3" aria-hidden />
              </button>
            ) : null}
          </span>
        ))}

        {canSave && !open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={`${chipClassName(false)} border-dashed`}
          >
            <Plus className="size-3" aria-hidden />
            {t("saveView")}
          </button>
        ) : null}
      </ChipGroup>

      {open ? (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-48 flex-1 gap-1.5">
              <Label htmlFor="saved-view-name">{t("saveViewName")}</Label>
              <Input
                id="saved-view-name"
                value={name}
                maxLength={60}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                placeholder={t("saveViewPlaceholder")}
              />
            </div>

            {canShare ? (
              <div className="flex items-center gap-2 pb-2">
                <Checkbox
                  id="saved-view-shared"
                  checked={shared}
                  onCheckedChange={(next) => setShared(next === true)}
                />
                <Label htmlFor="saved-view-shared">{t("saveViewShared")}</Label>
              </div>
            ) : null}

            <div className="flex items-center gap-2 pb-1">
              <Button size="sm" onClick={save} disabled={pending || name.trim().length === 0}>
                {t("saveViewSubmit")}
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

          <p className="text-meta text-faint">{t("saveViewHint")}</p>
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

/** The query part of a view's href, for comparison against the current one. */
function hrefQuery(href: string): string {
  const index = href.indexOf("?");
  return index === -1 ? "" : href.slice(index + 1);
}
