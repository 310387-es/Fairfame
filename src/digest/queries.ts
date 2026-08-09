import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { MIN_ANALYSED_REVIEWS } from "./metrics.ts";
import type { DigestPayload } from "./pipeline.ts";

/**
 * Reading digests (P1a-T7).
 *
 * Separate from the pipeline for the same reason `insights.ts` is separate from
 * `analyze.ts`: generation and rendering change for different reasons, and the
 * Home screen (T8) must not import a module that can spend money.
 */

export type DigestActionRow = typeof schema.digestActions.$inferSelect;

export type DigestView = {
  id: string;
  locationId: string;
  periodStart: Date;
  periodEnd: Date;
  status: "pending" | "ready" | "failed";
  pulseScore: number | null;
  pulseDelta: number | null;
  reviewCount: number;
  locale: string | null;
  generatedAt: Date | null;
  payload: DigestPayload | null;
  actions: DigestActionRow[];
};

function toView(row: typeof schema.digests.$inferSelect, actions: DigestActionRow[]): DigestView {
  return {
    id: row.id,
    locationId: row.locationId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    pulseScore: row.pulseScore,
    pulseDelta: row.pulseDelta,
    reviewCount: row.reviewCount,
    locale: row.locale,
    generatedAt: row.generatedAt,
    payload: (row.payload as DigestPayload | null) ?? null,
    actions,
  };
}

/**
 * The newest ready digest for a location — what Home renders.
 *
 * `ready` only: a pending row is a job in flight and a failed one is an
 * incident, and showing either as "your week" would be worse than showing the
 * previous week with its own date on it.
 */
export async function latestDigest(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
): Promise<DigestView | null> {
  const [row] = await tx
    .select()
    .from(schema.digests)
    .where(
      and(
        eq(schema.digests.organizationId, organizationId),
        eq(schema.digests.locationId, locationId),
        eq(schema.digests.status, "ready"),
      ),
    )
    .orderBy(desc(schema.digests.periodStart))
    .limit(1);

  if (!row) return null;

  const actions = await tx
    .select()
    .from(schema.digestActions)
    .where(
      and(
        eq(schema.digestActions.organizationId, organizationId),
        eq(schema.digestActions.digestId, row.id),
      ),
    )
    .orderBy(asc(schema.digestActions.position));

  return toView(row, actions);
}

/**
 * One digest by id — the archive's detail view.
 *
 * Unlike `latestDigest` this accepts any status. The archive is a record of
 * what was composed, and a failed week that silently 404s is worse than one
 * that says it failed: the reader knows a briefing was due and needs to know
 * where it went.
 *
 * Tenant-scoped through `tx` like every other read, so an id guessed from
 * another organization returns null rather than a digest.
 */
export async function digestById(
  tx: TenantDatabase,
  organizationId: string,
  digestId: string,
): Promise<DigestView | null> {
  const [row] = await tx
    .select()
    .from(schema.digests)
    .where(and(eq(schema.digests.organizationId, organizationId), eq(schema.digests.id, digestId)))
    .limit(1);

  if (!row) return null;

  const actions = await tx
    .select()
    .from(schema.digestActions)
    .where(
      and(
        eq(schema.digestActions.organizationId, organizationId),
        eq(schema.digestActions.digestId, row.id),
      ),
    )
    .orderBy(asc(schema.digestActions.position));

  return toView(row, actions);
}

/**
 * How the digest for one week is getting on.
 *
 * `"none"` and `"pending"` are different answers to different questions —
 * nothing has been asked for yet, versus a worker is composing right now — and
 * the Home screen's button needs to tell them apart to know whether to keep
 * watching. `generatedAt` distinguishes a *re*generation that is still running
 * (a previous composition's timestamp, status back to `pending`) from a first
 * one that has never produced anything.
 */
export type DigestProgress = {
  status: "none" | "pending" | "ready" | "failed";
  generatedAt: Date | null;
  /**
   * A refresh of this week is running right now (A22-A1).
   *
   * `status` cannot say it any more, and that is the point: a refresh leaves
   * the published week `ready` throughout, so the button has to ask a separate
   * question to know whether to keep watching.
   */
  refreshing: boolean;
  /** The last refresh did not work. The briefing on screen is the older one. */
  refreshFailed: boolean;
  /**
   * Why, in terms a screen may render.
   *
   * Never the stored string: `refresh_error` holds a provider's own message,
   * which is written for whoever reads the logs and may name a model, a status
   * code or an unterminated JSON body. The two declines are recorded as tokens
   * precisely so they can be told apart from a genuine fault here.
   */
  refreshReason: "no_reviews" | "not_enough_analysed" | "error" | null;
};

