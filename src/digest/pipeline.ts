import { and, asc, desc, eq, gte, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { runAi } from "../ai/client.ts";
import { getEmbeddingProvider } from "../ai/embeddings.ts";
import { boundOutput } from "../ai/guardrails.ts";
import { schema } from "../db/client.ts";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "../i18n/config.ts";
import { can, recordUsage, withinLimit } from "../lib/entitlements.ts";
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
} from "../prompts/index.ts";
import { draftReplyForReview } from "../replies/service.ts";
import {
  clusterThemes,
  computeChanges,
  computePulse,
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
};

/** The model's half, after validation. */
const composedSchema = z.object({
  headline: z.string().min(1),
  summary: z.string().min(1),
  callouts: z.array(z.string()).max(3).default([]),
  actions: z
    .array(z.object({ text: z.string().min(1), theme: z.string() }))
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
  reason?: "already_exists" | "no_reviews";
  pulse: number | null;
  reviewCount: number;
  actions: number;
};

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
      embedding: schema.reviewInsights.embedding,
      replyId: schema.replies.id,
    })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .leftJoin(
      schema.replies,
      and(eq(schema.replies.reviewId, schema.reviews.id), ne(schema.replies.status, "failed")),
    )
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.locationId, locationId),
        // `posted_at` is the customer's clock, which is what a weekly window
        // means to an owner. Falling back to ingestion time would put a review
        // we synced late into the wrong week.
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
    embedding: row.embedding,
    hasReply: row.replyId !== null,
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

/** Representative quotes per theme, bounded so one long review cannot dominate. */
function quotesFor(
  theme: ThemeCluster,
  byId: Map<string, WindowReview>,
): { reviewId: string; text: string; rating: number | null }[] {
  const quotes: { reviewId: string; text: string; rating: number | null }[] = [];

  // Negatives first: the owner needs the complaint verbatim more than the
  // praise, and a theme's worst review is the one an action has to answer.
  const ordered = [...theme.reviewIds]
    .map((id) => byId.get(id))
    .filter((review): review is WindowReview => review !== undefined && review.text !== null)
    .sort((left, right) => (left.sentimentScore ?? 0) - (right.sentimentScore ?? 0));

  for (const review of ordered) {
    if (quotes.length >= QUOTES_PER_THEME) break;
    quotes.push({
      reviewId: review.id,
      text: boundOutput(review.text ?? "", MAX_QUOTE_CHARS),
      rating: review.rating,
    });
  }

  return quotes;
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
      .select({ id: schema.digests.id, status: schema.digests.status })
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
    // compose the same week twice.
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
        set: { status: "pending", reviewCount: reviews.length, updatedAt: now },
      })
      .returning({ id: schema.digests.id });

    if (!claimed) throw new Error("Could not claim a digest row.");

    return {
      skip: null,
      digestId: claimed.id,
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

  const { digestId, reviews, priorReviews, prior, location, priorActionsOutcome } = prepared;

  if (reviews.length === 0) {
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
  const pulse = computePulse(reviews);
  const priorPulse = prior?.pulseScore ?? computePulse(priorReviews);

  const changes = computeChanges({
    pulse,
    priorPulse,
    reviewCount: reviews.length,
    priorReviewCount: priorReviews.length,
    themes,
    priorThemes,
  });

  const themePayload = themes.map((theme) => ({
    label: theme.label,
    slugs: theme.slugs,
    count: theme.reviewCount,
    positive: theme.positive,
    negative: theme.negative,
    averageSentiment: theme.averageSentiment,
    quotes: quotesFor(theme, byId),
  }));

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
      quotes: themePayload.flatMap((theme) =>
        theme.quotes.map((quote) => ({ theme: theme.label, text: quote.text })),
      ),
    });

    const { response } = await runAi({
      organizationId,
      actorUserId: args.actorUserId ?? null,
      task: "digest",
      prompt,
    });

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

    // Actions are matched back to a real theme so "evidence-linked" is a fact
    // rather than a label. A model naming a theme that does not exist gets the
    // largest theme instead — the briefing still points at real reviews.
    const actions: DigestAction[] = composed.actions
      .slice(0, DIGEST_ACTION_COUNT)
      .map((action, index) => {
        const theme =
          themes.find((candidate) => candidate.label === action.theme) ??
          themes.find((candidate) => candidate.slugs.includes(action.theme)) ??
          themes[0];

        return {
          position: index + 1,
          text: boundOutput(action.text, MAX_ACTION_CHARS),
          evidence: {
            themeSlug: theme?.label ?? "",
            reviewIds: (theme?.reviewIds ?? []).slice(0, 5),
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
        .set({ status: "failed", lastError: reason, updatedAt: now })
        .where(eq(schema.digests.id, digestId)),
    );

    log.error({ organizationId, locationId, digestId, err: error }, "Digest generation failed");

    return { digestId, status: "failed", pulse, reviewCount: reviews.length, actions: 0 };
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
  const labels = [...new Set(reviews.flatMap((review) => review.topics))].filter(Boolean);
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
