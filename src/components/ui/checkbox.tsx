"use client";

import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A checkbox in the brand's indigo rather than the operating system's blue.
 *
 * `accent-color` would have recoloured the native input, but only the fill —
 * the border weight, the corner radius and the focus ring stay the platform's,
 * so a row of them never quite sat with the 7px chips and 3px indigo focus ring
 * around them. Radix renders a real button with a hidden native input behind it,
 * so the control is styleable while staying a checkbox to the form and to
 * assistive technology.
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer grid size-4 shrink-0 place-items-center rounded-[5px] border border-line bg-card transition-colors outline-none",
        // `ink-300` was here and is not a token — no `--color-ink-300` exists,
        // so the hover border generated no CSS and every checkbox in the
        // product had no hover feedback at all. `ink-400` is the lightest
        // declared shade, and one visible step darker than `--line`.
        "hover:border-ink-400 focus-visible:ring-3 focus-visible:ring-ring/50",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        "disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center text-current">
        <CheckIcon className="size-3" strokeWidth={3} aria-hidden />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
