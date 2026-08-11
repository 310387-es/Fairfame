"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A centred modal.
 *
 * Radix `Dialog` underneath, for the reasons `sheet.tsx` gives about itself:
 * focus moves into the panel and is trapped, Escape closes it, the page behind
 * goes inert and is hidden from assistive technology, and scroll is locked.
 * Hand-rolling those is how a modal ends up visible but unusable.
 *
 * **Why this exists next to `Sheet`, which is also a Radix Dialog.** A sheet is
 * a panel pinned to an edge, written for the mobile navigation rail and sized
 * to `--rail-width`. That is the right shape for navigation and for a create
 * form; it is the wrong one for a *document*, which wants a comfortable measure
 * and to sit over the page rather than beside it. The two share a primitive and
 * answer different questions, so they are separate components rather than a
 * fourth `side` value on the sheet.
 *
 * **Design.** `docs/15` §4: this genuinely floats, so it takes `--elevation-md`
 * (`shadow-md`) like the other floating surfaces; 14px corners because it is a
 * block; the same `--ink-900/45` scrim as the sheet, so the product has one
 * idea of what "behind a modal" looks like.
 *
 * The body scrolls, not the page. A long document in a modal that grows past
 * the viewport takes its close button off-screen with it, which is the one
 * thing a modal must never do.
 */

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/**
 * `title` is required rather than optional, exactly as on `SheetContent`: Radix
 * warns when a dialog has no accessible name, and a nameless one is announced
 * as just "dialog". `description` is optional but strongly encouraged — without
 * it Radix warns too, and a document modal has an obvious one.
 */
function DialogContent({
  className,
  children,
  title,
  description,
  closeLabel,
  footer,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  title: string;
  description?: string;
  closeLabel: string;
  /** Pinned below the scrolling body — a link out, an action, a caveat. */
  footer?: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-ink-900/45 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // Centred by translate rather than by flex, so the panel does not
          // reflow while the open animation is running — the "element is not
          // stable" problem `sheet.tsx` records.
          "fixed top-1/2 left-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col",
          "max-h-[min(85vh,44rem)] overflow-hidden rounded-lg border border-line bg-card text-foreground shadow-md",
          "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
          "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-(--card-px) py-4 [--card-px:18px]">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-title text-balance">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-copy text-pretty text-ink-400">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>

          <DialogPrimitive.Close
            aria-label={closeLabel}
            className="-mt-1 -mr-1.5 grid size-8 shrink-0 place-items-center rounded-md text-ink-400 transition-colors hover:bg-surface-sunken hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <XIcon className="size-4" aria-hidden />
          </DialogPrimitive.Close>
        </div>

        {/* The body scrolls; the header and footer stay put. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-(--card-px) py-4 [--card-px:18px]">
          {children}
        </div>

        {footer ? (
          <div className="shrink-0 border-t border-line px-(--card-px) py-3 [--card-px:18px]">
            {footer}
          </div>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export { Dialog, DialogTrigger, DialogClose, DialogContent };
