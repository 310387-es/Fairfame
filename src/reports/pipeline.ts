import { and, eq, inArray } from "drizzle-orm";
import { resolveLocationScope, withinScope } from "../auth/scope.ts";
import type { Role } from "../auth/permissions.ts";
import { getAdminDb, schema } from "../db/client.ts";
import type { RangeWindow } from "../dashboard/range.ts";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "../i18n/config.ts";
import { loadInsightFacts, type InsightFacts } from "../analytics/facts.ts";
import {
  compareBy,
  themeTrends,
  type Comparison,
  type GroupComparison,
} from "../analytics/trends.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { dashboardUrl } from "../lib/urls.ts";
import { getEmailTransport, type EmailTransport } from "../messaging/email.ts";
import { renderReportEmail } from "../messaging/templates.ts";
import { ANALYZE_PROMPT_ID } from "../prompts/index.ts";
import { reportCopy } from "./copy.ts";
import { renderReportPdf, type ReportContent, type ReportTable } from "./document.ts";
import { completedPeriod, isPeriodDue, type Cadence, type ReportPeriod } from "./period.ts";

/**
 * Composing, rendering and mailing a scheduled report (P3-T5).
 *
 * Three rules, and the first two are what make the sweep safe to run as often
 * as it likes:
 *
 *   1. **Idempotency is a row, not a timer.** `report_deliveries` is keyed by
 *      `(schedule, period)`, so a sweep that fires hourly, or catches up after
 *      a day of downtime, still sends exactly one report per period. Nothing
 *      here reasons about "when did we last send".
 *   2. **Scope is resolved at send time**, from the recipient's own location
 *      scope. A schedule created when somebody could see three branches must
 *      not keep mailing three branches after they are moved to one — the row
 *      records *what they asked for*, never *what they may see*.
 *   3. **The numbers are the Insights page's numbers**, from the same loader
 *      and the same pure aggregates. A PDF that disagreed with the screen would
 *      make both untrustworthy, and there is no second query here to drift.
 *
 * The read, the render and the send are bracketed rather than wrapped: an open
 * transaction held across a PDF render and an SMTP call is a database lock
 * waiting on a network timeout.
 */

const log = childLogger({ module: "reports/pipeline" });

/** Reports handled per sweep. A week's worth for one tenant is far fewer. */
const DEFAULT_LIMIT = 50;

export type ReportRunResult = {
  sent: number;
  failed: number;
  /** Skipped because the ledger already had this period. */
  skipped: number;
};

function localeOf(value: string | null): Locale {
  return (LOCALES as readonly string[]).includes(value ?? "") ? (value as Locale) : DEFAULT_LOCALE;
}

type DueSchedule = {
  scheduleId: string;
  userId: string;
  userEmail: string;
  userName: string | null;
  userLocale: Locale;
  role: Role;
  locationId: string | null;
  cadence: Cadence;
  organizationName: string;
};

/**
 * Enabled schedules whose period has closed.
 *
 * The membership join is not decoration: a schedule belonging to somebody who
 * has left the organization stops sending, because there is no membership left
 * to resolve their location scope from — and mailing a business's numbers to a
 * former member is exactly the leak scope resolution exists to prevent.
 */
async function dueSchedules(
  tx: TenantDatabase,
  organizationId: string,
  now: Date,
  limit: number,
): Promise<DueSchedule[]> {
  const rows = await tx
    .select({
      scheduleId: schema.reportSchedules.id,
      userId: schema.reportSchedules.userId,
      userEmail: schema.users.email,
      userName: schema.users.name,
      userLocale: schema.users.locale,
      role: schema.memberships.role,
      locationId: schema.reportSchedules.locationId,
      cadence: schema.reportSchedules.cadence,
      organizationName: schema.organizations.name,
    })
    .from(schema.reportSchedules)
    .innerJoin(schema.users, eq(schema.users.id, schema.reportSchedules.userId))
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.reportSchedules.organizationId),
    )
    .innerJoin(
      schema.memberships,
      and(
        eq(schema.memberships.userId, schema.reportSchedules.userId),
        eq(schema.memberships.organizationId, schema.reportSchedules.organizationId),
      ),
    )
    .where(
      and(
        eq(schema.reportSchedules.organizationId, organizationId),
        eq(schema.reportSchedules.enabled, true),
      ),
    )
    .limit(limit);

  return rows
    .map((row) => ({
      ...row,
      userLocale: localeOf(row.userLocale),
      cadence: row.cadence as Cadence,
      role: row.role as Role,
    }))
    .filter((row) => isPeriodDue(completedPeriod(row.cadence, now), now));
}

