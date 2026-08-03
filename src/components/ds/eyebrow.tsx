import type { ComponentProps } from "react";
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
 * It sits at `--text-faint` (4.54:1), the AA floor, because it is small text.
 * Do not lighten it: `--graphic-faint` is one step down and is for non-text.
 *
 * Uppercasing is done in CSS, not in the message catalogue, so the Turkish
 * strings stay readable in `tr.json` and so `İ`/`ı` casing stays the browser's
 * problem rather than a translator's.
 */
export function Eyebrow({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-eyebrow text-faint uppercase", className)} {...props} />;
}
