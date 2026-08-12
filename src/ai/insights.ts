import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { EMBEDDING_DIMENSIONS } from "../db/schema.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import type { Sentiment } from "../db/schema.ts";

/**
 * Reading and writing AI insights (P1a-T2).
 *
 * The data layer for `review_insights` and `tags`, kept separate from the
 * analysis itself (T3) for the same reason the connector is separate from the
 * sync job: persistence and generation change for different reasons and should
 * be testable apart.
 *
 * Everything takes a `TenantDatabase`, so every read and write happens inside a
 * tenant transaction. That matters more here than almost anywhere else in the
 * schema — an embedding is a compressed representation of a customer's words,
 * and a similarity search that escaped its tenant would return *another
 * business's* reviews as "similar", which is both a data leak and a plausible
 * bug to overlook, since the results would look perfectly reasonable.
 */

export type InsightInput = {
  reviewId: string;
  sentiment: Sentiment;
  sentimentScore: number;
  topics: string[];
  /**
   * Names the reviewer wrote (P3-T4). Empty when nobody was named.
   *
   * Optional at this boundary, like `embedding`, and for the same reason: a
   * caller that does not extract names must not be able to erase names that
   * are already there. Omitting it on a re-analysis keeps what was stored.
   */
  staff?: string[];
  /**
   * Canonical themes (W3.2). Optional at this boundary for the same reason as
   * `staff`: a caller that does not extract them must not erase the ones
   * already stored, so omitting it on a re-analysis keeps what is there.
   */
  themes?: string[];
  language: string | null;
  /** Null when the embedding pass has not run yet. */
  embedding?: number[] | null;
  /**
   * SHA-256 of the analyzed text — the cache key the batch runner compares
   * against to decide whether a review needs re-analyzing.
   */
  contentHash?: string | null;
  promptId: string;
  model: string;
};

/**
 * Writes an insight, replacing any previous analysis of the same review.
 *
 * Upsert rather than insert because re-analysis is routine: a new prompt
 * version, a better model, a recompute after a bug. Keeping both rows would
 * force every reader to work out which is current.
 *
 * An existing embedding survives a re-analysis that does not supply one —
 * sentiment and themes are cheap to recompute, embeddings are not, and the
 * two passes legitimately run at different times.
 */
