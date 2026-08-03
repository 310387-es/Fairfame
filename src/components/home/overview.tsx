import { ActivityFeed, ActivityFeedSkeleton } from "@/components/home/activity-feed";
import { AiInsightStrip } from "@/components/home/ai-insight-strip";
import { DashboardEmpty } from "@/components/home/empty-state";
import { KpiRow, KpiRowSkeleton } from "@/components/home/kpi-row";
import { NeedsAttention, NeedsAttentionSkeleton } from "@/components/home/needs-attention";
import { RatingDistribution } from "@/components/home/rating-distribution";
import { ReputationCard, ReputationCardSkeleton } from "@/components/home/reputation-card";
import { ResponseTime } from "@/components/home/response-time";
import { SentimentDonut } from "@/components/home/sentiment-donut";
import { SourceBreakdown } from "@/components/home/source-breakdown";
import { ThemesList } from "@/components/home/themes-list";
import { recentActivity } from "@/dashboard/activity";
import { needsAttention } from "@/dashboard/attention";
import { hasAnyReviews, loadFacts } from "@/dashboard/facts";
import { composeInsight } from "@/dashboard/insight";
import {
  computeKpis,
  computeRatingDistribution,
  computeResponseTimes,
  computeSentiment,
  computeSeries,
  computeSources,
  computeThemes,
} from "@/dashboard/metrics";
import type { RangeWindow } from "@/dashboard/range";
import { withTenant } from "@/lib/tenancy";
import { Suspense } from "react";

/**
 * The dashboard body (Home live dashboard §3).
 *
 * One tenant-scoped read of the facts, then every widget as a pure function
 * over it. Widgets could each fetch their own slice and stream independently,
 * but they describe the same reviews: separate queries would let the KPI say
 * 128 while the chart plots 126, and nobody would ever report that.
 *
 * A widget that needs data these facts do not carry — review text for the
 * attention queue, the audit trail for the activity feed — gets its own query
 * *and* its own Suspense boundary, so it streams instead of holding this up.
 */

export type OverviewProps = {
  organizationId: string;
  userId: string;
  locationId: string;
  window: RangeWindow;
};

export async function Overview({ organizationId, userId, locationId, window }: OverviewProps) {
  const { facts, everHad } = await withTenant({ organizationId, userId }, async (tx) => {
    const loaded = await loadFacts(tx, organizationId, locationId, window);

    return {
      facts: loaded,
      // Only asked when there is nothing to show: the second query decides
      // *which* empty state, and a location with data never pays for it.
      everHad:
        loaded.current.length > 0 || loaded.previous.length > 0
          ? true
          : await hasAnyReviews(tx, organizationId, locationId),
    };
  });

  if (facts.current.length === 0) {
    // Widgets full of dashes and zeroes are not an empty state, they are a
    // broken-looking page. One card that says what happened and what to do
    // next is the whole of it.
    return <DashboardEmpty reason={everHad ? "quiet_period" : "no_sources"} range={window.range} />;
  }

  const kpis = computeKpis(facts, window);
  const insight = composeInsight(facts);
  const series = computeSeries(facts, window);

  return (
    <div className="flex flex-col gap-4">
      <KpiRow kpis={kpis} />
      <AiInsightStrip insight={insight} />

      {/* The chart is the page's centre of gravity, so it takes roughly twice
          the width. On a phone the queue comes first: what needs answering
          beats what the trend looks like when you are standing on a tram. */}
      <div className="grid gap-4 lg:grid-cols-[1.9fr_1fr]">
        <div className="order-2 lg:order-1">
          <ReputationCard series={series} range={window.range} average={kpis.rating.value} />
        </div>

        <div className="order-1 lg:order-2">
          <Suspense fallback={<NeedsAttentionSkeleton />}>
            <AttentionSection
              organizationId={organizationId}
              userId={userId}
              locationId={locationId}
              window={window}
            />
          </Suspense>
        </div>
      </div>

      {/* Two rows of three: what people felt, where it came from, what they
          talked about — then the same week seen through stars, speed and
          events. Each is one glance wide on a desktop and full width on a
          phone. */}
      <div className="grid gap-4 md:grid-cols-3">
        <SentimentDonut breakdown={computeSentiment(facts)} />
        <SourceBreakdown rows={computeSources(facts)} />
        <ThemesList rows={computeThemes(facts)} />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <RatingDistribution buckets={computeRatingDistribution(facts)} />
        <ResponseTime times={computeResponseTimes(facts)} />

        <Suspense fallback={<ActivityFeedSkeleton />}>
          <ActivitySection
            organizationId={organizationId}
            userId={userId}
            locationId={locationId}
            window={window}
          />
        </Suspense>
      </div>
    </div>
  );
}

/** Events live in their own tables, so this reads them and streams on its own. */
async function ActivitySection({ organizationId, userId, locationId, window }: OverviewProps) {
  const items = await withTenant({ organizationId, userId }, (tx) =>
    recentActivity(tx, organizationId, locationId, window),
  );

  return <ActivityFeed items={items} />;
}

/**
 * The queue reads review text, which the shared facts deliberately omit — so it
 * gets its own query and its own boundary, and the rest of the page paints
 * without waiting for it.
 */
async function AttentionSection({ organizationId, userId, locationId, window }: OverviewProps) {
  const rows = await withTenant({ organizationId, userId }, (tx) =>
    needsAttention(tx, organizationId, locationId, window),
  );

  return <NeedsAttention rows={rows} />;
}

export function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <KpiRowSkeleton />
      <div className="h-16 animate-pulse rounded-2xl bg-muted" aria-hidden />
      <div className="grid gap-4 lg:grid-cols-[1.9fr_1fr]">
        <ReputationCardSkeleton />
        <NeedsAttentionSkeleton />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <ActivityFeedSkeleton />
        <ActivityFeedSkeleton />
        <ActivityFeedSkeleton />
      </div>
    </div>
  );
}
