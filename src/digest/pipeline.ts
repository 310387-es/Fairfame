import { and, asc, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { runAi } from "../ai/client.ts";
import { LlmError } from "../ai/types.ts";
import { getEmbeddingProvider } from "../ai/embeddings.ts";
import { boundOutput, looksAsciiFolded } from "../ai/guardrails.ts";
import { schema } from "../db/client.ts";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "../i18n/config.ts";
import { can, recordUsage, withinLimit } from "../lib/entitlements.ts";
import { liveReplyJoin } from "../reviews/answered.ts";
import { PUBLIC_FEEDBACK } from "../reviews/item-kind.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import {
  digestPrompt,
  MAX_ACTION_CHARS,
  MAX_HEADLINE_CHARS,
  MAX_SOCIAL_POST_CHARS,
  MAX_SUMMARY_CHARS,
  socialPostPrompt,
  DIGEST_ACTION_COUNT,
  DIGEST_LEVERS,
  type DigestLever,
} from "../prompts/index.ts";
import { draftReplyForReview } from "../replies/service.ts";
import {
  clusterThemes,
  computeChanges,
  computePulse,
  MIN_ANALYSED_REVIEWS,
  rawPulse,
  openNegatives,
  priorWindow,
  topReview,
  weekWindow,
  type ThemeCluster,
  type WindowChange,
  type WindowReview,
} from "./metrics.ts";

/**
 * The Action Digest pipeline (P1a-T7) — the product's hero.
 *
 * Seven steps, in the order `docs/03` §6.1 sets out: gather → cluster → pulse
 * and deltas → callouts → compose → attach assets → persist.
 *
 * The organising principle is a split the whole feature rests on:
 *
 *   - **Everything countable is computed here, in code, and handed to the model
 *     as fact.** Pulse, deltas, theme counts, which reviews are unanswered.
 *     Models are unreliable arithmetic engines, and an owner who catches one
 *     wrong number stops trusting every number on the page.
 *   - **The model is asked only to explain and prioritise**, then its output is
 *     stored. It is never re-run to render a page.
 *
 * That is also what "reproducible from stored data" means in practice: the
 * numbers are a pure function of rows (../digest/metrics.ts, tested directly),
 * and the prose is persisted rather than regenerated. Claiming a language model
 * returns identical bytes on identical input would be a claim about someone
 * else's sampler, not about our code.
 */

const log = childLogger({ module: "digest/pipeline" });

/** Quotes per theme handed to the model. Enough to ground it, not to flood it. */
const QUOTES_PER_THEME = 3;
const MAX_QUOTE_CHARS = 240;

/** Reply drafts a digest will generate. Each one spends the AI allowance. */
const MAX_REPLY_DRAFTS = 2;

export type DigestAction = {
  position: number;
  text: string;
  /** Which of `DIGEST_LEVERS` this pulls (W1.6). */
  lever: DigestLever;
  evidence: { themeSlug: string; reviewIds: string[] };
};

export type DigestPayload = {
  headline: string;
  summary: string;
  callouts: string[];
  changes: WindowChange[];
  themes: {
    label: string;
    slugs: string[];
    count: number;
    positive: number;
    negative: number;
    averageSentiment: number;
    quotes: { reviewId: string; text: string; rating: number | null }[];
  }[];
  assets: {
    replyDrafts: { reviewId: string; replyId: string; text: string }[];
    socialPost: { reviewId: string; text: string } | null;
  };
  priorActionsOutcome: {
    total: number;
    done: number;
    dismissed: number;
    open: number;
    /** The specific actions carried over, so the briefing can close the loop. */
    stillOpen: { text: string; themeSlug: string }[];
  } | null;
  /**
   * Why there is no briefing this week, when there is none (W1.6).
   *
   * A stated refusal rather than an empty one. The audit found a digest full of
   * confident, evidence-free sentences composed from almost nothing — which is
   * worse than no digest, because an owner who acts on filler and finds nothing
   * there stops opening it. `no_reviews` means nobody wrote anything;
   * `not_enough_analysed` means they did and we have not read it yet, which is
   * a different problem with a different fix, so the screen says which.
   */
  insufficient?: {
    reason: "no_reviews" | "not_enough_analysed";
    /** Reviews in the window, analysed or not — what the link goes to. */
    reviewCount: number;
    analysedCount: number;
  };
};

/**
 * Re-exported from `./metrics.ts`, which is where it now lives (A22-A1).
 *
 * The compose button has to know the threshold to disable itself, and it reads
 * through `./queries.ts` — a module whose whole purpose is that a screen can
 * read a digest without importing one that can spend money. So the number moved
 * to the pure module both of them already import.
 */
