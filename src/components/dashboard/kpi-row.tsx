import { getTranslations } from "next-intl/server";
import { KpiCard, reputationHint } from "@/components/dashboard/kpi-card";
import type { DashboardKpis, KpiKey } from "@/dashboard/metrics";

/**
 * The four headline numbers, as one divided strip.
 *
 * Hairlines rather than gaps. These are four readings of the same period, and
 * separating them with whitespace and four card borders said the opposite —
 * that they were four independent widgets that happened to sit together. The
 * strip sits inside the reputation card, above the chart that explains it.
 *
 * Two columns on a phone rather than four squeezed or one stacked: an owner
 * checking on the way to work should see all four without scrolling, and at
 * four across the numbers become unreadable on a 390px screen. The dividers
 * follow the wrap — no right-hand line on the last column of either layout.
 */

const ORDER: KpiKey[] = ["reputation", "rating", "volume", "responseRate"];

export async function KpiRow({ kpis }: { kpis: DashboardKpis }) {
  const t = await getTranslations("home.kpi");

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4">
      {ORDER.map((key, index) => (
        <div
          key={key}
          className={
            // `[&:nth-child(2n)]` clears the divider mid-row on a phone;
            // `lg:` restores it because at four across only the last cell ends.
            "border-line-inner lg:border-r [&:nth-child(2n)]:border-r-0 " +
            (index < 2 ? "border-b lg:border-b-0 " : "") +
            (index === ORDER.length - 1 ? "lg:border-r-0" : "border-r")
          }
        >
          <KpiCard kpi={kpis[key]} />
        </div>
      ))}

      {/*
        The score's composition, once, under the strip — phones only.

        Inside the tile it is four lines at 180px wide and unbalances the row
        (see `KpiCard`). It has to stay somewhere on a phone: `73 /100` names no
        unit on its own, and W4.3 put this sentence in precisely because the
        explanation had been a `title` attribute, which a touch screen has no
        way to show.
      */}
      <p className="col-span-2 border-t border-line-inner px-(--card-px) py-2.5 text-meta text-pretty text-faint lg:hidden">
        {reputationHint(t)}
      </p>
    </div>
  );
}

export function KpiRowSkeleton() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4" aria-hidden>
      {ORDER.map((key, index) => (
        <div
          key={key}
          className={
            "border-line-inner px-[18px] py-4 lg:border-r [&:nth-child(2n)]:border-r-0 " +
            (index < 2 ? "border-b lg:border-b-0 " : "") +
            (index === ORDER.length - 1 ? "lg:border-r-0" : "border-r")
          }
        >
          {/* Same shapes in the same places as the real cell, so the layout
              does not jump when the numbers arrive. */}
          <span className="block h-2.5 w-20 animate-pulse rounded bg-muted" />
          <span className="mt-2 block h-7 w-16 animate-pulse rounded bg-muted" />
          <span className="mt-2.5 block h-5 w-[90px] animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
