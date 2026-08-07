import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A headline number.
 *
 * Geist at 28px/600 with −0.03em and `tabular-nums`. Tabular is not a detail:
 * these numbers sit in a row of cells and change on every sync, and
 * proportional digits make the whole strip twitch sideways when a 1 becomes a 7.
 *
 * `tone` is for the number itself, and only for the two cases where the value
 * *is* a judgement — a rating on the amber scale, a response rate that has
 * fallen through the floor. Everything else stays ink. A dashboard where every
 * number is coloured has told you nothing.
 */
const TONES = {
  default: "",
  rating: "text-state-rating-text",
  positive: "text-state-positive-text",
  negative: "text-state-negative-text",
} as const;

export function Metric({
  tone = "default",
  className,
  ...props
}: ComponentProps<"span"> & { tone?: keyof typeof TONES }) {
  return <span className={cn("text-metric tabular-nums", TONES[tone], className)} {...props} />;
}

/**
 * The change beside a metric.
 *
 * Geist Mono, and the arrow carries the sign so the magnitude prints unsigned —
 * "▲ 12", never "▲ +12" and never "▼ −12", which reads as a double negative.
 *
 * `direction` is whether the number moved *in a good direction*, which is not
 * the same as whether it went up: a falling response time is an improvement.
 * Callers decide that; this component only paints it.
 *
 * The direction is restated in words for screen readers because WCAG forbids
 * colour as the only carrier of meaning, and an arrow glyph is not reliably
 * announced either.
 */
export function Delta({
  direction,
  label,
  children,
  className,
}: {
  /** `true` better, `false` worse, `null` neither — a flat or unjudgeable move. */
  direction: boolean | null;
  /** Translated "up" / "down" / "unchanged", for assistive technology. */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        /*
          Never broken across lines.

          A delta is one value — an arrow, a magnitude and a unit — and the
          English unit is abbreviated where the Turkish one is not: "8.5 pp"
          against "6,8 yüzde puan", four times the length, in the tightest
          column on the dashboard. Without this it wrapped as "▼ 6,8 yüzde" /
          "puan", splitting the unit from its number and dropping half of it
          below the metric's baseline.

          With `nowrap` the delta stays whole and moves to its own line instead,
          which the row's `flex-wrap` allows. Losing a line is a much smaller
          cost than a figure that reads as two.
        */
        "font-mono text-[11.5px] leading-none font-semibold whitespace-nowrap tabular-nums",
        direction === true && "text-state-positive-text",
        direction === false && "text-state-negative-text",
        direction === null && "text-faint",
        className,
      )}
    >
      <span aria-hidden>{direction === true ? "▲" : direction === false ? "▼" : "→"} </span>
      <span className="sr-only">{label} </span>
      {children}
    </span>
  );
}