export { MIN_ANALYSED_REVIEWS } from "./metrics.ts";

/**
 * The reviews an action cited, by the quote numbers the prompt printed.
 *
 * One-based, because that is how the prompt numbers them and a model told
 * "quote 1" must not silently mean quote 0. Out-of-range numbers are dropped
 * rather than clamped: a citation of quote 40 when there were 12 is not a
 * near-miss to be rounded into quote 12, it is a fabrication, and passing it
 * through would put an unrelated review behind an action. Deduplicated, since
 * a model citing the same quote twice means one review, not two.
 */
function resolveEvidence(refs: number[], quotes: { reviewId: string }[]): string[] {
  const ids = refs
    .map((ref) => quotes[ref - 1]?.reviewId)
    .filter((id): id is string => id !== undefined);

  return [...new Set(ids)];
}

/** The model's half, after validation. */
const composedSchema = z.object({
  headline: z.string().min(1),
  summary: z.string().min(1),
  callouts: z.array(z.string()).max(3).default([]),
  actions: z
    .array(
      z.object({
        text: z.string().min(1),
        theme: z.string(),
        // At least one, enforced here as well as in the response schema: a
        // provider that does not honour `minItems` still cannot get an
        // evidence-free action past this (W1.6).
        quoteRefs: z.array(z.number().int()).min(1),
        lever: z.enum(DIGEST_LEVERS),
      }),
    )
    .min(DIGEST_ACTION_COUNT)
    .max(DIGEST_ACTION_COUNT),
});

export type GenerateArgs = {
  organizationId: string;
  locationId: string;
  actorUserId?: string | null;
  /** Defaults to the last completed week. */
  window?: { start: Date; end: Date };
  /** Regenerate even if a ready digest exists for this window. */
  force?: boolean;
  /** Skip the LLM asset generation — used by tests and by capped plans. */
  withAssets?: boolean;
  now?: Date;
};

export type GenerateResult = {
  digestId: string;
  status: "ready" | "skipped" | "failed";
  /** Set when nothing was generated. */
  reason?: "already_exists" | "no_reviews" | "not_enough_analysed" | "refresh_in_flight";
  pulse: number | null;
  reviewCount: number;
  actions: number;
  /**
   * The run was a refresh of a week already published, so nothing on screen
   * changed unless it succeeded (A22-A1).
   */
  refresh?: boolean;
};

/**
 * How long a claimed refresh is believed before another worker may take it.
 *
 * Composition is ~40-60s and the queue's own retries are bounded well inside
 * this, so a claim older than ten minutes belongs to a process that died. The
 * opposite mistake — no expiry — wedges a week forever on one crash.
 */
const REFRESH_CLAIM_TTL_MS = 10 * 60_000;

/**
 * Whether a stored payload is a briefing somebody could be reading.
 *
 * The two absences the pipeline publishes on purpose — an empty week and one
 * too thin to compose — are `ready` rows with nothing in them, and recomposing
 * over either is the whole point of pressing the button. A headline is the
 * cheapest honest test: every composed digest has one and neither absence does.
 */
function isBriefing(payload: unknown): boolean {
  const candidate = payload as DigestPayload | null;
  if (!candidate || candidate.insufficient) return false;
  return typeof candidate.headline === "string" && candidate.headline.trim().length > 0;
}

/** Reviews in a window, with their insights and whether they have a reply. */
async function gather(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  window: { start: Date; end: Date },
): Promise<WindowReview[]> {
  const rows = await tx
    .select({
      id: schema.reviews.id,
      rating: schema.reviews.rating,
      text: schema.reviews.text,
      language: schema.reviews.language,
      postedAt: schema.reviews.postedAt,
      sentiment: schema.reviewInsights.sentiment,
      sentimentScore: schema.reviewInsights.sentimentScore,
      topics: schema.reviewInsights.topics,
      themes: schema.reviewInsights.themes,
      embedding: schema.reviewInsights.embedding,
      replyId: schema.replies.id,
      ownerRepliedAt: schema.reviews.ownerRepliedAt,
    })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .leftJoin(schema.replies, liveReplyJoin)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.locationId, locationId),
        /**
         * A private message is not the week's news (A22-C1).
         *
         * Nothing filtered it, so a WhatsApp note asking whether a black
         * umbrella had been handed in was clustered with the complaints and
         * printed in a weekly plan as something to act on. A briefing is about
         * what customers said *in public* about the business; a letter to the
         * business is correspondence, and it belongs in `/conversations`.
         */
        PUBLIC_FEEDBACK,
        gte(sql`coalesce(${schema.reviews.postedAt}, ${schema.reviews.createdAt})`, window.start),
        lt(sql`coalesce(${schema.reviews.postedAt}, ${schema.reviews.createdAt})`, window.end),
      ),
    )
    .orderBy(desc(schema.reviews.postedAt));

  return rows.map((row) => ({
    id: row.id,
    rating: row.rating,
    text: row.text,
    language: row.language,
    postedAt: row.postedAt,
    sentiment: row.sentiment,
    sentimentScore: row.sentimentScore,
    topics: row.topics ?? [],
    themes: row.themes ?? [],
    embedding: row.embedding,
    // Including one the owner left on the platform (W1.2). Without it the
    // digest's "answer these" list hands an owner complaints they already
    // answered in Google — the one item in the week's plan that is meant to be
    // work nobody has done yet.
    hasReply: row.replyId !== null || row.ownerRepliedAt !== null,
  }));
}

