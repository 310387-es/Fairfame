"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";

/**
 * One review, in a drawer over the queue.
 *
 * **Why this replaces the third pane.** W4.1 put the detail beside the list,
 * which is the Front/Superhuman shape — and that shape is right for *long*
 * documents, where you need the queue visible for context while reading a body
 * that scrolls. A review is one to three sentences. Measured on a real account:
 * the median is 53 characters.
 *
 * So the pane was reserving roughly 700px to show something read in two
 * seconds, and paying for it out of the column that holds the product's only
 * content — the customer's words got 338px, clamped to two lines. Worse, that
 * is the state you *arrive* in: nothing is selected, so half the screen is a
 * bordered box saying "choose a review".
 *
 * With the detail overlaid, the list takes the full width and the words get
 * about three times the room. The trade is that the queue is dimmed while you
 * read, which is the correct thing to give up: replying is a focused task, and
 * `j`/`k` still move underneath so the drawer follows the selection rather than
 * having to be closed and reopened.
 *
 * **Selection still lives in `?review=`**, which is what makes this possible at
 * all: the content is server-rendered by the page and passed in as children, so
 * the drawer is a shell with no data of its own. Closing navigates rather than
 * setting state, so the URL stays the single source of truth — a refresh, a
 * shared link and the back button all still work.
 */
export function ReviewDrawer({
  open,
  closeHref,
  title,
  closeLabel,
  children,
}: {
  open: boolean;
  /** The list URL without `?review=`, so closing is a navigation. */
  closeHref: string;
  /** The review's own heading — Radix requires an accessible name. */
  title: string;
  closeLabel: string;
  children: ReactNode;
}) {
  const router = useRouter();

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // Only closing is ours to handle; the drawer opens by navigation.
        //
        // `replace`, not `push`: twenty presses of `j` should not bury the page
        // somebody arrived from under twenty history entries — the same reason
        // `ReviewRows` replaces rather than pushes when it moves the selection.
        if (!next) router.replace(closeHref, { scroll: false });
      }}
    >
      <SheetContent
        side="right"
        tone="surface"
        title={title}
        hideTitle
        closeLabel={closeLabel}
        /*
          Wider than the rail this component was built for, and capped so it
          never becomes the whole screen on a large monitor: a reply composer
          past ~40rem is a paragraph stretched into a line nobody can track.
          `max-w-[85vw]` from `SheetContent` still governs a phone, where this
          is effectively full width — which is right, since the queue is not
          beside it there either.
        */
        className="w-[36rem] gap-0 overflow-y-auto"
      >
        {children}
      </SheetContent>
    </Sheet>
  );
}
