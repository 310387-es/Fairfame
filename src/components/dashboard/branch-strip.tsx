"use client";

import { ArrowUpDown, Building2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { SectionCard } from "@/components/ds/section-card";
import { Stars } from "@/components/ds/stars";
import { cn } from "@/lib/utils";

/**
 * Every branch on one screen, sortable (W4.3).
 *
 * **This is the reason Home defaults to all branches.** A chain owner's real
 * question is "which of my nine needs me this week", and until now the only way
 * to ask it was to switch the active branch nine times and remember nine sets
 * of numbers. One row each, one line, and the columns are the four things that
 * actually differ: how they are rated, how much came in, what is waiting, and
 * how fast anyone answered.
 *
 * **Sorting is client-side and that is deliberate.** The rows are already here
 * — they came from the same facts the headline KPIs did — so a round trip per
 * sort would be a round trip to reorder an array we are holding. It also keeps
 * the sort out of the URL, which is right: sorting is a way of *looking*, and
 * nobody links a colleague to "Home sorted by unanswered descending".
 *
 * **Every row is a link, not a click handler.** Drilling into a branch is a
 * navigation — it changes what the whole page is about — so it is a real anchor
 * that opens in a new tab, is announced as a link, and works before hydration.
 */

export type BranchStripRow = {
  locationId: string;
  name: string;
  href: string;
  rating: number | null;
  ratingLabel: string | null;
  ratingDeltaLabel: string | null;
  ratingDelta: number | null;
  volume: number;
  volumeDeltaLabel: string | null;
  volumeDelta: number | null;
  unanswered: number;
  /** Already worded — "4,2 sa", "3 gün" — or null with nothing answered. */
  responseLabel: string | null;
  responseHours: number | null;
};

type SortKey = "name" | "rating" | "volume" | "unanswered" | "response";

export function BranchStrip({ rows }: { rows: BranchStripRow[] }) {
  const t = useTranslations("home");
  const [sort, setSort] = useState<SortKey>("unanswered");

  const sorted = useMemo(() => {
    /**
     * Null sorts last on every measure, never as zero.
     *
     * A branch with nothing rated this month is not the worst-rated branch, and
     * a branch nobody has replied to yet is not the fastest — which is exactly
     * what `null → 0` would claim on the response column. Sorting them to the
     * bottom is the only reading that is true on all four columns at once.
     */
    const last = (value: number | null, descending: boolean) =>
      value === null ? (descending ? -Infinity : Infinity) : value;

    const copy = [...rows];

    switch (sort) {
      case "name":
        return copy.sort((left, right) => left.name.localeCompare(right.name));
      case "rating":
        return copy.sort((left, right) => last(right.rating, true) - last(left.rating, true));
      case "volume":
        return copy.sort((left, right) => right.volume - left.volume);
      case "response":
        // Ascending: fast is good here, which is the one column where the
        // arrow means the opposite of the others.
        return copy.sort(
          (left, right) => last(left.responseHours, false) - last(right.responseHours, false),
        );
      case "unanswered":
      default:
        return copy.sort((left, right) => right.unanswered - left.unanswered);
    }
  }, [rows, sort]);

  return (
    <SectionCard
      title={t("branches.title")}
      icon={Building2}
      meta={t("branches.meta", { count: rows.length })}
      flush
    >
      <div className="relative w-full overflow-x-auto border-t border-line-soft">
        <table className="w-full min-w-[40rem] border-collapse text-left text-copy">
          <thead>
            <tr className="text-meta text-faint">
              <Sortable label={t("branches.branch")} value="name" sort={sort} onSort={setSort} />
              <Sortable
                label={t("branches.rating")}
                value="rating"
                sort={sort}
                onSort={setSort}
                numeric
              />
              <Sortable
                label={t("branches.volume")}
                value="volume"
                sort={sort}
                onSort={setSort}
                numeric
              />
              <Sortable
                label={t("branches.unanswered")}
                value="unanswered"
                sort={sort}
                onSort={setSort}
                numeric
              />
              <Sortable
                label={t("branches.response")}
                value="response"
                sort={sort}
                onSort={setSort}
                numeric
              />
            </tr>
          </thead>

          <tbody>
            {sorted.map((row) => (
              <tr key={row.locationId} className="border-t border-line-soft hover:bg-canvas">
                <td className="px-(--card-px) py-2">
                  <Link
                    href={row.href}
                    className="font-medium text-foreground hover:text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {row.name}
                  </Link>
                </td>

                <td className="px-(--card-px) py-2">
                  {row.rating === null ? (
                    <span className="text-meta text-faint">{t("branches.noRating")}</span>
                  ) : (
                    <span className="flex items-center justify-end gap-1.5">
                      <Stars rating={row.rating} srLabel={row.ratingLabel ?? ""} />
                      <Delta label={row.ratingDeltaLabel} value={row.ratingDelta} />
                    </span>
                  )}
                </td>

                <td className="px-(--card-px) py-2 text-right">
                  <span className="flex items-center justify-end gap-1.5">
                    <span className="tabular-nums">{row.volume}</span>
                    <Delta label={row.volumeDeltaLabel} value={row.volumeDelta} />
                  </span>
                </td>

                <td className="px-(--card-px) py-2 text-right tabular-nums">
                  {row.unanswered === 0 ? (
                    <span className="text-faint">0</span>
                  ) : (
                    <span className="font-medium text-state-negative-text">{row.unanswered}</span>
                  )}
                </td>

                <td className="px-(--card-px) py-2 text-right tabular-nums">
                  {row.responseLabel ?? <span className="text-faint">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

function Sortable({
  label,
  value,
  sort,
  onSort,
  numeric = false,
}: {
  label: string;
  value: SortKey;
  sort: SortKey;
  onSort: (next: SortKey) => void;
  numeric?: boolean;
}) {
  const active = sort === value;

  return (
    <th
      scope="col"
      // `aria-sort` so the column a screen reader lands on says how the table is
      // ordered. Always descending except response time, which the comment in
      // the sorter explains — announcing the direction is what makes that
      // legible rather than surprising.
      aria-sort={active ? (value === "response" ? "ascending" : "descending") : "none"}
      className={cn("px-(--card-px) py-2 font-medium", numeric && "text-right")}
    >
      <button
        type="button"
        onClick={() => onSort(value)}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          active ? "text-foreground" : "hover:text-ink-500",
        )}
      >
        {label}
        <ArrowUpDown className={cn("size-3", active ? "opacity-100" : "opacity-40")} aria-hidden />
      </button>
    </th>
  );
}

/**
 * A movement, or nothing.
 *
 * Null is a real answer — no previous period, or a percentage from zero, which
 * `percentChange` withholds on purpose. Rendering "0%" there would claim a
 * branch held steady when what actually happened is that it had no reviews to
 * compare against.
 */
function Delta({ label, value }: { label: string | null; value: number | null }) {
  if (label === null) return null;

  return (
    <span
      className={cn(
        "text-meta tabular-nums",
        (value ?? 0) > 0
          ? "text-state-positive-text"
          : (value ?? 0) < 0
            ? "text-state-negative-text"
            : "text-faint",
      )}
    >
      {label}
    </span>
  );
}