/** The most recent digest before this window, for deltas and the open loop. */
async function priorDigest(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  window: { start: Date; end: Date },
) {
  const [row] = await tx
    .select()
    .from(schema.digests)
    .where(
      and(
        eq(schema.digests.organizationId, organizationId),
        eq(schema.digests.locationId, locationId),
        lt(schema.digests.periodStart, window.start),
        eq(schema.digests.status, "ready"),
      ),
    )
    .orderBy(desc(schema.digests.periodStart))
    .limit(1);

  return row ?? null;
}

/**
 * How the previous digest's three actions ended up.
 *
 * This is the loop closing. Without it a digest is a weekly report; with it,
 * the next one can say "you fixed the wait times, here is what is next" — which
 * is the difference the PRD is actually asking for.
 */
async function priorOutcome(
  tx: TenantDatabase,
  organizationId: string,
  priorDigestId: string | null,
): Promise<DigestPayload["priorActionsOutcome"]> {
  if (!priorDigestId) return null;

  const rows = await tx
    .select()
    .from(schema.digestActions)
    .where(
      and(
        eq(schema.digestActions.organizationId, organizationId),
        eq(schema.digestActions.digestId, priorDigestId),
      ),
    )
    .orderBy(asc(schema.digestActions.position));

  if (rows.length === 0) return null;

  return {
    total: rows.length,
    done: rows.filter((row) => row.status === "done").length,
    dismissed: rows.filter((row) => row.status === "dismissed").length,
    open: rows.filter((row) => row.status === "open").length,
    stillOpen: rows
      .filter((row) => row.status === "open")
      .map((row) => ({
        text: row.text,
        themeSlug: (row.evidence as { themeSlug?: string }).themeSlug ?? "",
      })),
  };
}

function localeOf(value: string | null | undefined): Locale {
  return (LOCALES as readonly string[]).includes(value ?? "") ? (value as Locale) : DEFAULT_LOCALE;
}

/**
 * Representative quotes per theme, bounded so one long review cannot dominate.
 *
 * **`claimed` is what stops two themes quoting the same words** (W2.1). A real
 * review carries several topics, so overlapping clusters is correct — but
 * choosing each theme's quotes independently meant the same worst review won
 * under every theme it belonged to, and a generated digest showed `fiyat` and
 * `bekleme süresi` side by side quoting an identical pair. That reads as a
 * broken page, and worse, it put a queue complaint under a heading about price.
 *
 * A review is therefore quoted under the first theme that takes it, and themes
 * arrive most-important-first. **The fallback matters more than the rule**: a
 * theme whose reviews are all spoken for still gets its worst one rather than
 * nothing, because a theme with no quote is a theme the model cannot ground an
 * action in, and losing the evidence is a bigger failure than repeating it.
 */
function quotesFor(
  theme: ThemeCluster,
  byId: Map<string, WindowReview>,
  claimed: Set<string>,
): { reviewId: string; text: string; rating: number | null }[] {
  // Negatives first: the owner needs the complaint verbatim more than the
  // praise, and a theme's worst review is the one an action has to answer.
  const ordered = [...theme.reviewIds]
    .map((id) => byId.get(id))
    .filter((review): review is WindowReview => review !== undefined && review.text !== null)
    .sort((left, right) => (left.sentimentScore ?? 0) - (right.sentimentScore ?? 0));

  // Also deduplicated by *text*, not only by id. Two customers can write the
  // same sentence — and in a seeded or low-traffic account they often do — and
  // a card quoting one sentence twice reads as a bug whether or not two people
  // really said it. Repeating it adds no evidence either way.
  const seenText = new Set<string>();
  const chosen: WindowReview[] = [];

  for (const review of ordered) {
    if (chosen.length >= QUOTES_PER_THEME) break;
    if (claimed.has(review.id)) continue;

    const key = (review.text ?? "").trim().toLocaleLowerCase("tr");
    if (seenText.has(key)) continue;

    seenText.add(key);
    chosen.push(review);
  }

  const quotes = chosen.length > 0 ? chosen : ordered.slice(0, 1);

  for (const review of quotes) claimed.add(review.id);

  return quotes.map((review) => ({
    reviewId: review.id,
    text: boundOutput(review.text ?? "", MAX_QUOTE_CHARS),
    rating: review.rating,
  }));
}

