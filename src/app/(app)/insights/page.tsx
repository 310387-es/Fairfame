import { BarChart3, Building2, Radio, Sparkles, Users } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { SectionCard } from "@/components/ds/section-card";
import { ChartFallback } from "@/components/home/chart-fallback";
import { RangeToggle } from "@/components/home/range-toggle";
import {
  ComparisonTable,
  toComparisonRow,
  type ComparisonRow,
} from "@/components/insights/comparison-table";
import { ExportMenu } from "@/components/insights/export-menu";
import { BenchmarkCard } from "@/components/insights/benchmark-card";
import { ALL_BRANCHES, ReportSchedule } from "@/components/insights/report-schedule";
import { StaffPanel } from "@/components/insights/staff-panel";
import { ThemeTrends } from "@/components/insights/theme-trends";
import { TrendChart, type TrendChartPoint } from "@/components/insights/trend-chart";
import { PageHeader } from "@/components/shell/page-header";
import { parseRange, rangeWindow } from "@/dashboard/range";
import { EXPORT_KINDS } from "@/insights/export";
import { loadInsightFacts } from "@/insights/facts";
import {
  compareBy,
  ratingTrend,
  sentimentMix,
  sentimentTrend,
  staffMentions,
  themeTrends,
  volumeTrend,
  type TrendPoint,
} from "@/insights/trends";
import { listLocationsForActor } from "@/lib/active-location";
import { loadBenchmark } from "@/competitors/benchmark";
import { can } from "@/lib/entitlements";
import { SurveyScoreCard } from "@/components/insights/survey-score-card";
import { loadSurveyInsights } from "@/surveys/insights";
import { headline, MIN_MEANINGFUL_RESPONSES } from "@/surveys/scoring";
import { getSchedule } from "@/reports/store";
import { withTenant } from "@/lib/tenancy";
import { ANALYZE_PROMPT_ID } from "@/prompts";

/**
 * Insights (P3-T4): are we improving, where, and driven by what.
 *
 * Three questions, and the page is laid out as their answers in that order —
 * the trends say *whether*, the comparison tables say *where*, and the themes
 * and names say *what*. Home answers "what needs doing today" for one branch;
 * this answers "what is happening to us" across all of them, which is why it
 * loads every location the member may see rather than the active one.
 *
 * Every number comes from `src/insights/trends.ts`, which is pure and tested.
 * Nothing is computed in this file: a figure derived in a component is a figure
 * with no test, and each of these is something a business might act on.
 *
 * **The location scope is the member's, from `src/auth/scope.ts`.** A manager
 * limited to one branch must not be able to read the whole chain's numbers by
 * opening a page that forgot to ask — so the facts loader takes the resolved
 * list and returns nothing for an empty one, rather than treating "no scope" as
 * "no filter".
 */

type PageProps = { searchParams: Promise<{ range?: string }> };

