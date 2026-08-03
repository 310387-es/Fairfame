import { ActivityFeed, ActivityFeedSkeleton } from "@/components/home/activity-feed";
import { AiInsightStrip } from "@/components/home/ai-insight-strip";
import { BreakdownCard } from "@/components/home/breakdown-card";
import { DashboardEmpty } from "@/components/home/empty-state";
import { NeedsAttention, NeedsAttentionSkeleton } from "@/components/home/needs-attention";
import { ReputationCard, ReputationCardSkeleton } from "@/components/home/reputation-card";
import { ResponseTime } from "@/components/home/response-time";
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
    // Five ranked blocks, not ten equal ones.
    //
    // The old page gave a 170px donut showing two numbers the same weight as the
    // reputation chart, and put the queue of unanswered reviews below the fold.
    // Rank now follows what an owner opens this page to do: read the one
    // sentence, see whether the trend is holding, answer what is waiting, and
    // only then look at the breakdowns.
    <div className="flex flex-col gap-(--grid-gap)">
      <AiInsightStrip insight={insight} />

      {/* The chart carries the four KPIs in its own header now, so this row is
          "how it is going" beside "what needs doing". On a phone the queue comes
          first: what needs answering beats what the trend looks like when you
          are standing on a tram. */}
      {/* Every row below is a *pair* of cards that stretch to a shared height,
          so the page reads as a grid of aligned edges rather than a ragged pile.
          Stacking three short cards beside one tall one — which is what this was
          — left a 240px hole under the shorter column, and no amount of
          `items-start` fixes that: it just moves the hole. Pairing widgets of
          similar weight makes the heights match on their own, and `h-full`
          absorbs whatever slack is left inside the shorter card. */}
      <div className="grid gap-(--grid-gap) lg:grid-cols-[1.85fr_1fr]">
        {/* `grid` on the wrapper, not `flex`: a lone grid child stretches on
            both axes, where a row-direction flex child would fill the height and
            then shrink to its content width. */}
        <div className="order-2 grid lg:order-1">
          <ReputationCard
            series={series}
            range={window.range}
            average={kpis.rating.value}
            kpis={kpis}
          />
        </div>

        <div className="order-1 grid lg:order-2">
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

      {/* What customers said — one card, three cuts of the same period, switched
          client-side. All three panels ship with the page, so the strip costs a
          CSS change rather than a round trip. */}
      <div className="grid gap-(--grid-gap) lg:grid-cols-[1.35fr_1fr]">
        <BreakdownCard
          themes={computeThemes(facts)}
          sentiment={computeSentiment(facts)}
          buckets={computeRatingDistribution(facts)}
          sources={computeSources(facts)}
        />

        <ResponseTime times={computeResponseTimes(facts)} />
      </div>

      {/* Activity is a full-width strip, not a column. It is a ticker — four
          short events read across in one line — and stacking it in a third of
          the width turned every entry into three wrapped lines. */}
      <Suspense fallback={<ActivityFeedSkeleton />}>
        <ActivitySection
          organizationId={organizationId}
          userId={userId}
          locationId={locationId}
          window={window}
        />
      </Suspense>
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

/** The same five blocks in the same places, so nothing jumps when data lands. */
export function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-(--grid-gap)">
      <div className="h-[74px] animate-pulse rounded-lg bg-muted" aria-hidden />
      <div className="grid gap-(--grid-gap) lg:grid-cols-[1.85fr_1fr]">
        <ReputationCardSkeleton />
        <NeedsAttentionSkeleton />
      </div>
      <div className="grid gap-(--grid-gap) lg:grid-cols-[1.35fr_1fr]">
        <div className="h-72 animate-pulse rounded-lg bg-muted" aria-hidden />
        <div className="h-72 animate-pulse rounded-lg bg-muted" aria-hidden />
      </div>
      <ActivityFeedSkeleton />
    </div>
  );
}