/**
 * Generates one digest for one location and one window.
 *
 * Returns rather than throws for the ordinary outcomes — an empty week, a
 * digest that already exists — because those are not failures and a job that
 * treats them as such produces alarming logs about nothing happening.
 */
export async function generateDigest(args: GenerateArgs): Promise<GenerateResult> {
  const now = args.now ?? new Date();
  const window = args.window ?? weekWindow(now);
  const { organizationId, locationId } = args;
  const withAssets = args.withAssets ?? true;

  const prepared = await withTenant({ organizationId }, async (tx) => {
    const [existing] = await tx
      .select({
        id: schema.digests.id,
        status: schema.digests.status,
        payload: schema.digests.payload,
      })
      .from(schema.digests)
      .where(
        and(
          eq(schema.digests.organizationId, organizationId),
          eq(schema.digests.locationId, locationId),
          eq(schema.digests.periodStart, window.start),
        ),
      )
      .limit(1);

    if (existing && existing.status === "ready" && !args.force) {
      return { skip: "already_exists" as const, digestId: existing.id };
    }

    /**
     * Recomposing a week somebody is already reading (A22-A1).
     *
     * The claim below moves the row to `pending`, and the catch at the bottom
     * used to move it to `failed`. Both are correct for a week that has never
     * been published and destructive for one that has: every reader filters on
     * `ready`, so a refresh that did not work took the briefing off the screen
     * while its payload sat untouched in the column. That was the single worst
     * bug in the product — the owner pressed the button on the feature they
     * pay for and it deleted the thing they pay for.
     *
     * So a refresh claims and reports through `refresh_started_at` /
     * `refresh_error` instead, and the published columns are written exactly
     * once, on success, in the same transaction that replaces the actions.
     * That is the plan's "shadow row, swap on success" without a second row —
     * the swap was already atomic, and the id must not move, because it is in
     * `/weekly-plan/{id}` links, `digest_actions` and `digest_deliveries`.
     *
     * **What is protected is a briefing, not a row.** A `ready` row can also be
     * a stated absence — an empty week, or one too thin to compose — and those
     * carry nothing to lose. Onboarding depends on it: the sweep writes the
     * empty week before anything is ingested, and the first briefing is
     * composed over it. Treating that as a published plan would leave a new
     * account looking at "no reviews this week" with its own reviews on screen.
     */
    const refreshing = existing?.status === "ready" && isBriefing(existing.payload);

    if (refreshing) {
      const staleBefore = new Date(now.getTime() - REFRESH_CLAIM_TTL_MS);

      const [claimedRefresh] = await tx
        .update(schema.digests)
        .set({ refreshStartedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.digests.id, existing.id),
            or(
              isNull(schema.digests.refreshStartedAt),
              lt(schema.digests.refreshStartedAt, staleBefore),
            ),
          ),
        )
        .returning({ id: schema.digests.id });

      // Somebody else is composing this week right now. Theirs will land.
      if (!claimedRefresh) {
        return { skip: "refresh_in_flight" as const, digestId: existing.id };
      }
    }

    const reviews = await gather(tx, organizationId, locationId, window);
    const prior = await priorDigest(tx, organizationId, locationId, window);
    const priorReviews = await gather(tx, organizationId, locationId, priorWindow(window));

    const [location] = await tx
      .select({
        name: schema.locations.name,
        locale: schema.locations.locale,
        organizationName: schema.organizations.name,
        organizationLocale: schema.organizations.locale,
      })
      .from(schema.locations)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.locations.organizationId))
      .where(eq(schema.locations.id, locationId))
      .limit(1);

    if (!location) throw new Error(`Location ${locationId} not found for this organization.`);

    // Claim the row before doing anything expensive, so two workers cannot
    // compose the same week twice. A refresh has already claimed itself above
    // and must not be moved off `ready`, so it only refreshes the review count.
    const [claimed] = await tx
      .insert(schema.digests)
      .values({
        organizationId,
        locationId,
        periodStart: window.start,
        periodEnd: window.end,
        status: "pending",
        reviewCount: reviews.length,
      })
      .onConflictDoUpdate({
        target: [schema.digests.locationId, schema.digests.periodStart],
        set: refreshing
          ? { updatedAt: now }
          : { status: "pending", reviewCount: reviews.length, updatedAt: now },
      })
      .returning({ id: schema.digests.id });

    if (!claimed) throw new Error("Could not claim a digest row.");

    return {
      skip: null,
      digestId: claimed.id,
      refreshing,
      reviews,
      priorReviews,
      prior,
      location,
      priorActionsOutcome: await priorOutcome(tx, organizationId, prior?.id ?? null),
    };
  });

  if (prepared.skip) {
    return {
      digestId: prepared.digestId,
      status: "skipped",
      reason: prepared.skip,
      pulse: null,
      reviewCount: 0,
      actions: 0,
    };
  }

  const { digestId, refreshing, reviews, priorReviews, prior, location, priorActionsOutcome } =
    prepared;

  /**
   * A refresh that produced nothing keeps the published week exactly as it is.
   *
   * Both callers below are outcomes that are perfectly good *first* answers —
   * an empty week is news, and a week too thin to compose says so — and are
   * destructive as *second* ones: they would write `emptyPayload` over a real
   * briefing. The refusal is recorded where the screen can say "couldn't
   * refresh", and the claim is released so the next attempt is not blocked.
   */
  const declineRefresh = async (note: string): Promise<void> => {
    await withTenant({ organizationId }, (tx) =>
      tx
        .update(schema.digests)
        .set({ refreshStartedAt: null, refreshError: note, updatedAt: now })
        .where(eq(schema.digests.id, digestId)),
    );

    log.info({ organizationId, locationId, digestId, note }, "Digest refresh declined");
  };

  if (reviews.length === 0) {
    if (refreshing) {
      await declineRefresh("no_reviews");
      return {
        digestId,
        status: "ready",
        reason: "no_reviews",
        pulse: null,
        reviewCount: 0,
        actions: 0,
        refresh: true,
      };
    }

    await withTenant({ organizationId }, (tx) =>
      tx
        .update(schema.digests)
        .set({
          status: "ready",
          pulseScore: null,
          pulseDelta: null,
          reviewCount: 0,
          // A week with no reviews still produces a digest — the absence is
          // itself news, and a missing row would read as a broken pipeline.
          payload: emptyPayload(priorActionsOutcome),
          locale: localeOf(location.locale ?? location.organizationLocale),
          generatedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.digests.id, digestId)),
    );

    return {
      digestId,
      status: "ready",
      reason: "no_reviews",
      pulse: null,
      reviewCount: 0,
      actions: 0,
    };
  }

  const locale = localeOf(location.locale ?? location.organizationLocale);
  const byId = new Map(reviews.map((review) => [review.id, review]));

  // One embedding call for the distinct theme *labels* in both windows, so the
  // clustering compares words rather than review centroids — see the note on
  // `clusterThemes`. Labels are short and few, so this is one cheap batch.
  const labelVectors = await embedLabels([...reviews, ...priorReviews]);

  const themes = clusterThemes(reviews, { labelVectors });
  const priorThemes = clusterThemes(priorReviews, { labelVectors });

  /**
   * Refuse to compose a briefing out of nothing (W1.6).
   *
   * The audit's digest read as confident Turkish filler with "0 reviews on"
   * under every action, and this is where that came from: with no themes there
   * is nothing for an action to cite, so every one fell through to `themes[0]`,
   * which was `undefined`. The model was asked to write three actions anyway,
   * and obliged — because that is what models do.
   *
   * Two conditions, and they are different problems:
   *
   *   - **No themes at all.** Nothing to say anything about.
   *   - **Fewer than `MIN_ANALYSED_REVIEWS` analysed.** A theme drawn from two
   *     reviews is an anecdote, and "customers are unhappy about parking"
   *     stated from one comment is a claim the data does not support.
   *
   * Refusing costs a week's briefing. Composing costs the owner's trust in
   * every briefing after it, which is the more expensive of the two.
   */
  const analysedCount = reviews.filter((review) => review.sentiment !== null).length;

  if (themes.length === 0 || analysedCount < MIN_ANALYSED_REVIEWS) {
    log.info(
      { organizationId, locationId, themes: themes.length, analysedCount },
      "Digest declined: not enough analysed feedback",
    );

    if (refreshing) {
      await declineRefresh("not_enough_analysed");
      return {
        digestId,
        status: "ready",
        reason: "not_enough_analysed",
        pulse: computePulse(reviews, { prior: rawPulse(reviews) }),
        reviewCount: reviews.length,
        actions: 0,
        refresh: true,
      };
    }

    await withTenant({ organizationId }, async (tx) =>
      tx
        .update(schema.digests)
        .set({
          status: "ready",
          pulseScore: computePulse(reviews, { prior: rawPulse(reviews) }),
          pulseDelta: null,
          reviewCount: reviews.length,
          payload: {
            ...emptyPayload(priorActionsOutcome),
            insufficient: {
              reason: "not_enough_analysed",
              reviewCount: reviews.length,
              analysedCount,
            },
          },
          locale: localeOf(location.locale ?? location.organizationLocale),
          generatedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.digests.id, digestId)),
    );

    return {
      digestId,
      status: "ready",
      reason: "not_enough_analysed",
      pulse: computePulse(reviews, { prior: rawPulse(reviews) }),
      reviewCount: reviews.length,
      actions: 0,
    };
  }
  /**
   * Smoothed toward the two windows together (W3.3).
   *
   * A week is a small sample for a small business — the raw blend on eight
   * reviews swings fifteen points on who happened to write — so the weekly
   * number is pulled toward the longer run. `priorReviews` is the preceding
   * window, so the two together are the closest thing this function already
   * holds to a baseline; the dashboard, which loads its own facts, smooths
   * toward a full ninety days.
   */
  const baseline = rawPulse([...reviews, ...priorReviews]);
  const pulse = computePulse(reviews, { prior: baseline });
  const priorPulse = prior?.pulseScore ?? computePulse(priorReviews, { prior: baseline });

  const changes = computeChanges({
    pulse,
    priorPulse,
    reviewCount: reviews.length,
    priorReviewCount: priorReviews.length,
    themes,
    priorThemes,
  });

  // Shared across the map, so a review quoted under one theme is not quoted
  // again under the next. Themes arrive most-important-first, which is what
  // makes "the first theme that takes it" the right claim rather than an
  // arbitrary one.
  const claimedQuotes = new Set<string>();

  const themePayload = themes.map((theme) => ({
    label: theme.label,
    slugs: theme.slugs,
    count: theme.reviewCount,
    positive: theme.positive,
    negative: theme.negative,
    averageSentiment: theme.averageSentiment,
    quotes: quotesFor(theme, byId, claimedQuotes),
  }));

  /**
   * The quotes exactly as the prompt numbers them (W1.6).
   *
   * Built once and used twice — printed for the model, then read back to turn
   * the numbers it cites into review ids. Two separate flattenings of the same
   * data would eventually disagree about what quote 4 was, and the failure
   * would be an action linking to somebody else's review.
   */
  const promptQuotes = themePayload.flatMap((theme) =>
    theme.quotes.map((quote) => ({
      theme: theme.label,
      text: quote.text,
      reviewId: quote.reviewId,
    })),
  );

  try {
    const prompt = digestPrompt({
      locale,
      businessName: location.organizationName,
      locationName: location.name,
      periodLabel: `${window.start.toISOString().slice(0, 10)} to ${window.end
        .toISOString()
        .slice(0, 10)}`,
      pulse,
      priorPulse,
      reviewCount: reviews.length,
      priorReviewCount: priorReviews.length,
      themes: themePayload.map((theme) => ({
        label: theme.label,
        count: theme.count,
        positive: theme.positive,
        negative: theme.negative,
      })),
      changes,
      quotes: promptQuotes.map((quote) => ({ theme: quote.theme, text: quote.text })),
    });

    const { response } = await runAi({
      organizationId,
      actorUserId: args.actorUserId ?? null,
      task: "digest",
      prompt,
      /**
       * Reject and ask again, rather than publish it (W1.6).
       *
       * Two failures that a schema cannot see, both of which reached the hero
       * screen in the audit: a Turkish briefing written without a single
       * Turkish letter, and an action citing no evidence at all. Both are
       * cheap to retry — this is one call a week per location — and expensive
       * to ship.
       */
      validate: (candidate) => {
        if (
          looksAsciiFolded({
            locale,
            output: candidate.text,
            source: promptQuotes.map((quote) => quote.text).join(" "),
          })
        ) {
          throw new LlmError("The Turkish briefing came back without Turkish letters.", {
            provider: candidate.provider,
            retryable: true,
            code: "ascii_folded",
          });
        }

        const parsed = composedSchema.safeParse(JSON.parse(extractJson(candidate.text)));
        if (!parsed.success) return;

        const citesNothing = parsed.data.actions.some(
          (action) => resolveEvidence(action.quoteRefs, promptQuotes).length === 0,
        );

        if (citesNothing) {
          throw new LlmError("An action cited no reviews.", {
            provider: candidate.provider,
            retryable: true,
            code: "no_evidence",
          });
        }
      },
    });

    /**
     * A cut-off reply is a *budget* failure, not a parse failure.
     *
     * `LlmResponse.truncated` has carried this instruction since P1a-T1 —
     * "the caller must not treat a truncated JSON body as a parse failure" —
     * and `analyze.ts` honours it. The digest did not, so a response that ran
     * out of room was recorded as `Unterminated string in JSON at position
     * 215`: an error that sends whoever reads it looking for a bug in the
     * parser rather than at the one number that would fix it.
     *
     * Not retryable: the same prompt with the same budget truncates again.
     */
    if (response.truncated) {
      throw new LlmError(
        "The briefing was cut off before it produced complete JSON — raise maxOutputTokens.",
        { provider: response.provider, retryable: false, code: "truncated" },
      );
    }

    const composed = composedSchema.parse(JSON.parse(extractJson(response.text)));

    const assets = withAssets
      ? await buildAssets({
          organizationId,
          actorUserId: args.actorUserId ?? null,
          locale,
          businessName: location.organizationName,
          reviews,
        })
      : { replyDrafts: [], socialPost: null };

    const payload: DigestPayload = {
      headline: boundOutput(composed.headline, MAX_HEADLINE_CHARS),
      summary: boundOutput(composed.summary, MAX_SUMMARY_CHARS),
      callouts: composed.callouts.map((callout) => boundOutput(callout, MAX_ACTION_CHARS)),
      changes,
      themes: themePayload,
      assets,
      priorActionsOutcome,
    };

    // Actions are matched back to real reviews so "evidence-linked" is a fact
    // rather than a label. The model's own citations come first — those are the
    // reviews it actually reasoned from, and W2.1's "show me exactly these"
    // button depends on them being the real ones. The theme is the fallback:
    // a model naming a theme that does not exist gets the largest one, and the
    // briefing still points somewhere real.
    const actions: DigestAction[] = composed.actions
      .slice(0, DIGEST_ACTION_COUNT)
      .map((action, index) => {
        const theme =
          themes.find((candidate) => candidate.label === action.theme) ??
          themes.find((candidate) => candidate.slugs.includes(action.theme)) ??
          themes[0];

        const cited = resolveEvidence(action.quoteRefs, promptQuotes);
        const reviewIds = cited.length > 0 ? cited : (theme?.reviewIds ?? []).slice(0, 5);

        return {
          position: index + 1,
          text: boundOutput(action.text, MAX_ACTION_CHARS),
          lever: action.lever,
          evidence: {
            themeSlug: theme?.label ?? "",
            reviewIds,
          },
        };
      });

    await withTenant({ organizationId }, async (tx) => {
      await tx
        .update(schema.digests)
        .set({
          status: "ready",
          pulseScore: pulse,
          pulseDelta:
            pulse !== null && priorPulse !== null ? Number((pulse - priorPulse).toFixed(1)) : null,
          reviewCount: reviews.length,
          payload,
          locale,
          promptId: prompt.id,
          model: response.model,
          lastError: null,
          // The swap. Everything a reader sees moves here, in one statement,
          // beside the actions below — and the refresh state it was composed
          // under is cleared with it, so a week that recovered stops claiming
          // it could not be refreshed.
          refreshStartedAt: null,
          refreshError: null,
          generatedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.digests.id, digestId));

      // Replace rather than append: a regenerated digest must not leave last
      // attempt's actions behind for the owner to act on.
      await tx.delete(schema.digestActions).where(eq(schema.digestActions.digestId, digestId));

      if (actions.length > 0) {
        await tx.insert(schema.digestActions).values(
          actions.map((action) => ({
            organizationId,
            digestId,
            position: action.position,
            text: action.text,
            evidence: action.evidence,
            lever: action.lever,
          })),
        );
      }
    });

    log.info(
      {
        organizationId,
        locationId,
        digestId,
        pulse,
        reviewCount: reviews.length,
        themes: themes.length,
        actions: actions.length,
        replyDrafts: assets.replyDrafts.length,
        model: response.model,
      },
      "Digest generated",
    );

    return {
      digestId,
      status: "ready",
      pulse,
      reviewCount: reviews.length,
      actions: actions.length,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";

    await withTenant({ organizationId }, (tx) =>
      tx
        .update(schema.digests)
        .set(
          // A refresh that failed leaves the published week untouched — status,
          // payload, actions and `generated_at` all stay as they were — and
          // says so in its own column. Only a week that has never been
          // published can be marked failed, because there is nothing to lose.
          refreshing
            ? { refreshStartedAt: null, refreshError: reason, updatedAt: now }
            : { status: "failed", lastError: reason, updatedAt: now },
        )
        .where(eq(schema.digests.id, digestId)),
    );

    log.error(
      { organizationId, locationId, digestId, refresh: refreshing, err: error },
      refreshing
        ? "Digest refresh failed; the published week is unchanged"
        : "Digest generation failed",
    );

    return {
      digestId,
      status: "failed",
      pulse,
      reviewCount: reviews.length,
      actions: 0,
      ...(refreshing ? { refresh: true } : {}),
    };
  }
}

