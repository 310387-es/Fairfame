"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ProviderMark } from "@/components/connections/provider-mark";
import { Avatar } from "@/components/ds/avatar";
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
  /** The provider key, for its mark. */
  source: string;
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
  showSource,
}: {
  reviews: ReviewRow[];
  selectedId: string | null;
  unnamed: string;
  overdueLabel: string;
  /**
   * Only where there is more than one source to tell apart.
   *
   * W4.1 removed the source label because "Google Business Profile" is thirty
   * identical characters on every row of a single-source business. Widening the
   * column answered the *space* half of that and not the repetition half: a
   * label that reads the same all the way down is noise however much room it
   * has. So it comes back conditionally — which is what the original decision
   * should have been.
   */
  showSource: boolean;
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
                "relative flex w-full flex-col gap-1 py-3 pr-4 pl-3 text-left transition-colors",
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

              {/*
                **Three zones, not one line of floating text.**

                The row was designed for a 23rem column and then stretched to
                64rem when the detail became a drawer. A short sentence in a
                1000px line with a void in the middle is what that looks like,
                and no amount of type tuning fixes it: the row needed *columns*.

                  [avatar] name · rating · source        [state]  date
                           the customer's words

                The avatar is the scanning anchor a list of names needs — it is
                the same monogram the activity feed and the user menu draw, and
                its colour is a hash of the name, so one customer is one circle
                everywhere. The metadata goes right, in its own column, so the
                eye runs *down* it instead of across each row hunting for the
                date.
              */}
              <div className="flex min-w-0 items-start gap-3">
                {/* Priority as a dot, not a word: it is a scanning cue, and a
                    column of the word "High" is noise the eye has to read. It
                    keeps its own narrow gutter to the left of the avatar, so
                    the marks line up down the list. */}
                <span
                  aria-hidden
                  className={cn(
                    "mt-3 size-1.5 shrink-0 rounded-full",
                    review.priority === "high"
                      ? "bg-sentiment-negative"
                      : review.priority === "medium"
                        ? "bg-sentiment-neutral"
                        : "bg-transparent",
                  )}
                />

                <Avatar name={review.authorName} className="mt-0.5" />

                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span
                      className={cn(
                        "min-w-0 truncate text-copy",
                        /*
                          Answered rows recede *by their name*, not only by their
                          snippet. Dimming the sentence alone left a column of
                          equally bold names, so the queue still looked full of
                          work after half of it was done — the one thing a triage
                          list must never get wrong.
                        */
                        review.answered
                          ? "font-normal text-ink-500"
                          : "font-semibold text-foreground",
                      )}
                    >
                      {review.authorName ?? unnamed}
                    </span>

                    {review.rating === null ? null : (
                      <Stars rating={review.rating} srLabel={review.ratingLabel ?? ""} size="sm" />
                    )}

                    {/*
                      A **mark**, not the name.

                      W4.1 removed "Google Business Profile" as thirty identical
                      characters on every row and said the answer was a source
                      glyph once real provider marks existed. They landed in
                      W4.2 (`provider-mark.tsx`, drawn geometry rather than
                      traced trademarks) and this row went on printing the
                      words. A 14px mark is scannable where a repeated
                      thirty-character label is only noise, and it costs the
                      line almost nothing.

                      The name still reaches assistive technology, which never
                      saw the glyph.
                    */}
                    {showSource ? (
                      <span
                        className="inline-flex shrink-0 items-center"
                        title={review.sourceLabel}
                      >
                        <ProviderMark provider={review.source} size={14} />
                        <span className="sr-only">{review.sourceLabel}</span>
                      </span>
                    ) : null}
                  </div>

                  {/*
                    **The customer's words, and they lead.**

                    `text-lead` — the 15px role added for exactly this, "a
                    sentence that *is* the subject of its row", and until now
                    defined and unused. The name above it is 13px: in a product
                    whose whole subject is what customers said, the sentence
                    should be the largest thing in the row, not a caption under
                    the person's name.

                    `line-clamp-2` rather than a character budget: the cut lands
                    where the text runs out of room, which is the only version
                    that works in English and in a Turkish string ~30% longer.
                  */}
                  <p
                    className={cn(
                      "line-clamp-2 text-lead text-pretty",
                      review.answered ? "text-ink-500" : "text-foreground",
                    )}
                  >
                    {review.snippet}
                  </p>
                </div>

                {/*
                  State and time, in a column of their own.

                  Fixed width so they align down the list — a date that starts
                  at a different x on every row is a date nobody can scan. The
                  overdue chip sits above it rather than inline with the
                  sentence, where it used to read as part of what the customer
                  wrote.
                */}
                <div className="flex w-[7.5rem] shrink-0 flex-col items-end gap-1.5">
                  <span className="font-mono text-meta text-faint tabular-nums">
                    {review.postedAt}
                  </span>
                  {review.overdue ? (
                    <span className="inline-flex items-center rounded-sm bg-state-negative-bg px-1.5 py-0.5 text-eyebrow font-semibold text-state-negative-text uppercase">
                      {overdueLabel}
                    </span>
                  ) : null}
                </div>
              </div>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
