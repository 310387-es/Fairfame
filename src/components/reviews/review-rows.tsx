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
                "relative flex w-full flex-col gap-1 py-2.5 pr-3 pl-4 text-left transition-colors",
                "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:-outline-offset-2 focus-visible:outline-none",
                /*
                  Selected and hover must not be the same colour.

                  They were: `bg-surface-sunken` against `bg-surface-sunken/60`,
                  the same grey at two opacities. On a list you drive with `j`
                  and `k` that makes the selection invisible the moment the
                  pointer is anywhere near it — you cannot tell what you chose
                  from what you are merely over.

                  Selection is now indigo — a wash plus a 2px bar in the gutter,
                  the pattern Front, Superhuman and Linear all settled on — and
                  hover stays grey. The bar is what survives at a glance from
                  across a desk, where a 4% wash does not.
                */
                active ? "bg-surface-selected" : "hover:bg-surface-hover",
              )}
            >
              {active ? (
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 w-[3px] rounded-r-full bg-primary"
                />
              ) : null}

              <div className="flex items-center gap-2">
                {/* Priority as a dot, not a word: it is a scanning cue, and a
                    column of the word "High" is noise the eye has to read.
                    Ringed rather than flat so a 6px mark still reads as
                    deliberate at arm's length. */}
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full ring-3",
                    review.priority === "high"
                      ? "bg-sentiment-negative ring-state-negative-bg"
                      : review.priority === "medium"
                        ? "bg-sentiment-neutral ring-state-rating-bg"
                        : "bg-graphic-faint ring-transparent",
                  )}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-copy",
                    /*
                      Answered rows recede *by their name*, not only by their
                      snippet. Dimming the sentence alone left a column of equally
                      bold names, so the queue still looked full of work after
                      half of it was done — the one thing a triage list must never
                      get wrong.
                    */
                    review.answered ? "font-normal text-ink-500" : "font-semibold text-foreground",
                  )}
                >
                  {review.authorName ?? unnamed}
                </span>
                {review.rating === null ? null : (
                  <Stars rating={review.rating} srLabel={review.ratingLabel ?? ""} size="sm" />
                )}
                <span className="shrink-0 font-mono text-meta text-faint tabular-nums">
                  {review.postedAt}
                </span>
              </div>

              {/*
                **The customer's words, on two lines.**

                They had one line and `truncate`, in a 19rem column: about
                thirty characters, cut mid-word. "Cumartesi akşamı kuyruk çok
                uzundu. Otop…" is not a preview of a review, it is evidence that
                one exists — and in a product whose entire subject is what
                customers said, the sentence is the row. Every inbox worth
                copying (Front, Superhuman, Gmail, Linear's issue list) gives the
                preview two lines and a wider column; the column widens on the
                page, and this is the other half.

                `line-clamp-2` rather than a character budget: the cut lands
                where the text actually runs out of room, which is the only way
                it works in both English and a Turkish string ~30% longer.
              */}
              <p
                className={cn(
                  "line-clamp-2 text-copy",
                  review.answered ? "text-faint" : "text-secondary-foreground",
                )}
              >
                {review.snippet}
              </p>

              {/*
                Overdue as a chip, not as red words at the end of the sentence.

                Inline it sat immediately after the customer's truncated text in
                `--state-negative-text`, so it read as part of what they wrote —
                a review ending in the word "Overdue". A state belongs in a
                container that says it is a state.
              */}
              {review.overdue ? (
                <span className="inline-flex w-fit items-center rounded-sm bg-state-negative-bg px-1.5 py-0.5 text-eyebrow font-semibold text-state-negative-text uppercase">
                  {overdueLabel}
                </span>
              ) : null}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
