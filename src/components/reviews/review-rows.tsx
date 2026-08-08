"use client";

import { CornerDownRight } from "lucide-react";
import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ProviderMark } from "@/components/connections/provider-mark";
import { Avatar } from "@/components/ds/avatar";
import { Stars } from "@/components/ds/stars";
import { SelectCheckbox, useSelection } from "@/components/reviews/selection";
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
  /**
   * The checkbox's accessible name, already translated.
   *
   * Precomputed per row rather than passed as a formatter: this is a client
   * component, and **a function cannot cross the RSC boundary** — the exact
   * P3-T4 defect, which this file's `ratingLabel` already exists to avoid.
   */
  selectLabel: string;
  /** Set only where the plan tracks deadlines and this one has slipped. */
  overdue: boolean;
  answered: boolean;
  /** Up to two canonical themes — see the projection in the page. */
  themes: string[];
  /**
   * The reply and its state, or null when none exists. `text: null` means the
   * owner answered on the platform: we have the fact but not the words.
   */
  reply: { text: string | null; state: "draft" | "posted" } | null;
};

export function ReviewRows({
  reviews,
  selectedId,
  unnamed,
  overdueLabel,
  resolvedLabel,
  showSource,
  canSelect,
  replyLabels,
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
  /** Growth+ and member or above; the server enforces the same rule. */
  canSelect: boolean;
  /** "Draft" / "Replied", translated. */
  replyLabels: { draft: string; posted: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const listRef = useRef<HTMLUListElement>(null);
  const { run } = useAction();
  /*
    Read here as well as in `SelectCheckbox`, because the *row* decides whether
    to show a checkbox at all — and "anything is selected" is a property of the
    list, not of one row.
  */
  const { selected } = useSelection();
  const anySelected = selected.size > 0;

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
        const checked = selected.has(review.id);

        /*
          **The background belongs to the row, not to the link.**

          The checkbox has to live outside the anchor (see below), and while the
          anchor carried `hover:` and the selected wash, those stopped at its
          left edge — so every hovered row had an unpainted notch where the
          checkbox sits, and a selected row was highlighted everywhere except
          its own tick-box.

          The `<li>` is the only element spanning both, so it owns the surface,
          the transition and the selected bar. The anchor keeps the focus ring,
          because that should outline what is actually focusable.
        */
        return (
          <li
            key={review.id}
            className={cn(
              "group/row relative flex items-start transition-colors",
              active ? "bg-surface-selected" : "hover:bg-surface-hover",
            )}
          >
            {/*
              **Outside the anchor, deliberately.**

              The whole row is a link, and a checkbox nested inside one is a
              control you cannot tick — the click navigates before it toggles,
              and stopping propagation to prevent that leaves a link whose
              behaviour depends on which pixel you hit. As a sibling it is a
              plain checkbox, and the rest of the row is still a real link that
              middle-clicks and opens in a new tab.

              `pt-4` rather than centring: it lines up with the first line of
              text, which is where the eye is, not with the middle of a
              two-line row.
            */}
            {active ? (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-[3px] rounded-r-full bg-primary"
              />
            ) : null}

            <a
              href={`?review=${review.id}`}
              aria-current={active ? "true" : undefined}
              onClick={(event) => {
                // Let a modified click do what the browser would.
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                select(review.id);
              }}
              /*
                Selected and hover must not be the same colour — they were,
                `bg-surface-sunken` against `bg-surface-sunken/60`, the same
                grey at two opacities. On a list driven by `j`/`k` that makes
                the selection invisible the moment the pointer is near it.

                Both now live on the `<li>` above, which is the only element
                that spans the checkbox as well as the link. Indigo wash plus a
                3px bar in the gutter for selected — the pattern Front,
                Superhuman and Linear all settled on — and grey for hover.
              */
              className={cn(
                "flex min-w-0 flex-1 flex-col gap-1 py-3 pr-4 pl-3 text-left",
                "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:-outline-offset-2 focus-visible:outline-none",
              )}
            >
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

                {/*
                  **The checkbox and the avatar share one slot.**

                  A column of empty tick-boxes down every row is noise on a
                  screen whose job is scanning, and it competes with the avatar
                  for the same role — the thing your eye lands on at the start
                  of a row. Gmail and Linear both solve it the same way: show
                  the identity, swap in the control when the pointer is on the
                  row or the row is already chosen.

                  One grid cell holding both, so the swap costs no layout shift
                  — the text never moves as the pointer crosses a row.

                  **Always shown where there is no pointer.** Hover-reveal is
                  invisible on a touch screen, so below `lg` the checkbox simply
                  stays. It also stays once *anything* is selected: mid-selection
                  the boxes are what you are working with, and having them
                  vanish from every row you are not touching would make a
                  multi-row selection impossible to see.
                */}
                {canSelect ? (
                  <span className="relative mt-0.5 grid size-7 shrink-0 place-items-center">
                    <Avatar
                      name={review.authorName}
                      className={cn(
                        "col-start-1 row-start-1 transition-opacity",
                        checked || anySelected
                          ? "opacity-0"
                          : "opacity-100 group-hover/row:opacity-0 max-lg:opacity-0",
                      )}
                    />
                    <span
                      className={cn(
                        "col-start-1 row-start-1 transition-opacity",
                        checked || anySelected
                          ? "opacity-100"
                          : "opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 max-lg:opacity-100",
                      )}
                    >
                      <SelectCheckbox reviewId={review.id} label={review.selectLabel} />
                    </span>
                  </span>
                ) : (
                  <Avatar name={review.authorName} className="mt-0.5" />
                )}

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

                    {/*
                      What the analysis found. It sat behind a click, which for
                      the feature this product is sold on is the wrong side of
                      one. On the "about" line with the source rather than under
                      the words, because it describes the review rather than
                      continuing it.
                    */}
                    {review.themes.map((theme) => (
                      <span
                        key={theme}
                        className="shrink-0 rounded-sm bg-surface-sunken px-1.5 py-0.5 text-meta text-ink-500"
                      >
                        {theme}
                      </span>
                    ))}
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

                  {/*
                    **The reply, on the row.**

                    The row showed only the customer's turn, so "did we answer,
                    and what did we say" cost a click — on the screen whose
                    whole job is answering. Every tool in the category puts the
                    response under the review (Birdeye, Podium and Trustpilot's
                    console all do), and the inbox shape this row borrowed from
                    does the same thing for a different reason: Gmail, Front and
                    Superhuman preview the *latest* turn in a thread, not the
                    first. I took the shape and not that rule.

                    Answered was carried only by dimming, which cannot be told
                    apart from "low priority" at a glance. It is a line you can
                    read now.

                    **A draft is not a reply.** It is waiting for somebody to
                    approve and post it — the work still outstanding — so it is
                    labelled and tinted apart rather than counted as done.
                  */}
                  {review.reply ? (
                    <p className="flex min-w-0 items-start gap-1.5 text-copy">
                      <CornerDownRight
                        className="mt-0.5 size-3.5 shrink-0 text-graphic-faint"
                        aria-hidden
                      />
                      <span
                        className={cn(
                          "shrink-0 font-semibold",
                          review.reply.state === "draft"
                            ? "text-state-rating-text"
                            : "text-state-positive-text",
                        )}
                      >
                        {review.reply.state === "draft" ? replyLabels.draft : replyLabels.posted}
                      </span>
                      {review.reply.text ? (
                        <span className="min-w-0 truncate text-faint">{review.reply.text}</span>
                      ) : null}
                    </p>
                  ) : null}
                </div>

                {/*
                  State and time, in a column of their own.

                  Fixed width so they align down the list — a date that starts
                  at a different x on every row is a date nobody can scan. The
                  overdue chip sits above it rather than inline with the
                  sentence, where it used to read as part of what the customer
                  wrote.

                  **`sm:` on the fixed width, and that is the whole point.**
                  7.5rem is 120px, which is nothing on a desktop row and 31% of
                  a 390px phone. With the checkbox beside it, a review's text
                  column came out around 150px — "Müzik o kadar yüksekti ki…"
                  clipped mid-word on the second line, which is the exact defect
                  W4.1 removed from this row on the desktop and left standing
                  where it costs most. Below `sm` the column takes only what the
                  date needs; alignment is a luxury of having room, and the
                  customer's words are not.
                */}
                <div className="flex shrink-0 flex-col items-end gap-1.5 sm:w-[7.5rem]">
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