export default async function InsightsPage({ searchParams }: PageProps) {
  const [query, actor, t, format] = await Promise.all([
    searchParams,
    requireActor(),
    getTranslations("insights"),
    getFormatter(),
  ]);

  const range = parseRange(query.range);
  const window = rangeWindow(range, new Date());

  const {
    facts,
    locations,
    schedule,
    canAnalytics,
    canSchedule,
    canBenchmark,
    canSurveys,
    surveyScores,
    benchmark,
  } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const locations = await listLocationsForActor(tx, actor);

      return {
        locations,
        // The caller's own schedule, if they have one. There is no shared
        // schedule to read — a report is addressed to a person.
        schedule: await getSchedule(tx, actor.organizationId, actor.userId, null),
        // The page itself, not a panel on it. Read alongside everything else so
        // there is one round trip, and rendered as a locked card rather than a
        // redirect: "not on your plan" is information, and a bounce to Home is
        // a mystery.
        canAnalytics: await can({ organizationId: actor.organizationId, tx }, "analytics"),
        canSchedule: await can({ organizationId: actor.organizationId, tx }, "scheduled_reports"),
        canBenchmark: await can({ organizationId: actor.organizationId, tx }, "benchmarking"),
        // Gated on `surveys` *and* on `analytics` above: the card lives inside
        // the Insights workspace, and a panel that answered when the workspace
        // around it would not is a way to read a paid feature by URL.
        canSurveys: await can({ organizationId: actor.organizationId, tx }, "surveys"),
        surveyScores: await loadSurveyInsights(
          tx,
          actor.organizationId,
          locations.map((location) => location.id),
          window,
        ),
        // Lifetime, not the selected range — a listing shows an all-time
        // rating, so the two halves have to be measured the same way.
        benchmark: await loadBenchmark(
          tx,
          actor.organizationId,
          locations.map((location) => location.id),
        ),
        facts: await loadInsightFacts(
          tx,
          actor.organizationId,
          locations.map((location) => location.id),
          window,
          ANALYZE_PROMPT_ID,
        ),
      };
    },
  );

  const { current, previous } = facts;

  // ---------------------------------------------------------------------
  // Formatting. Done once, on the server, so no component re-derives a locale.
  // ---------------------------------------------------------------------
  const number = (value: number, digits: number) =>
    format.number(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });

  const percent = (value: number) => format.number(value, { style: "percent" });

  // A weekly bucket is labelled by the week it starts, which is what "1 Aug"
  // means on a 13-point line — the axis is too narrow for a range and a reader
  // comparing three charts needs the same tick on all of them.
  const bucketLabel = (point: TrendPoint) =>
    format.dateTime(point.start, { day: "numeric", month: "short" });

  const toChartPoints = (points: TrendPoint[], render: (value: number) => string) =>
    points.map<TrendChartPoint>((point) => ({
      label: bucketLabel(point),
      value: point.value,
      // Formatted here, because a formatter function cannot cross into a client
      // component — see the note in `TrendChart`.
      display: point.value === null ? null : render(point.value),
      count: point.count,
    }));

  /** Axis ticks and their labels, prepared server-side for the same reason. */
  const axis = (values: number[], render: (value: number) => string) => ({
    ticks: values,
    tickLabels: Object.fromEntries(values.map((value) => [String(value), render(value)])),
  });

  const signed = (value: number, digits: number) =>
    `${value > 0 ? "+" : value < 0 ? "−" : ""}${number(Math.abs(value), digits)}`;

  const delta = (value: number, unit: "rating" | "sentiment" | "count" | "percent") => {
    if (unit === "count") return signed(value, 0);
    if (unit === "percent") return `${signed(value * 100, 0)} ${t("points")}`;
    return signed(value, unit === "sentiment" ? 2 : 1);
  };

  // ---------------------------------------------------------------------
  // The numbers
  // ---------------------------------------------------------------------
  const rating = ratingTrend(current, previous, window);
  const sentiment = sentimentTrend(current, previous, window);
  const volume = volumeTrend(current, window);
  const themes = themeTrends(current, previous, window);
  const mix = sentimentMix(current);
  const staff = staffMentions(current);

  // Bars are drawn against the busiest row, not against the total: with twelve
  // themes every bar would be a sliver and the panel would read as noise.
  const themeShare = Math.max(0, ...themes.map((theme) => theme.count));
  const staffTop = Math.max(0, ...staff.people.map((person) => person.count));

  const locationName = new Map(locations.map((location) => [location.id, location.name]));

  const locationRows: ComparisonRow[] = compareBy(current, previous, (fact) => fact.locationId).map(
    (group) =>
      toComparisonRow(group, locationName.get(group.key) ?? t("unknownLocation"), {
        rating: (value) => number(value, 1),
        sentiment: (value) => number(value, 2),
        volume: (value) => number(value, 0),
        percent,
        delta,
      }),
  );

  const sourceRows: ComparisonRow[] = compareBy(current, previous, (fact) => fact.source).map(
    (group) =>
      toComparisonRow(group, group.key.charAt(0).toUpperCase() + group.key.slice(1), {
        rating: (value) => number(value, 1),
        sentiment: (value) => number(value, 2),
        volume: (value) => number(value, 0),
        percent,
        delta,
      }),
  );

  const measureColumns = [
    t("column.rating"),
    t("column.sentiment"),
    t("column.volume"),
    t("column.replied"),
  ];

  /** A trend card: the chart, and the same series as a table for a reader. */
  const trend = (
    key: "rating" | "sentiment" | "volume",
    points: TrendPoint[],
    render: (value: number) => string,
    scale?: {
      domain: [number, number];
      ticks: number[];
      /** Axis labels are terser than the tooltip's: an axis has 40px, not a row. */
      tickRender?: (value: number) => string;
    },
  ) => (
    <SectionCard title={t(`trend.${key}`)} icon={BarChart3}>
      <div className="pb-(--card-py)">
        <TrendChart
          points={toChartPoints(points, render)}
          domain={scale?.domain}
          {...(scale ? axis(scale.ticks, scale.tickRender ?? render) : {})}
          tooltipLabel={t(`trend.${key}`)}
        />
        <ChartFallback
          caption={t("trendCaption", { measure: t(`trend.${key}`) })}
          // The volume trend's value *is* the count, so it gets two columns
          // rather than the same number twice under two headings — which is
          // also a duplicate React key, and how the browser found this.
          columns={
            key === "volume"
              ? [t("column.period"), t("trend.volume")]
              : [t("column.period"), t(`trend.${key}`), t("column.volume")]
          }
          rows={points.map((point) => ({
            key: point.start.toISOString(),
            cells:
              key === "volume"
                ? [bucketLabel(point), number(point.count, 0)]
                : [
                    bucketLabel(point),
                    point.value === null ? t("noValue") : render(point.value),
                    number(point.count, 0),
                  ],
          }))}
        />
      </div>
    </SectionCard>
  );

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <ExportMenu
            range={range}
            label={t("export")}
            kinds={EXPORT_KINDS}
            pdfLabel={t("exportKind.pdf")}
            labels={{
              everything: t("exportKind.everything"),
              themes: t("exportKind.themes"),
              locations: t("exportKind.locations"),
              sources: t("exportKind.sources"),
              staff: t("exportKind.staff"),
            }}
          />
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeToggle active={range} basePath="/insights" />
        <p className="text-meta text-faint">
          {t("summary", { reviews: current.length, locations: locations.length })}
          {mix.pending > 0 ? ` · ${t("pendingAnalysis", { count: mix.pending })}` : ""}
        </p>
      </div>

      {!canAnalytics ? (
        <SectionCard title={t("locked.title")} icon={BarChart3}>
          <p className="pb-(--card-py) text-body text-ink-400">{t("locked.body")}</p>
        </SectionCard>
      ) : current.length === 0 ? (
        <SectionCard title={t("empty.title")} icon={BarChart3}>
          <p className="pb-(--card-py) text-body text-ink-400">{t("empty.body")}</p>
        </SectionCard>
      ) : (
        <>
          {/* Are we improving? Three measures, same buckets, read together. */}
          <div className="grid gap-(--grid-gap) lg:grid-cols-3">
            {trend("rating", rating, (value) => number(value, 1), {
              domain: [1, 5],
              ticks: [1, 2, 3, 4, 5],
              tickRender: (value) => number(value, 0),
            })}
            {trend("sentiment", sentiment, (value) => number(value, 2), {
              domain: [-1, 1],
              ticks: [-1, 0, 1],
              tickRender: (value) => number(value, 1),
            })}
            {trend("volume", volume, (value) => number(value, 0))}
          </div>

          {/* Where? */}
          <ComparisonTable
            title={t("byLocation")}
            icon={Building2}
            columns={[t("column.location"), ...measureColumns]}
            rows={locationRows}
            empty={t("byLocationEmpty")}
          />

          <ComparisonTable
            title={t("bySource")}
            icon={Radio}
            columns={[t("column.source"), ...measureColumns]}
            rows={sourceRows}
            empty={t("bySourceEmpty")}
          />

          {/* Driven by what? */}
          <ThemeTrends
            title={t("themes")}
            icon={Sparkles}
            empty={t("themesEmpty")}
            newLabel={t("themeNew")}
            columns={[t("column.theme"), t("column.mentions"), t("column.change")]}
            moodLabel={(row) =>
              row.negative > row.positive
                ? t("mostlyNegative", { count: row.negative })
                : row.positive > row.negative
                  ? t("mostlyPositive", { count: row.positive })
                  : t("mixed")
            }
            themes={themes.map((theme) => ({
              theme: theme.theme,
              count: theme.count,
              share: themeShare === 0 ? 0 : theme.count / themeShare,
              delta: theme.delta === null ? null : `${signed(theme.delta, 0)}%`,
              direction:
                theme.delta === null
                  ? null
                  : theme.delta > 0
                    ? "up"
                    : theme.delta < 0
                      ? "down"
                      : "flat",
              positive: theme.positive,
              neutral: theme.neutral,
              negative: theme.negative,
            }))}
          />

          {canSurveys && surveyScores.length > 0 ? (
            <SurveyScoreCard
              title={t("surveys")}
              note={t("surveysNote")}
              thinSample={t("surveysThin", { min: MIN_MEANINGFUL_RESPONSES })}
              rows={surveyScores.map((entry) => {
                const now = headline(entry.current);
                const before = entry.previous ? headline(entry.previous) : null;

                return {
                  type: entry.type,
                  label: entry.type === "nps" ? t("surveyNps") : t("surveyCsat"),
                  // Formatted here, server-side. "—" rather than "0": an NPS of
                  // zero is a real result, so printing it for "nobody answered"
                  // would show a score nobody earned.
                  value: now.value === null ? null : number(now.value, now.digits),
                  responses: entry.current.responses,
                  thin:
                    entry.current.responses > 0 &&
                    entry.current.responses < MIN_MEANINGFUL_RESPONSES,
                  delta:
                    now.value !== null && before?.value != null
                      ? signed(now.value - before.value, now.digits)
                      : null,
                  better:
                    now.value !== null && before?.value != null ? now.value >= before.value : null,
                };
              })}
            />
          ) : null}

          <BenchmarkCard
            rows={benchmark.rows.map((row) => ({
              competitorId: row.competitorId,
              name: row.name,
              theirRating: row.theirRating === null ? null : number(row.theirRating, 1),
              theirReviews: row.theirReviews === null ? null : number(row.theirReviews, 0),
              gap: row.ratingGap === null ? null : signed(row.ratingGap, 1),
              ahead: row.ratingGap === null ? null : row.ratingGap >= 0,
            }))}
            ourRating={benchmark.ourRating === null ? null : number(benchmark.ourRating, 1)}
            ourReviews={number(benchmark.ourReviews, 0)}
            unverified={benchmark.unverified}
            locked={canBenchmark ? null : t("benchmark.locked")}
            canManage={roleAtLeast(actor.role, "admin")}
          />

          <ReportSchedule
            enabled={schedule?.enabled ?? false}
            cadence={schedule?.cadence ?? "weekly"}
            locationId={schedule?.locationId ?? ALL_BRANCHES}
            locations={locations.map(({ id, name }) => ({ id, name }))}
            locked={canSchedule ? null : t("report.locked")}
          />

          <StaffPanel
            title={t("staff")}
            icon={Users}
            note={t("staffNote")}
            empty={t("staffEmpty")}
            notAnalysed={
              staff.notAnalysed > 0 ? t("staffNotAnalysed", { count: staff.notAnalysed }) : null
            }
            moodLabel={(row) =>
              row.negative > row.positive
                ? t("mostlyNegative", { count: row.negative })
                : row.positive > row.negative
                  ? t("mostlyPositive", { count: row.positive })
                  : t("mixed")
            }
            ratingLabel={(rating) => t("ratingShort", { rating })}
            people={staff.people.map((person) => ({
              name: person.name,
              count: number(person.count, 0),
              share: staffTop === 0 ? 0 : person.count / staffTop,
              rating: person.rating === null ? null : number(person.rating, 1),
              positive: person.positive,
              neutral: person.neutral,
              negative: person.negative,
            }))}
          />
        </>
      )}
    </>
  );
}
