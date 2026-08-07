import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A labelled proportion bar: label · track · value.
 *
 * The workhorse of every "breakdown" on a data surface — themes, sources,
 * rating buckets, response rates. It replaces three separate Recharts bar
 * charts that each cost a client bundle to draw what is, honestly, a div with a
 * width.
 *
 * The three columns are fixed-width / fluid / fixed-width so that a column of
 * these lines up: ragged label and value edges are what made the old theme list
 * read as a pile rather than a scale.
 */
const FILLS = {
  accent: "bg-primary",
  positive: "bg-sentiment-positive",
  negative: "bg-sentiment-negative",
  neutral: "bg-sentiment-neutral",
  rating: "bg-amber-500",
} as const;

export type MeterProps = {
  label: ReactNode;
  /** 0–100. Clamped, because a computed share can arrive at 100.0000001. */
  percent: number;
  tone?: keyof typeof FILLS;
  /** The right-hand column — a count, a share, or a worded verdict. */
  value?: ReactNode;
  /**
   * What this row means, as a sentence, for assistive technology. Required:
   * a bar is a picture, and its width is not announced.
   */
  srLabel: string;
  className?: string;
};

export function Meter({ label, percent, tone = "accent", value, srLabel, className }: MeterProps) {
  const width = Math.max(0, Math.min(100, percent));

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span className="w-[120px] shrink-0 truncate text-copy text-ink-600">{label}</span>

      <span
        role="img"
        aria-label={srLabel}
        className="h-[9px] flex-1 overflow-hidden rounded-[5px] bg-surface-sunken"
      >
        <span
          aria-hidden
          className={cn("block h-full rounded-[5px]", FILLS[tone])}
          style={{ width: `${width}%` }}
        />
      </span>

      {/*
        `min-w`, not `w`, and never wrapping.

        The column was a fixed 92px, which fits "3 used · unlimited" and does
        not fit "3 kullanıldı · sınırsız" — so on the billing screen, in the
        launch locale, both usage rows broke across two lines and pushed
        themselves apart. A fixed width sized for the English string is the
        exact failure docs/21 §8 is about: Turkish runs ~30% longer, so it is
        the language that decides how wide a column has to be.

        The floor keeps the values aligned down the list in the ordinary case;
        a longer one now takes room from the bar beside it, which is the right
        thing to give up. A meter's bar is a proportion — it reads the same at
        any width — and its figure does not.
      */}
      {value ? (
        <span className="min-w-[92px] shrink-0 text-right text-meta whitespace-nowrap text-faint">
          {value}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The stacked positive / neutral / negative ribbon.
 *
 * One bar rather than a donut. A donut spends 170px of vertical space to say
 * what a 10px ribbon says, and it cannot be read at a glance without a legend —
 * which is why the old sentiment donut always shipped with one underneath it.
 *
 * Segments below ~2% are still drawn at a visible minimum so "almost none" and
 * "none" stay distinguishable, and the legend prints the true figure.
 */
export function SentimentBar({
  positive,
  neutral,
  negative,
  srLabel,
  className,
}: {
  positive: number;
  neutral: number;
  negative: number;
  srLabel: string;
  className?: string;
}) {
  const segments = [
    { share: positive, fill: "bg-sentiment-positive" },
    { share: neutral, fill: "bg-sentiment-neutral" },
    { share: negative, fill: "bg-sentiment-negative" },
  ].filter((segment) => segment.share > 0);

  return (
    <div
      role="img"
      aria-label={srLabel}
      className={cn("flex h-2.5 gap-0.5 overflow-hidden rounded-md", className)}
    >
      {segments.map((segment, index) => (
        <span
          key={index}
          aria-hidden
          className={cn("h-full", segment.fill)}
          style={{ flex: `${segment.share} 1 0` }}
        />
      ))}
    </div>
  );
}

/** A dot and a name. Pairs with `SentimentBar`, which has no labels of its own. */
export function LegendItem({
  tone,
  children,
  value,
}: {
  tone: keyof typeof FILLS;
  children: ReactNode;
  value?: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5 text-meta text-ink-400">
      <span aria-hidden className={cn("size-2 rounded-[2px]", FILLS[tone])} />
      {children}
      {value ? <strong className="font-mono font-semibold text-ink-800">{value}</strong> : null}
    </span>
  );
}
