import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // 9px is the control radius; `rounded-lg` is 14px and belongs to blocks,
        // which on a 32px-tall field rounded it almost to a pill. The sunken
        // fill is `--surface-input` — a field is a well you type into, and on a
        // white card a transparent one is just a hairline rectangle.
        "h-8 w-full min-w-0 rounded-md border border-line bg-surface-sunken px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-body file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-body",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
