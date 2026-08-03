"use client";

import { Check, Loader2, RotateCcw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useTransition } from "react";
import { Badge } from "@/components/ui/badge";
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
  const t = useTranslations("digest");
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
        // Card padding comes from the tokens, not a round number: `p-5` was 20px
        // against the system's 18/16, so these rows sat a hair wider than every
        // other card on the page.
        "group relative flex gap-4 rounded-lg border border-line bg-card px-(--card-px) py-(--card-py) transition-colors",
        closed && "bg-surface-sunken",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-copy font-semibold tabular-nums",
          status === "done"
            ? "bg-primary text-primary-foreground"
            : closed
              ? "bg-surface-sunken text-ink-400"
              : "bg-state-accent-bg text-state-accent-text",
        )}
      >
        {status === "done" ? <Check className="size-4" /> : position}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p
          className={cn(
            "text-body leading-relaxed text-pretty",
            closed && "text-muted-foreground line-through",
          )}
        >
          {text}
        </p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-copy text-muted-foreground">
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
            // `Badge`, not a hand-rolled span on `bg-muted`: the chip styles
            // are already a component with semantic variants, and `positive`
            // says "done" in a colour that is not the interaction indigo.
            <Badge variant={status === "done" ? "positive" : "secondary"}>
              {status === "done" ? t("doneLabel") : t("dismissedLabel")}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        {pending ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
        ) : closed ? (
          // No `h-auto px-2 py-1 text-copy` overrides. `size="sm"` already
          // encodes the control scale (28px tall, 12px type, 9px corners); the
          // overrides collapsed it to a shape that exists nowhere else.
          <Button type="button" variant="ghost" size="sm" onClick={() => set("open")}>
            <RotateCcw aria-hidden />
            {t("reopen")}
          </Button>
        ) : (
          <>
            {/*
              `secondary` — the indigo *wash*, not the solid fill. Three
              saturated indigo pills stacked down the page pulled every eye to
              the buttons rather than to the sentences they act on, and nothing
              else in the product does that: Home has no solid indigo button at
              all, only indigo links and the accent wash. The affirmative
              action still reads as the affirmative one.
            */}
            <Button type="button" variant="secondary" size="sm" onClick={() => set("done")}>
              <Check aria-hidden />
              {t("markDoneShort")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              // Dismissing is a real answer, not a failure — the next digest
              // reads it differently from an action left open.
              className="text-muted-foreground"
              onClick={() => set("dismissed")}
            >
              <X aria-hidden />
              {t("dismiss")}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
