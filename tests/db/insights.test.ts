import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findSimilarReviews,
  insightsForReviews,
  reviewsAwaitingAnalysis,
  setEmbedding,
  syncTags,
  topThemes,
  upsertInsight,
} from "@/ai/insights";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { EMBEDDING_DIMENSIONS } from "@/db/schema";
import { withTenant } from "@/lib/tenancy";

/**
 * P1a-T2 against a real database: pgvector storage, similarity search, theme
 * rollups, and tenant isolation on derived data.
 *
 * Embeddings here are synthetic — hand-built unit vectors whose geometry is
 * known, so "is this search actually ordering by cosine distance?" has a
 * deterministic answer. Real embeddings arrive with the analysis pass in T3;
 * using them here would test Google's model rather than our index.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

/**
 * A unit vector pointing mostly along one axis.
 *
 * Two vectors built from the same axis are near-identical in cosine terms;
 * different axes are orthogonal (distance 1.0). That gives the search
 * something unambiguous to rank.
 */
function unitVector(axis: number, noise = 0): number[] {
  const values = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) =>
    index === axis ? 1 : index === axis + 1 ? noise : 0,
  );
  const magnitude = Math.hypot(...values);
  return values.map((value) => value / magnitude);
}

type Fixture = { orgId: string; locationId: string; reviewIds: string[] };

