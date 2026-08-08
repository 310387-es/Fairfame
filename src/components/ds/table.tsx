import type { ReactNode } from "react";
import { Eyebrow } from "@/components/ds/eyebrow";
import { cn } from "@/lib/utils";

/**
 * A data table's column header.
 *
 * **Why this is in the design system rather than in one screen.** There were
 * three of these, and no two agreed: `/locations` had a private `Th` at 11px
 * medium `--ink-500`, `/analytics`'s comparison table set `text-meta text-faint`
 * on the `<thead>`, and `/get-reviews` wrote `text-copy text-muted-foreground`
 * with a bottom border — three sizes, three inks and three weights for the same
 * word in the same role. `docs/21` §1 gives labels on a data surface exactly one
 * treatment, and a column header is the most label-like thing in the product.
 *
 * So it is `Eyebrow`, which is that treatment, via `asChild` so the element
 * stays a real `<th scope="col">` — a table whose headers are `<p>` is a table a
 * screen reader cannot navigate, and copying the four classes onto a `<th>` by
 * hand is how the three versions happened in the first place.
 *
 * `numeric` right-aligns, and it is the only alignment option on purpose: a
 * column is either a quantity or it is not, and letting a caller pass arbitrary
 * alignment is how a number column ends up left-aligned in one table.
 */
export function Th({
  children,
  numeric = false,
  srOnly = false,
  className,
}: {
  children: ReactNode;
  /** Quantities align right so digits line up under each other. */
  numeric?: boolean;
  /**
   * A column that has a header for structure but does not need to show one —
   * a disclosure chevron, a row of actions. The header is still announced.
   */
  srOnly?: boolean;
  className?: string;
}) {
  return (
    <Eyebrow asChild>
      <th scope="col" className={cn("px-3 py-2", numeric ? "text-right" : "text-left", className)}>
        <span className={cn(srOnly && "sr-only")}>{children}</span>
      </th>
    </Eyebrow>
  );
}

/**
 * The row a `Th` set sits in. Separated from the page's own surface, because a
 * header that shares the body's background reads as the first row of data.
 */
export function Thead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <thead className={cn("border-b border-line bg-surface-sunken/50", className)}>{children}</thead>
  );
}
