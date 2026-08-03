"use client";

import { Check, Loader2, RotateCcw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { setDigestActionStatusAction } from "@/server/digests";

/**
 * One of the three recommended actions (P1a-T8).
 *
 * The emotional centre of the screen, so it is built as a *task* rather than a
 * paragraph: a number, a sentence you could do today, the evidence behind it,
 * and one click to record that you did it. The design brief asks for "an
 * assistant handing you a plan"; a plan you cannot tick off is a report.
 *
 * A closed action stays visible, struck through rather than removed. Watching
 * the list empty is the reward, and a vanished item leaves the owner wondering
 * whether they imagined it.
 */

export type ActionCardProps = {
  id: string;
  position: number;
  text: string;
  status: "open" | "done" | "dismissed";
  themeSlug: string;
  reviewCount: number;
};

export function ActionCard({
  id,
  position,
  text,
  status,
  themeSlug,
  reviewCount,
}: ActionCardProps) {
  const t = useTranslations("home");
  const [pending, startTransition] = useTransition();

  const closed = status !== "open";

  const set = (next: "open" | "done" | "dismissed") => {
    startTransition(async () => {
      await setDigestActionStatusAction({ actionId: id, status: next });
    });
  };

  return (
    <li
      className={cn(
        "group relative flex gap-4 rounded-xl border bg-card p-5 transition-colors",
        closed && "bg-muted/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums",
          status === "done"
            ? "bg-primary text-primary-foreground"
            : closed
              ? "bg-muted text-muted-foreground"
              : "bg-primary/10 text-primary",
        )}
      >
        {status === "done" ? <Check className="size-4" /> : position}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p
          className={cn(
            "text-sm leading-relaxed text-pretty",
            closed && "text-muted-foreground line-through",
          )}
        >
          {text}
        </p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {/*
            Evidence is a link, not a citation. "Because customers said so" is
            only persuasive if the owner can read what they said in one click.
          */}
          <Link
            href={`/inbox?theme=${encodeURIComponent(themeSlug)}`}
            className="underline-offset-4 hover:underline"
          >
            {t("evidence", { count: reviewCount, theme: themeSlug })}
          </Link>

          {closed ? (
            <span className="rounded bg-muted px-1.5 py-0.5">
              {status === "done" ? t("doneLabel") : t("dismissedLabel")}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        {pending ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
        ) : closed ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto px-2 py-1 text-xs"
            onClick={() => set("open")}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            {t("reopen")}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              className="h-auto px-2.5 py-1 text-xs"
              onClick={() => set("done")}
            >
              <Check className="size-3.5" aria-hidden />
              {t("markDoneShort")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              // Dismissing is a real answer, not a failure — the next digest
              // reads it differently from an action left open.
              className="h-auto px-2 py-1 text-xs text-muted-foreground"
              onClick={() => set("dismissed")}
            >
              <X className="size-3.5" aria-hidden />
              {t("dismiss")}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
