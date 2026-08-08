import { cloneElement, isValidElement, type ComponentProps, type ReactElement } from "react";
import { cn } from "@/lib/utils";

/**
 * The micro-caps label: 10.5px, 600, uppercase, 0.08em tracking.
 *
 * This is the *only* label style allowed on a data surface. The sentence-case
 * grey label it replaces ("Reputation score" in 12px muted) competed with the
 * number underneath it for the same visual weight; shrinking the label and
 * spacing it out settles that argument permanently — the number wins, which is
 * what someone scanning a dashboard came for.
 *
 * It sits at `--text-faint` (5.06:1 on white), comfortably past the AA floor for
 * small text. Do not lighten it below the surface's own limit — the legal ink
 * depends on what is behind it, and `tests/lib/design-contrast.test.ts` holds
 * the table. `--graphic-faint` is one step down and is for non-text.
 *
 * Uppercasing is done in CSS, not in the message catalogue, so the Turkish
 * strings stay readable in `tr.json` and so `İ`/`ı` casing stays the browser's
 * problem rather than a translator's.
 *
 * **`asChild` exists because the label is not always a paragraph.** A funnel's
 * label is a `<dt>` inside a `<dl>`, a table's is a `<th>`, a fieldset's is a
 * `<legend>` — and none of those may be wrapped in a `<p>` without breaking the
 * structure a screen reader navigates by. Without this the only way to get the
 * style onto correct markup was to retype the four classes, which is exactly how
 * `/get-reviews` ended up with three different renderings of one label.
 */
export function Eyebrow({
  className,
  asChild = false,
  children,
  ...props
}: ComponentProps<"p"> & { asChild?: boolean }) {
  const classes = cn("text-eyebrow text-faint uppercase", className);

  // `cloneElement` rather than Radix's `Slot`, which is not a dependency here.
  // One child, one merged className — the whole of what `asChild` needs to do.
  if (asChild && isValidElement<{ className?: string }>(children)) {
    return cloneElement(children as ReactElement<{ className?: string }>, {
      className: cn(classes, children.props.className),
    });
  }

  return (
    <p className={classes} {...props}>
      {children}
    </p>
  );
}