function refreshReasonOf(value: string | null): DigestProgress["refreshReason"] {
  if (value === null) return null;
  if (value === "no_reviews" || value === "not_enough_analysed") return value;
  return "error";
}

export async function digestProgress(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  periodStart: Date,
): Promise<DigestProgress> {
  const [row] = await tx
    .select({
      status: schema.digests.status,
      generatedAt: schema.digests.generatedAt,
      refreshStartedAt: schema.digests.refreshStartedAt,
      refreshError: schema.digests.refreshError,
    })
    .from(schema.digests)
    .where(
      and(
        eq(schema.digests.organizationId, organizationId),
        eq(schema.digests.locationId, locationId),
        eq(schema.digests.periodStart, periodStart),
      ),
    )
    .limit(1);

  if (!row) {
    return {
      status: "none",
      generatedAt: null,
      refreshing: false,
      refreshFailed: false,
      refreshReason: null,
    };
  }

  const refreshing = row.refreshStartedAt !== null;
  const refreshFailed = !refreshing && row.refreshError !== null;

  return {
    status: row.status,
    generatedAt: row.generatedAt,
    refreshing,
    refreshFailed,
    refreshReason: refreshFailed ? refreshReasonOf(row.refreshError) : null,
  };
}

/**
 * Whether a window has enough analysed feedback to be worth composing (A22-A1).
 *
 * The compose button used to offer a briefing the pipeline would then decline —
 * a minute of spinner ending in "not enough to draw a plan from", which reads
 * as a broken feature rather than as a quiet week. Asking first turns that into
 * a disabled control with the reason on it.
 *
 * It counts what `gather` gathers and what the pipeline then measures — the
 * same `coalesce(posted_at, created_at)` window and the same "has a sentiment"
 * test — so the two cannot disagree about what a thin week is. It deliberately
 * does *not* try to predict the theme clustering: that needs the vectors, and a
 * button is not the place to spend an embedding call.
 */
export type WindowReadiness = {
  reviewCount: number;
  analysedCount: number;
  /** False when the pipeline would decline this window as an anecdote. */
  enough: boolean;
};

export async function windowReadiness(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  window: { start: Date; end: Date },
): Promise<WindowReadiness> {
  const [row] = await tx
    .select({
      reviewCount: sql<number>`count(*)::int`,
      analysedCount: sql<number>`count(${schema.reviewInsights.sentiment})::int`,
    })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.locationId, locationId),
        gte(sql`coalesce(${schema.reviews.postedAt}, ${schema.reviews.createdAt})`, window.start),
        lt(sql`coalesce(${schema.reviews.postedAt}, ${schema.reviews.createdAt})`, window.end),
      ),
    );

  const reviewCount = row?.reviewCount ?? 0;
  const analysedCount = row?.analysedCount ?? 0;

  return { reviewCount, analysedCount, enough: analysedCount >= MIN_ANALYSED_REVIEWS };
}

/** Recent digests for a location, newest first — the history strip. */
export async function listDigests(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  limit = 12,
): Promise<
  Pick<
    DigestView,
    "id" | "periodStart" | "periodEnd" | "pulseScore" | "pulseDelta" | "reviewCount" | "status"
  >[]
> {
  return tx
    .select({
      id: schema.digests.id,
      periodStart: schema.digests.periodStart,
      periodEnd: schema.digests.periodEnd,
      pulseScore: schema.digests.pulseScore,
      pulseDelta: schema.digests.pulseDelta,
      reviewCount: schema.digests.reviewCount,
      status: schema.digests.status,
    })
    .from(schema.digests)
    .where(
      and(
        eq(schema.digests.organizationId, organizationId),
        eq(schema.digests.locationId, locationId),
      ),
    )
    .orderBy(desc(schema.digests.periodStart))
    .limit(limit);
}

/**
 * How many of the actions we recommended actually got done (W2.1).
 *
 * The digest's whole claim is that it produces action, and until now the only
 * evidence of that was one card saying "2 of 3 last week" — read out of a
 * *stored payload*, frozen when the briefing was composed. Anything marked done
 * afterwards, which is all of it, never appeared. So this is a live read, and it
 * is deliberately not a payload field: the number's entire job is to change when
 * somebody ticks a box.
 *
 * **The window excludes the digest being viewed**, which is the difference
 * between a record and an accusation. This week's three actions were published
 * hours ago; counting them open would put a permanent "0 of 3" against every
 * business every Monday morning, and a metric that is worst when you are most
 * engaged teaches people to ignore it.
 *
 * **`dismissed` is not a failure and is kept apart from both.** Deciding a
 * recommendation is wrong for your business *is* engaging with it — the model
 * suggested extending hours to a place that cannot staff them. Folding it into
 * `done` would flatter; folding it into the denominator as an open item would
 * punish. It is reported as its own number and left out of the ratio.
 */
