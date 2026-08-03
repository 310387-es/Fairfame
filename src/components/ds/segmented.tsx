import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The segmented control, in one place.
 *
 * It exists in two forms because the *state* lives in two places: the Home
 * range is in the URL, so it must be links; the breakdown card's view is local,
 * so it must be Radix `Tabs` for the roving tabindex and arrow keys. The markup
 * cannot be shared — one renders `<a>`, the other renders `<button role="tab">`
 * — but the styling can, and these constants are it.
 *
 * Anything visual belongs here. If a segmented control ever needs a new colour
 * or radius, this is the only file that should change.
 */

/** The trough. */
export function segmentedTrough(size: SegmentedSize) {
  return cn(
    "inline-flex rounded-md bg-surface-segmented p-[3px] font-semibold",
    size === "sm" ? "text-[11.5px]" : "font-mono text-xs",
  );
}

/**
 * One segment. `--elevation-sm` on the active pill is the only place this
 * system spends a shadow on a control — it is the one thing that floats a step
 * above what surrounds it.
 */
export function segmentedItem(size: SegmentedSize, active: boolean) {
  return cn(
    "rounded-sm transition-colors",
    size === "sm" ? "px-2.5 py-[5px]" : "px-3 py-1.5",
    "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
    active ? "bg-card text-foreground shadow-sm" : "text-ink-400 hover:text-foreground",
  );
}

/** `sm` for a control riding inside a card header. */
export type SegmentedSize = "sm" | "md";

/**
 * The link form, for state the server needs.
 *
 * Links rather than buttons: the selection lives in the URL, so it survives a
 * refresh, can be shared, and works with middle-click, the back button and no
 * JavaScript — all of which a `<button>` + `useRouter` would have to
 * reimplement to arrive at the same place.
 *
 * `aria-current` rather than colour alone: someone who cannot see the white pill
 * still needs to know which segment they are in.
 */
export function Segmented({
  label,
  items,
  size = "md",
  className,
}: {
  /** Names the group for assistive technology, e.g. "Time range". */
  label: string;
  items: { href: string; label: string; short?: string; active: boolean }[];
  size?: SegmentedSize;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn(segmentedTrough(size), className)}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.active ? "true" : undefined}
          aria-label={item.short ? item.label : undefined}
          className={segmentedItem(size, item.active)}
        >
          {item.short ?? item.label}
        </Link>
      ))}
    </nav>
  );
}