/** Schedules already delivered for the period they are currently due for. */
async function alreadyDelivered(
  tx: TenantDatabase,
  schedules: DueSchedule[],
  now: Date,
): Promise<Set<string>> {
  if (schedules.length === 0) return new Set();

  const rows = await tx
    .select({
      scheduleId: schema.reportDeliveries.scheduleId,
      periodStart: schema.reportDeliveries.periodStart,
    })
    .from(schema.reportDeliveries)
    .where(
      inArray(
        schema.reportDeliveries.scheduleId,
        schedules.map((schedule) => schedule.scheduleId),
      ),
    );

  const cadenceOf = new Map(schedules.map((s) => [s.scheduleId, s.cadence]));
  const done = new Set<string>();

  for (const row of rows) {
    const cadence = cadenceOf.get(row.scheduleId);
    if (!cadence) continue;
    // Only a row for *this* period counts. An older one is history.
    if (row.periodStart.getTime() === completedPeriod(cadence, now).start.getTime()) {
      done.add(row.scheduleId);
    }
  }

  return done;
}

/** The report's window in the shape the Insights loader and aggregates expect. */
function windowOf(period: ReportPeriod): RangeWindow {
  return {
    // The aggregates only read `days`, `start`, `end` and `previous`; `range`
    // is the dashboard's URL vocabulary and has no meaning for a report.
    range: "30d",
    days: Math.round((period.end.getTime() - period.start.getTime()) / 86_400_000),
    start: period.start,
    end: period.end,
    previous: period.previous,
  };
}

type Prepared = {
  schedule: DueSchedule;
  facts: InsightFacts;
  names: Map<string, string>;
  period: ReportPeriod;
};

/**
 * The locations a member may see, read here rather than through
 * `lib/active-location.ts`.
 *
 * **That module imports `next/headers`**, because its other job is reading the
 * active-location cookie — and this file is imported by the BullMQ worker,
 * which is a plain Node process with no Next runtime. Importing it crashed the
 * worker at startup with `ERR_MODULE_NOT_FOUND: next/headers`, and no unit or
 * DB test could see it because Vitest resolves the module perfectly well.
 *
 * The same shape of rule `CLAUDE.md` states for client components, in the other
 * direction: **a worker module must not import anything that reaches a request
 * API.** The scope logic itself (`src/auth/scope.ts`) is free of it, so only
 * the query needed restating.
 */
async function visibleLocations(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
  role: Role,
): Promise<{ id: string; name: string }[]> {
  const scope = await resolveLocationScope(tx, organizationId, userId, role);

  const rows = await tx
    .select({ id: schema.locations.id, name: schema.locations.name })
    .from(schema.locations)
    .where(eq(schema.locations.organizationId, organizationId));

  return rows.filter((row) => withinScope(scope, row.id));
}

/** Everything one report needs, read inside the tenant transaction. */
async function prepare(
  tx: TenantDatabase,
  organizationId: string,
  schedule: DueSchedule,
  now: Date,
): Promise<Prepared> {
  // The recipient's scope *now*, not what it was when they subscribed.
  const visible = await visibleLocations(tx, organizationId, schedule.userId, schedule.role);

  // A schedule naming a branch the member can no longer see resolves to no
  // locations, and the report goes out empty rather than out of scope.
  const locations = schedule.locationId
    ? visible.filter((location) => location.id === schedule.locationId)
    : visible;

  const period = completedPeriod(schedule.cadence, now);

  return {
    schedule,
    period,
    names: new Map(locations.map((location) => [location.id, location.name])),
    facts: await loadInsightFacts(
      tx,
      organizationId,
      locations.map((location) => location.id),
      windowOf(period),
      ANALYZE_PROMPT_ID,
    ),
  };
}

type Composed = {
  content: ReportContent;
  reviewCount: number;
  averageRating: string | null;
  repliedShare: string | null;
};

