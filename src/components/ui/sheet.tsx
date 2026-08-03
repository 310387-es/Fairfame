"use client";

import * as React from "react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A panel that slides in from an edge.
 *
 * Radix `Dialog` underneath, which is what makes it usable rather than merely
 * visible: focus moves into the panel and is trapped there, Escape closes it,
 * the page behind is inert and hidden from assistive technology, and scroll is
 * locked. Hand-rolling a drawer means reimplementing all of that, and the parts
 * people skip are exactly the ones keyboard and screen-reader users need.
 *
 * Built for the mobile navigation rail, so it defaults to the left edge and
 * carries the ink surface — see `components/shell/mobile-nav.tsx`.
 */
function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

/**
 * `title` is required, not optional. Radix warns when a dialog has no
 * accessible name and a nameless navigation drawer is announced as just
 * "dialog"; where the design has no visible heading, pass `hideTitle`.
 */
function SheetContent({
  className,
  children,
  side = "left",
  title,
  hideTitle = false,
  closeLabel,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "left" | "right";
  title: string;
  hideTitle?: boolean;
  closeLabel: string;
}) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay
        data-slot="sheet-overlay"
        className="fixed inset-0 z-50 bg-ink-900/45 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
      />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 z-50 flex w-(--rail-width) max-w-[85vw] flex-col bg-rail text-on-ink shadow-md transition ease-out",
          side === "left"
            ? "left-0 data-open:slide-in-from-left data-closed:slide-out-to-left"
            : "right-0 data-open:slide-in-from-right data-closed:slide-out-to-right",
          "data-open:animate-in data-closed:animate-out",
          className,
        )}
        {...props}
      >
        {hideTitle ? (
          <SheetPrimitive.Title className="sr-only">{title}</SheetPrimitive.Title>
        ) : (
          <SheetPrimitive.Title className="px-(--page-gutter) pt-4 text-title">
            {title}
          </SheetPrimitive.Title>
        )}

        <SheetPrimitive.Close
          aria-label={closeLabel}
          className="absolute top-3.5 right-3 grid size-8 place-items-center rounded-md text-white/62 transition-colors hover:bg-white/8 hover:text-white focus-visible:ring-3 focus-visible:ring-white/40 focus-visible:outline-none"
        >
          <XIcon className="size-4" aria-hidden />
        </SheetPrimitive.Close>

        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export { Sheet, SheetTrigger, SheetClose, SheetContent };
