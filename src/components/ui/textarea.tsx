import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Multi-line input, styled to match `Input`. Added for the review submission
 * form — the first place in the product where someone writes more than a line.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // Control radius and the sunken field fill — see `input.tsx`.
        "field-sizing-content min-h-24 w-full rounded-md border border-line bg-surface-sunken px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-body",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
