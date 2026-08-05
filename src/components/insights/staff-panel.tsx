import type { LucideIcon } from "lucide-react";
import { Meter } from "@/components/ds/meter";
import { SectionCard } from "@/components/ds/section-card";

/**
 * Who customers named (P3-T4).
 *
 * **Mentions, not a rating**, and the panel is built to keep saying so. There
 * is no rank number, no composite score and no "top performer" — the list is
 * ordered by how often a person was named and the only figures shown are counts
 * and the average rating of the reviews that named them, each one traceable to
 * words a customer actually wrote.
 *
 * That restraint is the feature. These are real employees, the text is
 * strangers' prose, and a number presented as an evaluation of a named
 * individual is something a manager may act on — so the copy says what this is
 * (`staffNote`) and the shape gives them nothing to rank by. See migration
 * 0033 for the data-protection side of the same decision.
 *
 * The other honesty requirement: an empty list means "nobody was named", which
 * is only true if we looked. `notAnalysed` is shown whenever part of the window
 * predates staff extraction, so a business is never told its customers name
 * nobody when the truth is that we have not read those reviews for names.
 */

export type StaffRow = {
  name: string;
  /** Preformatted on the server. */
  count: string;
  /** Reviews naming them, as a share of the largest — the bar's width. */
  share: number;
  rating: string | null;
  positive: number;
  neutral: number;
  negative: number;
};

export function StaffPanel({
  title,
  icon,
  people,
  note,
  empty,
  notAnalysed,
  moodLabel,
  ratingLabel,
}: {
  title: string;
  icon: LucideIcon;
  people: StaffRow[];
  /** What this panel is, and is not. Always shown. */
  note: string;
  empty: string;
  /** Non-null when some of the window has not been read for names. */
  notAnalysed: string | null;
  moodLabel: (row: StaffRow) => string;
  ratingLabel: (rating: string) => string;
}) {
  const dominant = (row: StaffRow) =>
    row.negative > row.positive && row.negative > row.neutral
      ? ("negative" as const)
      : row.positive > row.negative && row.positive > row.neutral
        ? ("positive" as const)
        : ("neutral" as const);

  return (
    <SectionCard title={title} icon={icon}>
      <div className="flex flex-col gap-3 pb-(--card-py)">
        <p className="text-meta text-faint">{note}</p>

        {notAnalysed ? <p className="text-meta text-faint">{notAnalysed}</p> : null}

        {people.length === 0 ? (
          <p className="text-body text-ink-400">{empty}</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {people.map((row) => (
              <Meter
                key={row.name}
                label={row.name}
                percent={row.share * 100}
                tone={dominant(row)}
                value={
                  <span className="tabular-nums">
                    {row.count}
                    {row.rating ? ` · ${ratingLabel(row.rating)}` : ""}
                  </span>
                }
                srLabel={`${row.name}: ${row.count} — ${moodLabel(row)}`}
              />
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