/** The tables and figures, from the Insights aggregates and nothing else. */
export function composeReport(
  facts: InsightFacts,
  options: {
    locale: Locale;
    title: string;
    period: ReportPeriod;
    cadence: Cadence;
    locationName: (id: string) => string;
    generatedAt: Date;
  },
): Composed {
  const copy = reportCopy(options.locale);
  const { current, previous } = facts;

  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(options.locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);

  const percent = (value: number) =>
    new Intl.NumberFormat(options.locale, { style: "percent" }).format(value);

  const signed = (value: number, digits: number) =>
    `${value > 0 ? "+" : value < 0 ? "−" : ""}${number(Math.abs(value), digits)}`;

  // One group covering everything in scope — the headline figures are the same
  // aggregate the tables use, grouped by a constant.
  const whole = compareBy(current, previous, () => "all")[0];

  const metric = (
    label: string,
    comparison: Comparison | undefined,
    render: (value: number) => string,
    /**
     * How the *change* reads, which is not always how the value reads. A
     * response rate of 0.82 shows as "82%", but its change of -0.03 shown the
     * same way is "-3%" — which is right — while `signed(…, 2)` would print
     * "−0,03" and mean nothing to anyone.
     */
    renderDelta: (value: number) => string,
  ) => ({
    label,
    // A dash, not a zero — see `insights/trends.ts`.
    value: comparison?.value == null ? null : render(comparison.value),
    delta: comparison?.delta == null ? null : renderDelta(comparison.delta),
    direction:
      comparison?.delta == null
        ? null
        : comparison.delta > 0
          ? ("up" as const)
          : comparison.delta < 0
            ? ("down" as const)
            : ("flat" as const),
  });

  const measureColumns = [
    copy.column.rating,
    copy.column.sentiment,
    copy.column.volume,
    copy.column.replied,
  ];

  const groupTable = (
    title: string,
    groups: GroupComparison[],
    label: (key: string) => string,
    keyColumn: string,
  ): ReportTable => ({
    title,
    columns: [keyColumn, ...measureColumns],
    rows: groups.map((group) => ({
      key: group.key,
      label: label(group.key),
      cells: [
        group.rating.value === null ? null : number(group.rating.value, 1),
        group.sentiment.value === null ? null : number(group.sentiment.value, 2),
        number(group.volume.value ?? 0, 0),
        group.responseRate.value === null ? null : percent(group.responseRate.value),
      ],
    })),
    empty: copy.empty,
  });

  const themes = themeTrends(current, previous, windowOf(options.period));

  return {
    content: {
      title: options.title,
      subtitle: `${copy.periodLabel(options.period.start, options.period.end)} · ${copy.cadence[options.cadence]}`,
      metrics: [
        metric(
          copy.column.volume,
          whole?.volume,
          (value) => number(value, 0),
          (value) => signed(value, 0),
        ),
        metric(
          copy.column.rating,
          whole?.rating,
          (value) => number(value, 1),
          (value) => signed(value, 1),
        ),
        metric(
          copy.column.sentiment,
          whole?.sentiment,
          (value) => number(value, 2),
          (value) => signed(value, 2),
        ),
        metric(copy.column.replied, whole?.responseRate, percent, (value) =>
          value > 0 ? `+${percent(value)}` : percent(value),
        ),
      ],
      tables: [
        groupTable(
          copy.byLocation,
          compareBy(current, previous, (fact) => fact.locationId),
          options.locationName,
          copy.column.location,
        ),
        groupTable(
          copy.bySource,
          compareBy(current, previous, (fact) => fact.source),
          (key) => key.charAt(0).toUpperCase() + key.slice(1),
          copy.column.source,
        ),
        {
          title: copy.themes,
          columns: [copy.column.theme, copy.column.mentions, copy.column.change],
          rows: themes.map((theme) => ({
            key: theme.theme,
            label: theme.theme,
            cells: [
              number(theme.count, 0),
              // "new" rather than a percentage: everything is up infinitely
              // from a base of nothing.
              theme.delta === null ? copy.themeNew : `${signed(theme.delta, 0)}%`,
            ],
          })),
          empty: copy.empty,
        },
      ],
      footer: copy.footer(options.generatedAt),
      pageLabel: copy.pageLabel,
    },
    reviewCount: current.length,
    averageRating: whole?.rating.value == null ? null : number(whole.rating.value, 1),
    repliedShare: whole?.responseRate.value == null ? null : percent(whole.responseRate.value),
  };
}