export type CompletionRecord = {
  /** Actions from the counted digests, less dismissals — the ratio's base. */
  total: number;
  done: number;
  dismissed: number;
  open: number;
  /** How many briefings contributed, for the label. Quiet weeks carry none. */
  digests: number;
  /**
   * Which kinds of action this business finishes, best first.
   *
   * The question `digest_actions.lever` was stored to answer. Pre-W1.6 rows have
   * no lever and are counted in the totals above but cannot appear here — which
   * is why this is a separate list rather than a breakdown that has to sum.
   */
  byLever: { lever: string; total: number; done: number }[];
};

export async function actionCompletionRecord(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  options: { before: Date; digests?: number },
): Promise<CompletionRecord> {
  // The most recent briefings *before* this one. By id rather than by date
  // range: a location with a quiet fortnight would otherwise have its record
  // measured over a window containing one briefing, and "1 of 3" reads as a
  // month's worth of neglect rather than a fortnight of nothing happening.
  const recent = await tx
    .select({ id: schema.digests.id })
    .from(schema.digests)
    .where(
      and(
        eq(schema.digests.organizationId, organizationId),
        eq(schema.digests.locationId, locationId),
        eq(schema.digests.status, "ready"),
        lt(schema.digests.periodStart, options.before),
      ),
    )
    .orderBy(desc(schema.digests.periodStart))
    .limit(options.digests ?? RECORD_DIGESTS);

  const empty: CompletionRecord = {
    total: 0,
    done: 0,
    dismissed: 0,
    open: 0,
    digests: 0,
    byLever: [],
  };
  if (recent.length === 0) return empty;

  const rows = await tx
    .select({
      digestId: schema.digestActions.digestId,
      status: schema.digestActions.status,
      lever: schema.digestActions.lever,
    })
    .from(schema.digestActions)
    .where(
      and(
        eq(schema.digestActions.organizationId, organizationId),
        inArray(
          schema.digestActions.digestId,
          recent.map((row) => row.id),
        ),
      ),
    );

  const byLever = new Map<string, { lever: string; total: number; done: number }>();
  const contributing = new Set<string>();
  const record = { ...empty };

  for (const row of rows) {
    contributing.add(row.digestId);
    if (row.status === "done") record.done += 1;
    else if (row.status === "dismissed") record.dismissed += 1;
    else record.open += 1;

    // Dismissals are excluded from the ratio's base, so a business that
    // reasonably rejects a suggestion is not marked down for it.
    if (row.status !== "dismissed") record.total += 1;

    if (row.lever && row.status !== "dismissed") {
      const entry = byLever.get(row.lever) ?? { lever: row.lever, total: 0, done: 0 };
      entry.total += 1;
      if (row.status === "done") entry.done += 1;
      byLever.set(row.lever, entry);
    }
  }

  record.digests = contributing.size;
  record.byLever = [...byLever.values()].sort(
    (a, b) => b.done / b.total - a.done / a.total || b.total - a.total,
  );

  return record;
}

/** Four weekly briefings — "last month", in the unit the digest is written in. */
export const RECORD_DIGESTS = 4;

/**
 * Marks a recommended action done or dismissed.
 *
 * This is the write that closes the loop: the next digest reads these statuses
 * and reports what happened. Idempotent — re-marking a done action changes
 * nothing rather than moving its completion time.
 *
 * **That last sentence is enforced in SQL, not merely intended** (W2.1). The
 * column used to be assigned unconditionally, so pressing Done on an action
 * already done moved its completion into the current week — and
 * `actionCompletionRecord` buckets by exactly that timestamp, so a stray second
 * click would quietly move a closure from one month's record into another's.
 * `completed_at` is therefore written only on the way *in* to a closed status;
 * a done → dismissed change keeps the moment the action stopped being open,
 * because that is what the timestamp means. Reopening clears it, which is right:
 * an action that is open again has no completion to date.
 */
export async function setActionStatus(
  tx: TenantDatabase,
  input: {
    organizationId: string;
    actionId: string;
    status: "open" | "done" | "dismissed";
    userId: string;
    now?: Date;
  },
): Promise<DigestActionRow | null> {
  const now = input.now ?? new Date();
  const closing = input.status !== "open";

  const [row] = await tx
    .update(schema.digestActions)
    .set({
      status: input.status,
      completedByUserId: closing
        ? sql`coalesce(${schema.digestActions.completedByUserId}, ${input.userId}::uuid)`
        : null,
      completedAt: closing
        ? sql`coalesce(${schema.digestActions.completedAt}, ${now.toISOString()}::timestamptz)`
        : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.digestActions.organizationId, input.organizationId),
        eq(schema.digestActions.id, input.actionId),
      ),
    )
    .returning();

  return row ?? null;
}