/**
 * Embeddings for every distinct theme label in the window.
 *
 * Best-effort: without vectors the clustering simply does not merge, which
 * leaves `personel` and `staff` as two lines. Untidy, and far better than
 * failing the digest over an embedding outage.
 */
async function embedLabels(reviews: WindowReview[]): Promise<Map<string, number[]>> {
  // Only the free tail needs vectors: canonical keys merge on exact slug and
  // never reach the semantic pass, so embedding them would be paid for nothing.
  const labels = [
    ...new Set(reviews.flatMap((review) => (review.themes.length > 0 ? [] : review.topics))),
  ].filter(Boolean);
  if (labels.length === 0) return new Map();

  try {
    const vectors = await getEmbeddingProvider().embed(labels);
    return new Map(
      labels.flatMap((label, index) => {
        const vector = vectors[index];
        return vector ? [[label, vector] as [string, number[]]] : [];
      }),
    );
  } catch (error) {
    log.warn({ err: error }, "Theme label embedding failed; themes will not be merged");
    return new Map();
  }
}

function emptyPayload(priorActionsOutcome: DigestPayload["priorActionsOutcome"]): DigestPayload {
  return {
    headline: "",
    summary: "",
    callouts: [],
    changes: [],
    themes: [],
    assets: { replyDrafts: [], socialPost: null },
    priorActionsOutcome,
  };
}