/**
 * Runs every due report for one organization.
 *
 * Per organization rather than globally, like the digest sweep: the tenant
 * transaction is the unit of isolation, and one tenant's failed render must not
 * abandon another's report.
 */
export async function runScheduledReports(
  organizationId: string,
  options: { now?: Date; limit?: number; transport?: EmailTransport } = {},
): Promise<ReportRunResult> {
  const now = options.now ?? new Date();
  const transport = options.transport ?? getEmailTransport();
  const result: ReportRunResult = { sent: 0, failed: 0, skipped: 0 };

  const work = await withTenant({ organizationId }, async (tx) => {
    const due = await dueSchedules(tx, organizationId, now, options.limit ?? DEFAULT_LIMIT);
    if (due.length === 0) return [];

    const delivered = await alreadyDelivered(tx, due, now);
    const pending = due.filter((schedule) => !delivered.has(schedule.scheduleId));
    result.skipped = due.length - pending.length;

    const prepared: Prepared[] = [];
    for (const schedule of pending) {
      prepared.push(await prepare(tx, organizationId, schedule, now));
    }
    return prepared;
  });

  for (const { schedule, facts, names, period } of work) {
    const branch = schedule.locationId ? names.get(schedule.locationId) : null;
    const scopeName = branch
      ? `${schedule.organizationName} — ${branch}`
      : schedule.organizationName;

    try {
      const composed = composeReport(facts, {
        locale: schedule.userLocale,
        title: scopeName,
        period,
        cadence: schedule.cadence,
        locationName: (id) => names.get(id) ?? id,
        generatedAt: now,
      });

      const copy = reportCopy(schedule.userLocale);
      const filename = copy.filename(scopeName, period.start);
      const pdf = await renderReportPdf(composed.content);

      const email = renderReportEmail({
        locale: schedule.userLocale,
        recipientName: schedule.userName,
        scopeName,
        period: copy.periodLabel(period.start, period.end),
        cadence: schedule.cadence,
        reviewCount: composed.reviewCount,
        averageRating: composed.averageRating,
        repliedShare: composed.repliedShare,
        link: dashboardUrl("/analytics"),
        settingsUrl: dashboardUrl("/analytics"),
        attachmentName: filename,
      });

      const outcome = await transport.send({
        to: schedule.userEmail,
        subject: email.subject,
        text: email.text,
        html: email.html,
        attachments: [{ filename, contentType: "application/pdf", content: pdf }],
      });

      await recordDelivery(organizationId, schedule.scheduleId, period.start, outcome, now);
      if (outcome.ok) result.sent += 1;
      else result.failed += 1;
    } catch (error) {
      // A render failure is recorded like a send failure: the ledger's job is
      // to say what happened to this period, not only what the SMTP server said.
      log.error({ err: error, scheduleId: schedule.scheduleId }, "Report failed");
      await recordDelivery(
        organizationId,
        schedule.scheduleId,
        period.start,
        { ok: false, reason: error instanceof Error ? error.message : "Unknown failure." },
        now,
      );
      result.failed += 1;
    }
  }

  return result;
}

/**
 * The ledger write.
 *
 * Upsert rather than insert: a failed attempt leaves a row, and a later sweep
 * that succeeds should turn it into a sent one rather than throw on the unique
 * key. The owner connection, because this runs outside the tenant transaction
 * that the send was bracketed by — the same shape `notifications/email.ts` uses.
 */
async function recordDelivery(
  organizationId: string,
  scheduleId: string,
  periodStart: Date,
  outcome: { ok: true } | { ok: false; reason: string },
  now: Date,
): Promise<void> {
  const row = {
    status: outcome.ok ? ("sent" as const) : ("failed" as const),
    error: outcome.ok ? null : outcome.reason.slice(0, 500),
    sentAt: outcome.ok ? now : null,
  };

  await getAdminDb()
    .insert(schema.reportDeliveries)
    .values({ organizationId, scheduleId, periodStart, ...row })
    .onConflictDoUpdate({
      target: [schema.reportDeliveries.scheduleId, schema.reportDeliveries.periodStart],
      set: { ...row, updatedAt: now },
    });
}
