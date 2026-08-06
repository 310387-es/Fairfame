import type { LucideIcon } from "lucide-react";
import { SectionCard } from "@/components/ds/section-card";
import { ChartFallback } from "@/components/dashboard/chart-fallback";
import { cn } from "@/lib/utils";

/**
 * What customers are talking about, and which way it is going (P3-T4).
 *
 * The same `Meter` rows as Home's themes panel, and deliberately so — a
 * business should not have to learn a second way of reading the same idea. Two
 * differences, both from the question this page answers rather than that one:
 *
 *   - **Ordered by movement, not by size** (see `themeTrends`). A theme that is
 *     always the biggest is not news; one that doubled is.
 *   - **The change is the right-hand column.** Home's themes panel answers
 *     "what do people talk about"; this one answers "what changed", so the
 *     delta earns the position the mood verdict holds there.
 *
 * **The bar is split, not tinted** (W4.4). It used to be one solid bar in the
 * *dominant* sentiment's colour, and "dominant" threw away the thing worth
 * seeing: 12 positive and 11 negative rendered as a green bar identical to 23
 * positive, and a theme genuinely tearing a business in half looked like a
 * happy one. The counts were already on the row; only the drawing was lossy.
 *
 * Three segments in the sentiment palette, widths proportional to the mentions
 * they represent, the whole bar scaled to the theme's share of the window.
 * `docs/remediation-plan.md` asks for "split bars (not floats)" and this is the
 * float it means.
 */

export type ThemeRow = {
  theme: string;
  count: number;
  /** Share of the window's mentions, 0–1 — the bar's width. */
  share: number;
  /** Preformatted, or null where there is no previous window to compare to. */
  delta: string | null;
  direction: "up" | "down" | "flat" | null;
  positive: number;
  neutral: number;
  negative: number;
};

export function ThemeTrends({
  title,
  icon,
  themes,
  empty,
  newLabel,
  columns,
  moodLabel,
  themeLabel,
}: {
  title: string;
  icon: LucideIcon;
  themes: ThemeRow[];
  empty: string;
  /** Shown where a theme has no previous window to compare against. */
  newLabel: string;
  /** Table headers for the text fallback: theme, mentions, change. */
  columns: [string, string, string];
  /** "mostly negative (8)" and so on, resolved by the caller. */
  moodLabel: (row: ThemeRow) => string;
  /**
   * A canonical theme key rendered in the reader's language (W3.2).
   *
   * Resolved by the caller, like `moodLabel`: this component is rendered on the
   * server, so a function prop is fine here — the P3-T4 defect was a formatter
   * passed into a *client* component, which is a different thing.
   */
  themeLabel: (key: string) => string;
}) {
  return (
    <SectionCard title={title} icon={icon}>
      {themes.length === 0 ? (
        <p className="pb-(--card-py) text-body text-ink-400">{empty}</p>
      ) : (
        <div className="pb-(--card-py)">
          <div className="flex flex-col gap-2.5">
            {themes.map((row) => (
              <div key={row.theme} className="flex items-center gap-3">
                <span className="w-[120px] shrink-0 truncate text-copy text-ink-600">
                  {themeLabel(row.theme)}
                </span>

                <span
                  role="img"
                  aria-label={`${themeLabel(row.theme)}: ${row.count} — ${moodLabel(row)}, ${row.delta ?? newLabel}`}
                  className="h-[9px] flex-1 overflow-hidden rounded-[5px] bg-surface-sunken"
                >
                  {/*
                    The outer span is the theme's share of the window; the three
                    inner ones split *that* by sentiment. Nesting rather than
                    three siblings summing to the share, because the segments
                    then divide a known width and cannot drift apart by a
                    rounding error into a bar that is a pixel short.
                  */}
                  <span
                    aria-hidden
                    className="flex h-full overflow-hidden rounded-[5px]"
                    style={{ width: `${Math.min(100, row.share * 100)}%` }}
                  >
                    {(
                      [
                        ["positive", row.positive, "bg-sentiment-positive"],
                        ["neutral", row.neutral, "bg-sentiment-neutral"],
                        ["negative", row.negative, "bg-sentiment-negative"],
                      ] as const
                    ).map(([key, value, tone]) => (
                      <span
                        key={key}
                        className={tone}
                        // `flex-basis`, not `width`: three percentage widths in
                        // a flex row are laid out against the *content* box and
                        // 33/33/34 comes out a fraction short. A basis divides
                        // the track exactly.
                        style={{ flexBasis: `${row.count === 0 ? 0 : (value / row.count) * 100}%` }}
                      />
                    ))}
                  </span>
                </span>

                <span
                  className={cn(
                    "w-14 shrink-0 text-right font-mono text-meta tabular-nums",
                    row.direction === "up"
                      ? "text-primary"
                      : row.direction === "down"
                        ? "text-destructive"
                        : "text-faint",
                  )}
                >
                  {/* "New" rather than a percentage: everything is up
                      infinitely from a base of nothing. */}
                  {row.delta ?? newLabel}
                </span>
              </div>
            ))}
          </div>

          <ChartFallback
            caption={title}
            columns={columns}
            rows={themes.map((row) => ({
              key: row.theme,
              cells: [row.theme, `${row.count} — ${moodLabel(row)}`, row.delta ?? newLabel],
            }))}
          />
        </div>
      )}
    </SectionCard>
  );
}
