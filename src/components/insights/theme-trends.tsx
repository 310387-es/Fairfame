import type { LucideIcon } from "lucide-react";
import { Meter } from "@/components/ds/meter";
import { SectionCard } from "@/components/ds/section-card";
import { ChartFallback } from "@/components/home/chart-fallback";

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
 * Bar colour is the dominant sentiment rather than the count, for the reason
 * Home gives: "cleanliness, 22 mentions" means opposite things depending on
 * whether those were compliments or complaints.
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
}) {
  const dominant = (row: ThemeRow) =>
    row.negative > row.positive && row.negative > row.neutral
      ? ("negative" as const)
      : row.positive > row.negative && row.positive > row.neutral
        ? ("positive" as const)
        : ("neutral" as const);

  return (
    <SectionCard title={title} icon={icon}>
      {themes.length === 0 ? (
        <p className="pb-(--card-py) text-body text-ink-400">{empty}</p>
      ) : (
        <div className="pb-(--card-py)">
          <div className="flex flex-col gap-2.5">
            {themes.map((row) => (
              <Meter
                key={row.theme}
                label={row.theme}
                percent={row.share * 100}
                tone={dominant(row)}
                value={
                  <span
                    className={
                      row.direction === "up"
                        ? "text-primary"
                        : row.direction === "down"
                          ? "text-destructive"
                          : "text-faint"
                    }
                  >
                    {/* "New" rather than a percentage: everything is up
                        infinitely from a base of nothing. */}
                    {row.delta ?? newLabel}
                  </span>
                }
                srLabel={`${row.theme}: ${row.count} — ${moodLabel(row)}, ${row.delta ?? newLabel}`}
              />
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
