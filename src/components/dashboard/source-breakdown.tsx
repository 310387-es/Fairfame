import { Layers } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { SectionCard } from "@/components/ds/section-card";
import { ChartFallback } from "@/components/dashboard/chart-fallback";
import { describeProvider } from "@/connectors/capability-view";
import type { SourceRow } from "@/dashboard/metrics";

/**
 * Where the reviews came from (widget 6).
 *
 * Only sources that actually produced something appear — a permanent
 * "Trustpilot 0" row is a product brochure, not a breakdown of this week.
 *
 * Name and rating on the left, bar in the middle, count on the right. The bar
 * is proportional to the busiest source rather than to the total, so with four
 * sources the widest is full and the smallest is still visible.
 */
export async function SourceBreakdown({
  rows,
  bare = false,
}: {
  rows: SourceRow[];
  /** Rows only, for the breakdown card's segmented view — see RatingDistribution. */
  bare?: boolean;
}) {
  const [t, format] = await Promise.all([getTranslations("home.sources"), getFormatter()]);

  const rating = (value: number | null) =>
    value === null
      ? // Instagram comments carry no stars; claiming an average would invent one.
        t("noRating")
      : t("average", {
          rating: format.number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
        });

  const body = (
    <>
      {rows.length === 0 ? (
        <p className="py-10 text-center text-copy text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {rows.map((row) => {
              const label = describeProvider(row.source)?.label ?? row.source;

              return (
                <div key={row.source} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-copy font-semibold">{label}</span>
                    <span className="block text-meta text-faint">{rating(row.rating)}</span>
                  </span>

                  <span
                    role="img"
                    aria-label={`${label}: ${row.count}`}
                    className="h-2 w-24 shrink-0 overflow-hidden rounded-[5px] bg-surface-sunken"
                  >
                    <span
                      aria-hidden
                      className="block h-full rounded-[5px] bg-primary"
                      style={{ width: `${row.share * 100}%` }}
                    />
                  </span>

                  <span className="w-7 shrink-0 text-right font-mono text-copy font-semibold tabular-nums">
                    {row.count}
                  </span>
                </div>
              );
            })}
          </div>

          <ChartFallback
            caption={t("title")}
            columns={[t("title"), t("count"), t("rating")]}
            rows={rows.map((row) => ({
              key: row.source,
              cells: [
                describeProvider(row.source)?.label ?? row.source,
                row.count,
                rating(row.rating),
              ],
            }))}
          />
        </>
      )}
    </>
  );

  if (bare) return body;

  return (
    <SectionCard title={t("title")} icon={Layers}>
      {body}
    </SectionCard>
  );
}
