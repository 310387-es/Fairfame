import { KpiCard } from "@/components/home/kpi-card";
import { Card, CardContent } from "@/components/ui/card";
import type { DashboardKpis, KpiKey } from "@/dashboard/metrics";

/**
 * The four headline numbers.
 *
 * Two columns on a phone rather than four squeezed or one stacked: an owner
 * checking on the way to work should see all four without scrolling, and at
 * four across the numbers become unreadable on a 390px screen.
 */

const ORDER: KpiKey[] = ["reputation", "rating", "volume", "responseRate"];

export function KpiRow({ kpis }: { kpis: DashboardKpis }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {ORDER.map((key) => (
        <KpiCard key={key} kpi={kpis[key]} />
      ))}
    </div>
  );
}

export function KpiRowSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-hidden>
      {ORDER.map((key) => (
        <Card key={key} className="rounded-2xl">
          <CardContent className="flex flex-col gap-3">
            {/* Same shapes in the same places as the real card, so the layout
                does not jump when the numbers arrive. */}
            <div className="flex items-center gap-2">
              <span className="size-7 animate-pulse rounded-lg bg-muted" />
              <span className="h-3 w-24 animate-pulse rounded bg-muted" />
            </div>
            <div className="flex items-end justify-between">
              <span className="h-8 w-16 animate-pulse rounded bg-muted" />
              <span className="h-6 w-16 animate-pulse rounded bg-muted" />
            </div>
            <span className="h-4 w-12 animate-pulse rounded bg-muted" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
