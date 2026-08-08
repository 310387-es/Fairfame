import { sourceLabel } from "@/connectors/source-label";
import { BarChart3, Building2, Radio, Sparkles, Users } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { themeLabel } from "@/reviews/taxonomy";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { SectionCard } from "@/components/ds/section-card";
import { ChartFallback } from "@/components/dashboard/chart-fallback";
import { RangeToggle } from "@/components/dashboard/range-toggle";
import {
  ComparisonTable,
  toComparisonRow,
  type ComparisonRow,
} from "@/components/analytics/comparison-table";
import { ExportMenu } from "@/components/analytics/export-menu";
import { BenchmarkCard } from "@/components/analytics/benchmark-card";
import { ALL_BRANCHES, ReportSchedule } from "@/components/analytics/report-schedule";
import { StaffPanel } from "@/components/analytics/staff-panel";
import { ReportSheet } from "@/components/analytics/report-sheet";
import { ThemeHeatmapCard } from "@/components/analytics/theme-heatmap";
import {
  RatingHistogram,
  ResponsePercentilesCard,
} from "@/components/analytics/rating-percentiles";
import { ThemeTrends } from "@/components/analytics/theme-trends";
import { TrendChart, type TrendChartPoint } from "@/components/analytics/trend-chart";
import { PageHeader } from "@/components/shell/page-header";
import { parseRange, rangeWindow } from "@/dashboard/range";
import { EXPORT_KINDS } from "@/analytics/export";
import { loadInsightFacts } from "@/analytics/facts";
import {
  compareBy,
  ratingHistogram,
  ratingTrend,
  responsePercentiles,
  sentimentMix,
  sentimentTrend,
  staffMentions,
  themeHeatmap,
  themeTrends,
  type TrendPoint,
  volumeTrend,
} from "@/analytics/trends";
import { listLocationsForActor } from "@/lib/active-location";
import { loadBenchmark } from "@/competitors/benchmark";
import { can } from "@/lib/entitlements";
import { SurveyScoreCard } from "@/components/analytics/survey-score-card";
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

  // Bound on its own line: `pnpm check:i18n` reads these bindings to know which
  // namespace a call belongs to, and it cannot see through array destructuring.
  const tThemes = await getTranslations("themes");
  // The dashboard's own sentiment wording, reused rather than restated: the
  // comparison rows and the Home breakdown describe the same split, and two
  // phrasings of one fact is how a screen starts contradicting itself.
  const tSentiment = await getTranslations("home.sentiment");

  /** A share of the analysed reviews, as the bar's label says it. */
  const sentimentShare = (mix: { analysed: number }, count: number) =>
    format.number(mix.analysed === 0 ? 0 : count / mix.analysed, {
      style: "percent",
      maximumFractionDigits: 0,
    });

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

  /** A 0–100 share, written as a percentage — the sentiment line's unit. */
  const share = (value: number) =>
    format.number(value / 100, { style: "percent", maximumFractionDigits: 0 });

  const signed = (value: number, digits: number) =>
    `${value > 0 ? "+" : value < 0 ? "−" : ""}${number(Math.abs(value), digits)}`;

  const delta = (value: number, unit: "rating" | "sentiment" | "count" | "percent") => {
    if (unit === "count") return signed(value, 0);
    // Percentage *points*, not points: the response rate is already a
    // percentage, so "+4 pts" would read as a relative rise on top of it
    // (W3.3). Plain points belong to the 0–100 reputation score, which lives on
    // the dashboard rather than here — so this page has no use for that word.
    if (unit === "percent") return `${signed(value * 100, 0)} ${t("percentagePoints")}`;
    // Sentiment is a *share* now, so its change is percentage points too —
    // the same unit, and the same word, as the response rate beside it.
    if (unit === "sentiment") return `${signed(value, 0)} ${t("percentagePoints")}`;
    return signed(value, 1);
  };

  // ---------------------------------------------------------------------
  // The numbers
  // ---------------------------------------------------------------------
  const rating = ratingTrend(current, previous, window);
  const sentiment = sentimentTrend(current, previous, window);
  const volume = volumeTrend(current, window);
  const themes = themeTrends(current, previous, window);
  const heatmap = themeHeatmap(current, window);
  const histogram = ratingHistogram(current);
  const percentiles = responsePercentiles(current);

  /**
   * A canonical key in the reader's language (W3.2).
   *
   * The whole reason the taxonomy exists: `wait_time` counted from a Turkish
   * review and an English one is one line on this chart, readable by whoever
   * is looking. A key from a newer revision than this build's catalogue falls
   * back to itself rather than rendering `themes.foo`.
   */
  const label = (key: string) => themeLabel(key, tThemes);
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
        // The split, not the signed average (W3.3).
        sentiment: (mix) =>
          mix.analysed === 0
            ? null
            : {
                positive: mix.positive,
                neutral: mix.neutral,
                negative: mix.negative,
                srLabel: [
                  tSentiment("positive", { percent: sentimentShare(mix, mix.positive) }),
                  tSentiment("neutral", { percent: sentimentShare(mix, mix.neutral) }),
                  tSentiment("negative", { percent: sentimentShare(mix, mix.negative) }),
                ].join(", "),
              },
        volume: (value) => number(value, 0),
        percent,
        delta,
      }),
  );

  const sourceRows: ComparisonRow[] = compareBy(current, previous, (fact) => fact.source).map(
    (group) =>
      toComparisonRow(group, sourceLabel(group.key), {
        rating: (value) => number(value, 1),
        // The split, not the signed average (W3.3).
        sentiment: (mix) =>
          mix.analysed === 0
            ? null
            : {
                positive: mix.positive,
                neutral: mix.neutral,
                negative: mix.negative,
                srLabel: [
                  tSentiment("positive", { percent: sentimentShare(mix, mix.positive) }),
                  tSentiment("neutral", { percent: sentimentShare(mix, mix.neutral) }),
                  tSentiment("negative", { percent: sentimentShare(mix, mix.negative) }),
                ].join(", "),
              },
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
          /*
            Export and Schedule, side by side (W4.4).

            The two things you do with these numbers once you have read them:
            take them now, or have them sent. The schedule used to be a card
            between the competitor benchmark and the staff panel — a *setting*
            filed among *findings* — and moving it here is what
            `docs/remediation-plan.md` means by a header split button.
          */
          <div className="flex items-center gap-2">
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

            <ReportSheet label={t("report.action")} title={t("report.title")}>
              <ReportSchedule
                enabled={schedule?.enabled ?? false}
                cadence={schedule?.cadence ?? "weekly"}
                locationId={schedule?.locationId ?? ALL_BRANCHES}
                locations={locations.map(({ id, name }) => ({ id, name }))}
                locked={canSchedule ? null : t("report.locked")}
                bare
              />
            </ReportSheet>
          </div>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeToggle active={range} basePath="/analytics" />
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
            {/*
              The **positive share**, 0–100%, not a signed score on a −1…1 axis
              (W3.3). Same quantity the split bars below draw, so the line and
              the bars agree by construction rather than by coincidence — and
              "seven in ten wrote something positive" is a sentence an owner
              already owns, where "−0,24" is a scale nobody outside this
              codebase has seen.
            */}
            {trend("sentiment", sentiment, (value) => share(value), {
              domain: [0, 100],
              ticks: [0, 50, 100],
              tickRender: (value) => share(value),
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
            themeLabel={label}
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

          {/*
            The signature view, and it sits *after* the theme list on purpose:
            the list answers "what moved", which is what somebody scanning
            wants first, and the grid answers "when" — the follow-up question,
            and the one worth scrolling for.
          */}
          <ThemeHeatmapCard heatmap={heatmap} themeLabel={label} />

          {/* The two shapes a single number hides: how the stars are spread,
              and where the response-time tail is. */}
          <div className="grid gap-(--grid-gap) lg:grid-cols-2">
            <RatingHistogram bars={histogram} />
            <ResponsePercentilesCard times={percentiles} />
          </div>

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
