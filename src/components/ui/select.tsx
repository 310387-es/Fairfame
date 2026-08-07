"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A select that belongs to the system.
 *
 * The native `<select>` it replaces was accessible and keyboard-complete — that
 * was never the problem. The problem was that its closed state is drawn by the
 * operating system, so a settings card built entirely from system tokens had two
 * grey macOS dropdowns sitting in the middle of it, and its open menu is a
 * platform popup that no amount of CSS reaches.
 *
 * Radix restores what the native control gave for free: typeahead, arrow keys,
 * Home/End, Escape, focus return to the trigger, and `role="combobox"` wiring.
 * Where a form is genuinely no-JS-critical, keep the native element — this is
 * for the settings surfaces, which already require JavaScript to save.
 */
function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        // `--surface-sunken` and `text-body`, both matching `Input`: a select
        // and a text field are the same kind of thing to whoever is filling the
        // form, and on a white card the two sat side by side in different
        // fills and different sizes. The hover deepens to the segmented trough,
        // since the rest state is now where the hover used to go.
        "flex h-8 w-full items-center justify-between gap-2 rounded-md border border-line bg-surface-sunken px-2.5 text-body transition-colors outline-none",
        "hover:bg-surface-segmented focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-45",
        "data-[placeholder]:text-muted-foreground [&>span]:truncate",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-ink-400" aria-hidden />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={4}
        className={cn(
          // `--elevation-md` territory: a menu is one of the two things in this
          // system that genuinely floats above the page.
          "relative z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) overflow-y-auto rounded-md border border-line bg-popover p-1 text-popover-foreground shadow-md",
          "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-0">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-7 text-copy outline-none select-none",
        "data-highlighted:bg-surface-sunken data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 grid size-3.5 place-items-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5 text-primary" aria-hidden />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem };
