import { Star } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { SectionCard } from "@/components/ds/section-card";
import { ChartFallback } from "@/components/dashboard/chart-fallback";
import type { RatingBucket } from "@/dashboard/metrics";
import { cn } from "@/lib/utils";

/**
 * Five to one (widget 8).
 *
 * Always all five rungs, even the empty ones: a ladder missing its 2★ row reads
 * as "no data for that" rather than "nobody left two stars", and the shape of
 * the ladder is the whole point.
 */
/**
 * One colour per rung, green at five down to red at one, with three on the
 * amber middle where an average belongs. A rating is an ordered scale, so the
 * colours are ordered too — three buckets would say four and five are the same
 * thing, and they are not.
 *
 * Written out rather than built as `bg-rating-${rating}`: Tailwind generates
 * utilities by scanning source text, so an interpolated class name is a class
 * that never gets emitted — the bars would render with no fill at all.
 */
const FILLS: Record<number, string> = {
  5: "bg-rating-5",
  4: "bg-rating-4",
  3: "bg-rating-3",
  2: "bg-rating-2",
  1: "bg-rating-1",
};

export async function RatingDistribution({
  buckets,
  bare = false,
}: {
  buckets: RatingBucket[];
  /**
   * Render only the rows, for use inside the breakdown card's segmented view.
   * That card supplies the frame, and a card nested in a card would draw two
   * borders around one list.
   */
  bare?: boolean;
}) {
  const t = await getTranslations("home.distribution");
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);

  const body = (
    <>
      {total === 0 ? (
        <p className="py-10 text-center text-copy text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <div className="flex flex-col gap-2.5">
            {buckets.map((bucket) => {
              const label = t("stars", { count: bucket.rating });

              return (
                <div key={bucket.rating} className="flex items-center gap-3">
                  <span className="w-[68px] shrink-0 text-copy text-ink-600">{label}</span>

                  <span
                    role="img"
                    aria-label={`${label}: ${bucket.count}`}
                    className="h-[9px] flex-1 overflow-hidden rounded-[5px] bg-surface-sunken"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "block h-full rounded-[5px]",
                        FILLS[bucket.rating] ?? "bg-rating-3",
                      )}
                      style={{ width: `${bucket.share * 100}%` }}
                    />
                  </span>

                  <span className="w-6 shrink-0 text-right font-mono text-[13px] font-semibold tabular-nums">
                    {bucket.count}
                  </span>
                </div>
              );
            })}
          </div>

          <ChartFallback
            caption={t("title")}
            columns={[t("title"), t("count")]}
            rows={buckets.map((bucket) => ({
              key: String(bucket.rating),
              cells: [t("stars", { count: bucket.rating }), bucket.count],
            }))}
          />
        </>
      )}
    </>
  );

  if (bare) return body;

  return (
    <SectionCard title={t("title")} icon={Star} tone="rating">
      {body}
    </SectionCard>
  );
}