async function makeOrg(label: string, reviewCount = 3): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Insights ${label} ${suffix}`, slug: `insights-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Şubesi` })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  const reviews = await getAdminDb()
    .insert(schema.reviews)
    .values(
      Array.from({ length: reviewCount }, (_, index) => ({
        organizationId: org.id,
        locationId: location.id,
        source: "mock",
        sourceReviewId: `${label}-${suffix}-${index}`,
        rating: (index % 5) + 1,
        text: `Review ${index} for ${label}`,
        rawPayload: {},
      })),
    )
    .returning({ id: schema.reviews.id });

  return { orgId: org.id, locationId: location.id, reviewIds: reviews.map((row) => row.id) };
}

let a: Fixture;

beforeAll(async () => {
  a = await makeOrg("a", 4);
});

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("storing insights", () => {
  it("writes analysis and reads it back", async () => {
    const reviewId = a.reviewIds[0]!;

    await withTenant({ organizationId: a.orgId }, (tx) =>
      upsertInsight(tx, a.orgId, {
        reviewId,
        sentiment: "negative",
        sentimentScore: -0.7,
        topics: ["servis", "bekleme süresi"],
        language: "tr",
        promptId: "analyze_review@1",
        model: "gemini-3.5-flash-lite",
      }),
    );

    const found = await withTenant({ organizationId: a.orgId }, (tx) =>
      insightsForReviews(tx, a.orgId, [reviewId]),
    );

    const insight = found.get(reviewId);
    expect(insight?.sentiment).toBe("negative");
    expect(insight?.sentimentScore).toBeCloseTo(-0.7, 5);
    expect(insight?.topics).toEqual(["servis", "bekleme süresi"]);
    // Recorded so a quality change can be attributed to a prompt revision.
    expect(insight?.promptId).toBe("analyze_review@1");
    expect(insight?.model).toBe("gemini-3.5-flash-lite");
  });

  it("replaces a previous analysis instead of accumulating rows", async () => {
    const reviewId = a.reviewIds[1]!;

    for (const [sentiment, score] of [
      ["neutral", 0],
      ["positive", 0.8],
    ] as const) {
      await withTenant({ organizationId: a.orgId }, (tx) =>
        upsertInsight(tx, a.orgId, {
          reviewId,
          sentiment,
          sentimentScore: score,
          topics: ["x"],
          language: "en",
          promptId: "analyze_review@1",
          model: "m",
        }),
      );
    }

    const rows = await getAdminDb()
      .select()
      .from(schema.reviewInsights)
      .where(eq(schema.reviewInsights.reviewId, reviewId));

    // One insight per review: nothing downstream has to pick a winner.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sentiment).toBe("positive");
  });

  it("keeps an existing embedding through a re-analysis that has none", async () => {
    const reviewId = a.reviewIds[2]!;

    await withTenant({ organizationId: a.orgId }, async (tx) => {
      await upsertInsight(tx, a.orgId, {
        reviewId,
        sentiment: "positive",
        sentimentScore: 0.5,
        topics: ["a"],
        language: "en",
        embedding: unitVector(0),
        promptId: "analyze_review@1",
        model: "m",
      });

      // Re-analysis with a newer prompt, no embedding supplied.
      await upsertInsight(tx, a.orgId, {
        reviewId,
        sentiment: "neutral",
        sentimentScore: 0.1,
        topics: ["b"],
        language: "en",
        promptId: "analyze_review@2",
        model: "m",
      });
    });

    const [row] = await getAdminDb()
      .select()
      .from(schema.reviewInsights)
      .where(eq(schema.reviewInsights.reviewId, reviewId));

    expect(row?.promptId).toBe("analyze_review@2");
    // Embeddings are expensive; sentiment is not. Losing one to a cheap
    // re-analysis would silently drop the review out of theme clustering.
    expect(row?.embedding).not.toBeNull();
  });

  it("rejects a wrong-width vector with an explanation", async () => {
    await expect(
      withTenant({ organizationId: a.orgId }, (tx) =>
        setEmbedding(tx, a.orgId, a.reviewIds[0]!, [0.1, 0.2, 0.3]),
      ),
    ).rejects.toThrow(/768 dimensions, received 3/);
  });

  it("refuses a score outside the range the model promised", async () => {
    await expect(
      withTenant({ organizationId: a.orgId }, (tx) =>
        upsertInsight(tx, a.orgId, {
          reviewId: a.reviewIds[3]!,
          sentiment: "positive",
          sentimentScore: 7,
          topics: ["x"],
          language: "en",
          promptId: "p@1",
          model: "m",
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("vector search", () => {
  it("orders by cosine distance, nearest first", async () => {
    const target = await makeOrg("vector", 3);
    const [near, alsoNear, far] = target.reviewIds as [string, string, string];

    await withTenant({ organizationId: target.orgId }, async (tx) => {
      // Two vectors on the same axis, one orthogonal.
      await upsertInsight(tx, target.orgId, insight(near, unitVector(0)));
      await upsertInsight(tx, target.orgId, insight(alsoNear, unitVector(0, 0.05)));
      await upsertInsight(tx, target.orgId, insight(far, unitVector(400)));
    });

    const results = await withTenant({ organizationId: target.orgId }, (tx) =>
      findSimilarReviews(tx, target.orgId, unitVector(0), { limit: 3 }),
    );

    expect(results.map((row) => row.reviewId)).toEqual([near, alsoNear, far]);
    expect(results[0]?.distance).toBeCloseTo(0, 4);
    // Orthogonal vectors sit at cosine distance 1.
    expect(results[2]?.distance).toBeCloseTo(1, 3);
  });

  it("can exclude the review being compared against", async () => {
    const target = await makeOrg("exclude", 2);
    const [first, second] = target.reviewIds as [string, string];

    await withTenant({ organizationId: target.orgId }, async (tx) => {
      await upsertInsight(tx, target.orgId, insight(first, unitVector(1)));
      await upsertInsight(tx, target.orgId, insight(second, unitVector(1, 0.1)));
    });

    const results = await withTenant({ organizationId: target.orgId }, (tx) =>
      findSimilarReviews(tx, target.orgId, unitVector(1), { excludeReviewId: first }),
    );

    // "Find similar to this one" must not return the one.
    expect(results.map((row) => row.reviewId)).toEqual([second]);
  });

  it("ignores insights that have no embedding yet", async () => {
    const target = await makeOrg("partial", 2);
    const [withVector, without] = target.reviewIds as [string, string];

    await withTenant({ organizationId: target.orgId }, async (tx) => {
      await upsertInsight(tx, target.orgId, insight(withVector, unitVector(2)));
      await upsertInsight(tx, target.orgId, { ...insight(without, null), embedding: null });
    });

    const results = await withTenant({ organizationId: target.orgId }, (tx) =>
      findSimilarReviews(tx, target.orgId, unitVector(2)),
    );

    expect(results.map((row) => row.reviewId)).toEqual([withVector]);
  });

  /**
   * The failure this guards against would look completely plausible: another
   * business's reviews returned as "similar complaints", with no error.
   */
  it("never returns another organization's reviews", async () => {
    const mine = await makeOrg("iso-mine", 1);
    const theirs = await makeOrg("iso-theirs", 1);

    // Identical embeddings in both tenants.
    await withTenant({ organizationId: mine.orgId }, (tx) =>
      upsertInsight(tx, mine.orgId, insight(mine.reviewIds[0]!, unitVector(5))),
    );
    await withTenant({ organizationId: theirs.orgId }, (tx) =>
      upsertInsight(tx, theirs.orgId, insight(theirs.reviewIds[0]!, unitVector(5))),
    );

    const results = await withTenant({ organizationId: mine.orgId }, (tx) =>
      findSimilarReviews(tx, mine.orgId, unitVector(5), { limit: 10 }),
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.reviewId).toBe(mine.reviewIds[0]);
  });
});

describe("themes", () => {
  it("counts themes across reviews with their average sentiment", async () => {
    const target = await makeOrg("themes", 3);
    const [one, two, three] = target.reviewIds as [string, string, string];

    await withTenant({ organizationId: target.orgId }, async (tx) => {
      await upsertInsight(tx, target.orgId, {
        ...insight(one, null),
        topics: ["servis", "fiyat"],
        sentiment: "negative",
        sentimentScore: -1,
      });
      await upsertInsight(tx, target.orgId, {
        ...insight(two, null),
        topics: ["servis"],
        sentiment: "negative",
        sentimentScore: -0.5,
      });
      await upsertInsight(tx, target.orgId, {
        ...insight(three, null),
        topics: ["temizlik"],
        sentiment: "positive",
        sentimentScore: 1,
      });
    });

    const themes = await withTenant({ organizationId: target.orgId }, (tx) =>
      topThemes(tx, target.orgId),
    );

    expect(themes[0]).toMatchObject({ slug: "servis", reviewCount: 2 });
    // (-1 + -0.5) / 2
    expect(themes[0]?.averageSentiment).toBeCloseTo(-0.75, 2);
    expect(themes.map((theme) => theme.slug).sort()).toEqual(["fiyat", "servis", "temizlik"]);
  });

  it("builds the tag vocabulary and counts repeats", async () => {
    const target = await makeOrg("tags", 1);

    await withTenant({ organizationId: target.orgId }, async (tx) => {
      await syncTags(tx, target.orgId, ["servis", "fiyat"]);
      await syncTags(tx, target.orgId, ["servis"]);
    });

    const rows = await getAdminDb()
      .select()
      .from(schema.tags)
      .where(eq(schema.tags.organizationId, target.orgId));

    const servis = rows.find((row) => row.slug === "servis");
    expect(rows).toHaveLength(2);
    expect(servis?.reviewCount).toBe(2);
    // Label starts as the model's own wording, editable later.
    expect(servis?.label).toBe("servis");
  });

  it("shows an owner's renamed label while counting the model's raw tag", async () => {
    const target = await makeOrg("relabel", 1);

    await withTenant({ organizationId: target.orgId }, async (tx) => {
      await upsertInsight(tx, target.orgId, {
        ...insight(target.reviewIds[0]!, null),
        topics: ["servis"],
      });
      await syncTags(tx, target.orgId, ["servis"]);
      await tx
        .update(schema.tags)
        .set({ label: "Müşteri Hizmetleri" })
        .where(eq(schema.tags.slug, "servis"));
    });

    const themes = await withTenant({ organizationId: target.orgId }, (tx) =>
      topThemes(tx, target.orgId),
    );

    // The evidence keeps the model's word; the display follows the owner.
    expect(themes[0]?.slug).toBe("servis");
    expect(themes[0]?.label).toBe("Müşteri Hizmetleri");
  });
});

describe("backfill queue", () => {
  it("lists only reviews with no analysis yet", async () => {
    const target = await makeOrg("backfill", 3);
    const [analyzed] = target.reviewIds as [string];

    await withTenant({ organizationId: target.orgId }, (tx) =>
      upsertInsight(tx, target.orgId, insight(analyzed, null)),
    );

    const pending = await withTenant({ organizationId: target.orgId }, (tx) =>
      reviewsAwaitingAnalysis(tx, target.orgId),
    );

    expect(pending).toHaveLength(2);
    expect(pending.map((row) => row.id)).not.toContain(analyzed);
  });
});

describe("tenant isolation", () => {
  it("hides insights from another organization", async () => {
    const mine = await makeOrg("hidden-mine", 1);
    const theirs = await makeOrg("hidden-theirs", 1);

    await withTenant({ organizationId: mine.orgId }, (tx) =>
      upsertInsight(tx, mine.orgId, insight(mine.reviewIds[0]!, null)),
    );

    const seen = await withTenant({ organizationId: theirs.orgId }, (tx) =>
      tx.select().from(schema.reviewInsights),
    );

    // RLS, not a where clause: the row is invisible, not merely unqueried.
    expect(seen).toHaveLength(0);
  });

  it("hides the tag vocabulary too", async () => {
    const mine = await makeOrg("tagiso-mine", 1);
    const theirs = await makeOrg("tagiso-theirs", 1);

    await withTenant({ organizationId: mine.orgId }, (tx) =>
      syncTags(tx, mine.orgId, ["gizli-tema"]),
    );

    const seen = await withTenant({ organizationId: theirs.orgId }, (tx) =>
      tx.select().from(schema.tags),
    );

    expect(seen).toHaveLength(0);
  });
});

/** A minimal insight, so each test states only what it cares about. */
function insight(reviewId: string, embedding: number[] | null) {
  return {
    reviewId,
    sentiment: "neutral" as const,
    sentimentScore: 0,
    topics: ["genel"],
    language: "tr",
    embedding,
    promptId: "analyze_review@1",
    model: "test-model",
  };
}