/**
 * Draft replies for unanswered negatives, plus one social post.
 *
 * Both are best-effort. An asset that fails to generate must not fail the
 * digest — the briefing is the product, the assets are a head start on the
 * work, and a week with no social post is better than no digest at all.
 */
async function buildAssets(input: {
  organizationId: string;
  actorUserId: string | null;
  locale: Locale;
  businessName: string;
  reviews: WindowReview[];
}): Promise<DigestPayload["assets"]> {
  const assets: DigestPayload["assets"] = { replyDrafts: [], socialPost: null };

  const negatives = openNegatives(input.reviews, MAX_REPLY_DRAFTS);

  if (negatives.length > 0) {
    // The same gate the Inbox button honours: a plan without `ai_replies` does
    // not get them here through the back door.
    const entitled = await withTenant({ organizationId: input.organizationId }, (tx) =>
      can({ organizationId: input.organizationId, tx }, "ai_replies"),
    );

    if (entitled) {
      for (const review of negatives) {
        try {
          const reply = await withTenant({ organizationId: input.organizationId }, (tx) =>
            draftReplyForReview({
              tx,
              organizationId: input.organizationId,
              actorUserId: input.actorUserId,
              reviewId: review.id,
            }),
          );

          assets.replyDrafts.push({ reviewId: review.id, replyId: reply.id, text: reply.text });
        } catch (error) {
          // A spent allowance or an already-answered review: skip, do not fail.
          log.info(
            { organizationId: input.organizationId, reviewId: review.id, err: error },
            "Skipped a digest reply draft",
          );
        }
      }
    }
  }

  const best = topReview(input.reviews);

  if (best?.text) {
    try {
      const budget = await withTenant({ organizationId: input.organizationId }, (tx) =>
        withinLimit({ organizationId: input.organizationId, tx }, "ai_analyses_per_month"),
      );

      if (budget.allowed) {
        const { response } = await runAi({
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          task: "digest",
          prompt: socialPostPrompt({
            locale: input.locale,
            businessName: input.businessName,
            reviewText: best.text,
            rating: best.rating,
          }),
        });

        const text = boundOutput(response.text, MAX_SOCIAL_POST_CHARS);
        if (text.length > 0) {
          assets.socialPost = { reviewId: best.id, text };
          await recordUsage(input.organizationId, "ai_analyses_per_month", 1);
        }
      }
    } catch (error) {
      log.info({ organizationId: input.organizationId, err: error }, "Skipped the social post");
    }
  }

  return assets;
}

/** Same fence-tolerant extraction the analysis parser uses. */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1];

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}
