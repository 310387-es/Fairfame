import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * One filter option, as a link.
 *
 * Shared by the filter bar and the saved-views row so the two read as one
 * control strip rather than as two components that happen to sit together. It
 * has no server-only dependencies, so a client component can render it too.
 *
 * The count is a separate mono element rather than baked into the label as
 * "Instagram · 67". Two typefaces doing two jobs: the name is prose and the
 * number is data, and tabular digits mean a column of chips stops changing width
 * every time the counts refresh. It is also the difference between the count
 * reading as part of the name and reading as a quantity.
 */
export function Chip({
  href,
  active,
  count,
  className,
  children,
}: {
  href: string;
  active: boolean;
  count?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(chipClassName(active), className)}
    >
      {children}
      {count === undefined ? null : (
        <span
          className={cn(
            "font-mono text-[11px] tabular-nums",
            active ? "text-white/80" : "text-graphic-faint",
          )}
        >
          {count}
        </span>
      )}
    </Link>
  );
}

/** The chip's look, for the few places that need a button rather than a link. */
export function chipClassName(active: boolean): string {
  return cn(
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
    "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
    active
      ? "border-primary bg-primary font-semibold text-primary-foreground hover:border-indigo-700 hover:bg-indigo-700"
      : "border-line bg-card font-medium text-ink-400 hover:bg-surface-sunken hover:text-foreground",
  );
}

/**
 * A labelled row of chips.
 *
 * Two columns from `sm` up, not a wrapping flex row: the label needs its own
 * column so a group that wraps onto a second line keeps its chips aligned with
 * the first, instead of tucking them under the label. The column is a fixed
 * width rather than `max-content` because each group is its own grid — sizing to
 * content would let every row pick a different gutter and the labels would sit
 * ragged.
 *
 * 6rem, sized for the longest Turkish label ("GÖRÜNÜMLER") rather than the
 * longest English one. TR runs about 30% longer than EN (docs/15 §7), so a
 * gutter that fits the English copy is a gutter that clips the launch locale —
 * which is exactly what 3.5rem did here.
 *
 * On a phone the label stacks above its chips instead, because six rems of
 * gutter is a sixth of the screen spent on a word nobody needs to re-read.
 */
export function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid items-start gap-1.5 sm:grid-cols-[6rem_1fr]">
      {/* Micro-caps, like every other label on a data surface. */}
      <span className="text-eyebrow text-faint uppercase sm:pt-1.5">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}