export async function upsertInsight(
  tx: TenantDatabase,
  organizationId: string,
  input: InsightInput,
  now = new Date(),
): Promise<string> {
  assertEmbedding(input.embedding);

  const [row] = await tx
    .insert(schema.reviewInsights)
    .values({
      organizationId,
      reviewId: input.reviewId,
      sentiment: input.sentiment,
      sentimentScore: input.sentimentScore,
      topics: input.topics,
      staff: input.staff ?? [],
      // Null, not `[]`, when the caller did not extract them: null means
      // "analysed before the taxonomy existed" and `[]` means "no theme fits",
      // and a screen must be able to tell those apart (W3.2).
      themes: input.themes ?? null,
      language: input.language,
      embedding: input.embedding ?? null,
      contentHash: input.contentHash ?? null,
      promptId: input.promptId,
      model: input.model,
      analyzedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.reviewInsights.reviewId,
      set: {
        sentiment: input.sentiment,
        sentimentScore: input.sentimentScore,
        topics: input.topics,
        // Coalesced, not overwritten — same reasoning as `embedding` below.
        ...(input.staff ? { staff: input.staff } : { staff: sql`${schema.reviewInsights.staff}` }),
        // Coalesced like `staff`: a re-analysis that did not produce themes
        // must not erase the ones already there.
        ...(input.themes
          ? { themes: input.themes }
          : { themes: sql`${schema.reviewInsights.themes}` }),
        language: input.language,
        // coalesce, not overwrite: see the note above.
        ...(input.embedding
          ? { embedding: input.embedding }
          : { embedding: sql`${schema.reviewInsights.embedding}` }),
        contentHash: input.contentHash ?? null,
        promptId: input.promptId,
        model: input.model,
        analyzedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: schema.reviewInsights.id });

  if (!row) throw new Error("Could not persist the review insight.");
  return row.id;
}

/**
 * An analysis already paid for that a different review may reuse.
 *
 * The category comes from the *source* review's location, and is part of the
 * answer rather than context: see `findReusableInsights`.
 */
export type ReusableInsight = {
  contentHash: string;
  /** `locations.category` of the review this analysis was produced from. */
  category: string | null;
  sentiment: Sentiment;
  sentimentScore: number;
  topics: string[];
  themes: string[] | null;
  staff: string[];
  language: string | null;
  embedding: number[] | null;
  /** What actually ran. Copied onto the new row, because it is what produced the words. */
  promptId: string;
  model: string;
};

/**
 * Analyses of the same text, in this organization, that a new review could be
 * given instead of a model call.
 *
 * Three conditions, and each one is load-bearing:
 *
 *   - **Same organization.** Never a cross-tenant read, for the same reason
 *     `CLAUDE.md` forbids another org's data in a prompt: two businesses can
 *     receive the identical sentence, and an analysis is derived from a
 *     customer's words. It stays inside the tenant transaction and filters on
 *     `organization_id` explicitly, so RLS is the second lock rather than the
 *     only one.
 *   - **Same prompt id.** A different prompt is a different question, and the
 *     answer to the old one is not the answer to the new one. This is also what
 *     makes a prompt revision behave: `analyze_review@4` finds no donors and
 *     re-analyses, which is the entire point of bumping the version.
 *   - **Same vertical.** Themes are narrowed per `locations.category` (W3.2), so
 *     "Harika" at a hotel and "Harika" at a barber were offered different closed
 *     lists and did not answer the same question. The caller compares it, via
 *     one key function, rather than this query — a null category must match a
 *     null category, and `=` in SQL says nothing at all about that.
 *
 * One row per (text, vertical), newest first, so a hot phrase repeated five
 * hundred times returns one donor rather than five hundred.
 */
export async function findReusableInsights(
  tx: TenantDatabase,
  organizationId: string,
  args: { contentHashes: string[]; promptId: string; excludeReviewIds?: string[] },
): Promise<ReusableInsight[]> {
  if (args.contentHashes.length === 0) return [];

  const rows = await tx
    .selectDistinctOn([schema.reviewInsights.contentHash, schema.locations.category], {
      contentHash: schema.reviewInsights.contentHash,
      category: schema.locations.category,
      sentiment: schema.reviewInsights.sentiment,
      sentimentScore: schema.reviewInsights.sentimentScore,
      topics: schema.reviewInsights.topics,
      themes: schema.reviewInsights.themes,
      staff: schema.reviewInsights.staff,
      language: schema.reviewInsights.language,
      embedding: schema.reviewInsights.embedding,
      promptId: schema.reviewInsights.promptId,
      model: schema.reviewInsights.model,
    })
    .from(schema.reviewInsights)
    .innerJoin(schema.reviews, eq(schema.reviews.id, schema.reviewInsights.reviewId))
    .innerJoin(schema.locations, eq(schema.locations.id, schema.reviews.locationId))
    .where(
      and(
        eq(schema.reviewInsights.organizationId, organizationId),
        inArray(schema.reviewInsights.contentHash, args.contentHashes),
        eq(schema.reviewInsights.promptId, args.promptId),
        // The reviews being analysed right now are never their own donors —
        // otherwise `--recompute` would copy each row from itself and re-analyse
        // nothing, which is the one thing the operator asked for.
        args.excludeReviewIds?.length
          ? notInArray(schema.reviewInsights.reviewId, args.excludeReviewIds)
          : undefined,
      ),
    )
    .orderBy(
      schema.reviewInsights.contentHash,
      schema.locations.category,
      desc(schema.reviewInsights.analyzedAt),
    );

  // `content_hash` is nullable in the schema; every row here matched one of the
  // hashes we asked for, so the narrowing is a type formality.
  return rows.flatMap((row) => (row.contentHash ? [{ ...row, contentHash: row.contentHash }] : []));
}

/** Attaches an embedding to an existing insight, leaving the analysis alone. */
export async function setEmbedding(
  tx: TenantDatabase,
  organizationId: string,
  reviewId: string,
  embedding: number[],
  now = new Date(),
): Promise<void> {
  assertEmbedding(embedding);

  await tx
    .update(schema.reviewInsights)
    .set({ embedding, updatedAt: now })
    .where(
      and(
        eq(schema.reviewInsights.organizationId, organizationId),
        eq(schema.reviewInsights.reviewId, reviewId),
      ),
    );
}

/**
 * A wrong-width vector is rejected before it reaches Postgres.
 *
 * pgvector would refuse it anyway, but the error surfaces as an opaque cast
 * failure three layers down; the model that produced it is what the caller
 * actually needs to hear about.
 */
function assertEmbedding(embedding: number[] | null | undefined): void {
  if (!embedding) return;

  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding must have ${EMBEDDING_DIMENSIONS} dimensions, received ${embedding.length}. ` +
        "Embeddings of different widths are not comparable, so this is a configuration error " +
        "rather than something to store.",
    );
  }
}

/** Insights for a set of reviews, keyed by review id. */
export async function insightsForReviews(
  tx: TenantDatabase,
  organizationId: string,
  reviewIds: string[],
): Promise<Map<string, typeof schema.reviewInsights.$inferSelect>> {
  if (reviewIds.length === 0) return new Map();

  const rows = await tx
    .select()
    .from(schema.reviewInsights)
    .where(
      and(
        eq(schema.reviewInsights.organizationId, organizationId),
        inArray(schema.reviewInsights.reviewId, reviewIds),
      ),
    );

  return new Map(rows.map((row) => [row.reviewId, row]));
}

/** Reviews with no analysis yet — the backfill queue for T4. */
export async function reviewsAwaitingAnalysis(
  tx: TenantDatabase,
  organizationId: string,
  limit = 100,
): Promise<{ id: string; text: string | null; rating: number | null }[]> {
  return tx
    .select({
      id: schema.reviews.id,
      text: schema.reviews.text,
      rating: schema.reviews.rating,
    })
    .from(schema.reviews)
    .leftJoin(schema.reviewInsights, eq(schema.reviewInsights.reviewId, schema.reviews.id))
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        sql`${schema.reviewInsights.id} is null`,
      ),
    )
    .orderBy(desc(schema.reviews.postedAt))
    .limit(limit);
}

export type SimilarReview = {
  reviewId: string;
  /** Cosine distance: 0 is identical, 2 is opposite. */
  distance: number;
  text: string | null;
  rating: number | null;
  sentiment: Sentiment;
};

/**
 * The nearest reviews to a vector — "find similar complaints", and the
 * primitive the digest's theme clustering is built on.
 *
 * `<=>` is pgvector's cosine-distance operator, matching the HNSW index's
 * `vector_cosine_ops`. A different operator would not match the index at all.
 *
 * **What actually happens today, measured rather than assumed:** because every
 * query is tenant-filtered, Postgres prefers the `organization_id` btree plus a
 * sort over an HNSW scan — and at realistic per-tenant volumes that is the
 * cheaper plan, so the index mostly sits unused. It earns its place when a
 * single tenant's insight count grows large enough for the planner to switch.
 *
 * When that happens there is a trap worth knowing about in advance: a filtered
 * HNSW scan can return *fewer* rows than `limit`, because the index returns the
 * global nearest neighbours and the tenant filter then removes them. It reads
 * as "this business has few similar reviews" rather than as a bug. pgvector's
 * `hnsw.iterative_scan` (available here — 0.8.6) is the fix, and the right time
 * to enable it is when the plan actually changes, not speculatively now.
 */
export async function findSimilarReviews(
  tx: TenantDatabase,
  organizationId: string,
  embedding: number[],
  options: { limit?: number; excludeReviewId?: string } = {},
): Promise<SimilarReview[]> {
  assertEmbedding(embedding);

  const limit = options.limit ?? 10;
  // Drizzle has no operator for `<=>`, so the vector is passed as a bound
  // parameter and cast — never interpolated.
  const vectorParam = sql`${JSON.stringify(embedding)}::vector`;

  const rows = await tx
    .select({
      reviewId: schema.reviewInsights.reviewId,
      distance: sql<number>`${schema.reviewInsights.embedding} <=> ${vectorParam}`.mapWith(Number),
      text: schema.reviews.text,
      rating: schema.reviews.rating,
      sentiment: schema.reviewInsights.sentiment,
    })
    .from(schema.reviewInsights)
    .innerJoin(schema.reviews, eq(schema.reviews.id, schema.reviewInsights.reviewId))
    .where(
      and(
        eq(schema.reviewInsights.organizationId, organizationId),
        sql`${schema.reviewInsights.embedding} is not null`,
        options.excludeReviewId
          ? sql`${schema.reviewInsights.reviewId} <> ${options.excludeReviewId}`
          : undefined,
      ),
    )
    .orderBy(sql`${schema.reviewInsights.embedding} <=> ${vectorParam}`)
    .limit(limit);

  return rows;
}

export type ThemeCount = {
  slug: string;
  label: string;
  reviewCount: number;
  /** Mean sentiment score across the reviews carrying this theme. */
  averageSentiment: number;
};

/**
 * Themes across an organization, ranked by volume.
 *
 * Computed from `review_insights.topics` — the model's own words — rather than
 * from the `tags` table, so the numbers reflect the evidence. `tags` supplies
 * the display label where an owner has renamed something.
 */
export async function topThemes(
  tx: TenantDatabase,
  organizationId: string,
  options: { limit?: number; locationId?: string } = {},
): Promise<ThemeCount[]> {
  const rows = await tx
    .select({
      slug: sql<string>`topic`,
      reviewCount: sql<number>`count(*)::int`.mapWith(Number),
      averageSentiment: sql<number>`avg(${schema.reviewInsights.sentimentScore})::float`.mapWith(
        Number,
      ),
      label: sql<string | null>`max(${schema.tags.label})`,
    })
    .from(schema.reviewInsights)
    // unnest turns the topic array into rows so they can be grouped.
    .innerJoin(sql`unnest(${schema.reviewInsights.topics}) as topic`, sql`true`)
    .innerJoin(schema.reviews, eq(schema.reviews.id, schema.reviewInsights.reviewId))
    .leftJoin(
      schema.tags,
      and(eq(schema.tags.organizationId, organizationId), sql`${schema.tags.slug} = topic`),
    )
    .where(
      and(
        eq(schema.reviewInsights.organizationId, organizationId),
        options.locationId ? eq(schema.reviews.locationId, options.locationId) : undefined,
      ),
    )
    .groupBy(sql`topic`)
    .orderBy(sql`count(*) desc`)
    .limit(options.limit ?? 20);

  return rows.map((row) => ({
    slug: row.slug,
    label: row.label ?? row.slug,
    reviewCount: row.reviewCount,
    averageSentiment: Number(row.averageSentiment.toFixed(3)),
  }));
}

/**
 * Folds the themes an analysis produced into the organization's vocabulary.
 *
 * Called after an insight is written so the tag list stays current without a
 * scan. `review_count` is a running total rather than a live aggregate: the
 * themes list is rendered on every dashboard load, and counting rows across
 * an unnested array each time is work the page does not need to do.
 */
export async function syncTags(
  tx: TenantDatabase,
  organizationId: string,
  topics: string[],
  now = new Date(),
): Promise<void> {
  const unique = [...new Set(topics.map((topic) => topic.trim()).filter(Boolean))];
  if (unique.length === 0) return;

  await tx
    .insert(schema.tags)
    .values(
      unique.map((slug) => ({
        organizationId,
        slug,
        // Display label starts as the model's own wording; owners may rename it.
        label: slug,
        reviewCount: 1,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.tags.organizationId, schema.tags.slug],
      set: {
        reviewCount: sql`${schema.tags.reviewCount} + 1`,
        updatedAt: now,
      },
    });
}
