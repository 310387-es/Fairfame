"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Stars } from "@/components/ds/stars";
import { useAction } from "@/components/ui/use-action";
import { setReviewStatusAction } from "@/server/triage";
import { cn } from "@/lib/utils";

/**
 * The dense left column of the two-pane inbox (W4.1).
 *
 * **What this replaces.** Every review was a full-width card carrying its own
 * stars, chips, triage controls and reply box, stacked vertically. Twenty
 * reviews was a page you scrolled for a minute to see what was waiting, and on
 * a phone the whole thing came to 25,000 pixels. Triage is a scanning job — you
 * are looking for the one that needs you — and a list you cannot scan is not a
 * queue, it is an archive.
 *
 * So: one line per review, everything needed to *decide* and nothing needed to
 * *act*. Acting happens in the pane beside it.
 *
 * **Selection lives in the URL** (`?review=`), which is what makes this work
 * without a client-side store: the detail beside it is server-rendered from the
 * same parameter, the state survives a refresh, and a row is a real link — so
 * middle-click opens a review in a new tab and a screen reader announces it as
 * a link rather than as a div somebody attached a handler to.
 *
 * **Keyboard is the point of the rebuild.** `j`/`k` move, and they move by
 * *pushing a URL*, so nothing can drift out of step with what is displayed.
 * `replace` rather than `push` so twenty presses of `j` do not bury the page
 * somebody arrived from under twenty history entries.
 */

export type ReviewRow = {
  id: string;
  authorName: string | null;
  rating: number | null;
  /** "2 out of 5 stars", already translated — the row is a link, so it is read. */
  ratingLabel: string | null;
  snippet: string | null;
  postedAt: string;
  sourceLabel: string;
  /** Derived triage priority — the dot's colour. */
  priority: "high" | "medium" | "low";
  /** Set only where the plan tracks deadlines and this one has slipped. */
  overdue: boolean;
  answered: boolean;
};

export function ReviewRows({
  reviews,
  selectedId,
  unnamed,
  overdueLabel,
  resolvedLabel,
}: {
  reviews: ReviewRow[];
  selectedId: string | null;
  unnamed: string;
  overdueLabel: string;
  /** Confirmation for `e`, which has no visible control to press. */
  resolvedLabel: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const listRef = useRef<HTMLUListElement>(null);
  const { run } = useAction();

  const select = (id: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("review", id);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      /**
       * Never while somebody is typing. A reply composer is one tab away, and
       * a shortcut that fired inside it would move the selection out from under
       * a half-written reply — losing work to a keystroke that felt like typing.
       */
      const target = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      ) {
        return;
      }

      /**
       * `r` — start replying to the selected review.
       *
       * It reaches into the detail pane through a data attribute rather than
       * through shared state, and that is deliberate: the composer is a
       * self-contained client component with its own draft, and lifting its
       * "am I open" flag up here so a keystroke could set it would put a
       * half-written reply's lifetime in a component that knows nothing about
       * drafts. Focusing the editor if it is open, and pressing the button that
       * opens it if it is not, is what a person would do.
       */
      if (event.key === "r") {
        if (!selectedId) return;
        const editor = document.querySelector<HTMLTextAreaElement>("[data-reply-editor]");
        const start = document.querySelector<HTMLButtonElement>("[data-reply-start]");
        if (!editor && !start) return;

        event.preventDefault();
        if (editor) editor.focus();
        else start?.click();
        return;
      }

      /**
       * `e` — mark it done, the way an inbox marks mail read.
       *
       * Through the same action the status control calls, so one rule decides
       * who may do it and the server enforces it either way. `router.refresh()`
       * rather than optimistic state: the row's priority, its SLA chip and the
       * facet counts above all move when a status does, and re-deriving those
       * in the browser is three more places for them to disagree with the
       * database.
       */
      if (event.key === "e") {
        if (!selectedId) return;
        event.preventDefault();
        void run(() => setReviewStatusAction({ reviewId: selectedId, status: "done" }), {
          success: resolvedLabel,
          onSuccess: () => router.refresh(),
        });
        return;
      }

      if (event.key !== "j" && event.key !== "k") return;

      const index = reviews.findIndex((review) => review.id === selectedId);
      // Nothing selected yet: `j` starts at the top rather than doing nothing.
      const next = index === -1 ? 0 : index + (event.key === "j" ? 1 : -1);
      const target_ = reviews[next];
      if (!target_) return;

      event.preventDefault();
      select(target_.id);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Keep the selected row in view when the keyboard moved it, not when a click
  // did — a click was already on screen, and scrolling it would be a jolt.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <ul ref={listRef} className="flex flex-col divide-y divide-line">
      {reviews.map((review) => {
        const active = review.id === selectedId;

        return (
          <li key={review.id}>
            <a
              href={`?review=${review.id}`}
              aria-current={active ? "true" : undefined}
              onClick={(event) => {
                // Let a modified click do what the browser would.
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                select(review.id);
              }}
              className={cn(
                "flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors",
                "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                active ? "bg-surface-sunken" : "hover:bg-surface-sunken/60",
              )}
            >
              <div className="flex items-center gap-2">
                {/* Priority as a dot, not a word: it is a scanning cue, and a
                    column of the word "High" is noise the eye has to read. */}
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    review.priority === "high"
                      ? "bg-sentiment-negative"
                      : review.priority === "medium"
                        ? "bg-sentiment-neutral"
                        : "bg-graphic-faint",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-copy font-medium text-foreground">
                  {review.authorName ?? unnamed}
                </span>
                {review.rating === null ? null : (
                  <Stars rating={review.rating} srLabel={review.ratingLabel ?? ""} />
                )}
                <span className="shrink-0 text-meta text-faint">{review.postedAt}</span>
              </div>

              {/*
                Two lines, ~56px, and the second one is **the review**.

                The source label was here first and had to go: "Google Business
                Profile" is thirty characters that are the same on every row of
                a business with one source, and it pushed the customer's actual
                words off the end. The plan asks for a source *glyph* — real
                provider logos land in W4.2, and this line gets one back then.
                Until then the detail pane names the source and the filter bar
                above shows the mix, so nothing is lost but repetition.
              */}
              <div className="flex items-center gap-1.5">
                <p
                  className={cn(
                    "min-w-0 flex-1 truncate text-copy",
                    review.answered ? "text-faint" : "text-muted-foreground",
                  )}
                >
                  {review.snippet}
                </p>
                {review.overdue ? (
                  <span className="shrink-0 text-meta text-state-negative-text">
                    {overdueLabel}
                  </span>
                ) : null}
              </div>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
