import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  // A state chip: 10px/600, sentence case, 7px corners. Each semantic variant
  // is a tinted wash plus the ink that clears 4.5:1 *on that wash* — pairing a
  // bright hue with a tint of itself is what makes small chips unreadable.
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border border-transparent px-1.5 py-0.5 text-[10px] leading-none font-semibold whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-indigo-700",
        secondary: "bg-surface-sunken text-ink-600 [a]:hover:bg-line-soft",
        destructive:
          "bg-state-negative-bg text-state-negative-text focus-visible:ring-destructive/20 [a]:hover:bg-state-negative-bg/70",
        outline: "border-line text-foreground [a]:hover:bg-surface-sunken",
        ghost: "hover:bg-surface-sunken hover:text-muted-foreground",
        link: "text-primary underline-offset-4 hover:underline",

        /* Sentiment and rating. Never reuse the indigo `default` for "good" —
         * indigo means "this is interactive", not "customers were happy". */
        positive: "bg-state-positive-bg text-state-positive-text",
        negative: "bg-state-negative-bg text-state-negative-text",
        rating: "bg-state-rating-bg text-state-rating-text",
        accent: "bg-state-accent-bg text-state-accent-text",

        /* A numeric count. Fully round, Geist Mono, tabular — so a badge does
         * not change width as the number ticks. */
        count:
          "rounded-full bg-surface-segmented px-1.5 py-0.5 font-mono text-[11px] text-ink-600 tabular-nums",
        "count-urgent":
          "rounded-full bg-destructive px-1.5 py-0.5 font-mono text-[11px] text-white tabular-nums",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
