import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeBatch, clearInsights, embedMissing, selectTargets } from "@/ai/analysis-run";
import { contentHash, type EmbeddingProvider } from "@/ai/embeddings";
import { createStubProvider } from "@/ai/providers/stub";
import type { LlmProvider, LlmRequest } from "@/ai/types";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { EMBEDDING_DIMENSIONS } from "@/db/schema";
import { withTenant } from "@/lib/tenancy";

/**
 * The batch analysis runner against a real database (P1a-T3).
 *
 * The behaviours worth pinning are the ones that only show up on the *second*
 * run: does the cache actually skip work, does an edited review come back into
 * scope, does a re-analysis keep the embedding it already paid for. A batch
 * runner that quietly re-analyzes everything looks identical to a correct one
 * until the bill arrives.
 *
 * The provider is the offline stub, so these tests describe our orchestration,
 * not Google's model. Model quality is `pnpm ai:eval`.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

/** Never sleeps: pacing is asserted by inspecting the requested delays. */
function instantSleep(delays: number[]) {
  return async (ms: number) => {
    delays.push(ms);
  };
}

function countingEmbeddings(): EmbeddingProvider & { calls: number; texts: string[] } {
  const provider = {
    name: "test",
    model: "test-embed",
    calls: 0,
    texts: [] as string[],
    async embed(texts: string[]): Promise<number[][]> {
      provider.calls += 1;
      provider.texts.push(...texts);
      return texts.map((_, index) =>
        Array.from({ length: EMBEDDING_DIMENSIONS }, (_, dim) => (dim === index % 8 ? 1 : 0)),
      );
    },
  };
  return provider;
}

type Fixture = { orgId: string; locationId: string; reviewIds: string[] };

async function makeOrg(label: string, texts: (string | null)[]): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Batch ${label} ${suffix}`, slug: `batch-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Şubesi` })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  // An organization with no reviews yet is a legitimate fixture: the duplicate
  // tests add their own, on locations they choose.
  if (texts.length === 0) return { orgId: org.id, locationId: location.id, reviewIds: [] };

  const reviews = await getAdminDb()
    .insert(schema.reviews)
    .values(
      texts.map((text, index) => ({
        organizationId: org.id,
        locationId: location.id,
        source: "mock" as const,
        sourceReviewId: `${label}-${suffix}-${index}`,
        rating: (index % 5) + 1,
        text,
        rawPayload: {},
      })),
    )
    .returning({ id: schema.reviews.id });

  return { orgId: org.id, locationId: location.id, reviewIds: reviews.map((row) => row.id) };
}

/** The stub, with a tally — the number these tests are actually about. */
function countingProvider(model = "stub-1"): LlmProvider & { calls: number } {
  const stub = createStubProvider({ model });
  const provider = {
    name: stub.name,
    model,
    requestsPerMinute: null,
    calls: 0,
    complete(request: LlmRequest, signal: AbortSignal) {
      provider.calls += 1;
      return stub.complete(request, signal);
    },
  };
  return provider;
}

/** A second branch in an existing organization, optionally in another vertical. */
async function addLocation(orgId: string, name: string, category?: string): Promise<string> {
  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: orgId, name, ...(category ? { category } : {}) })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");
  return location.id;
}

let reviewCounter = 0;

async function addReview(orgId: string, locationId: string, text: string): Promise<string> {
  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: orgId,
      locationId,
      source: "mock" as const,
      sourceReviewId: `dup-${suffix}-${reviewCounter++}`,
      rating: 5,
      text,
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });
  if (!review) throw new Error("review insert returned nothing");
  return review.id;
}

function run(orgId: string, overrides: Record<string, unknown> = {}) {
  return analyzeBatch({
    organizationId: orgId,
    provider: createStubProvider(),
    requestsPerMinute: 6000,
    concurrency: 2,
    sleep: async () => {},
    ...overrides,
  });
}

async function insightsFor(orgId: string) {
  return getAdminDb()
    .select()
    .from(schema.reviewInsights)
    .where(eq(schema.reviewInsights.organizationId, orgId));
}

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("selecting what to analyze", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeOrg("select", [
      "Servis çok yavaştı",
      "The coffee was excellent",
      null,
      "   ",
    ]);
  });

  it("skips reviews with no text to analyze", async () => {
    const targets = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      selectTargets(tx, { organizationId: fixture.orgId }),
    );

    // A rating-only review and a whitespace-only one have nothing to say;
    // sending them costs a call and produces a hallucinated theme.
    expect(targets).toHaveLength(2);
  });

  it("returns nothing once everything is analyzed", async () => {
    await run(fixture.orgId);

    const targets = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      selectTargets(tx, { organizationId: fixture.orgId }),
    );

    expect(targets).toEqual([]);
  });

  it("returns everything again when recomputing", async () => {
    const targets = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      selectTargets(tx, { organizationId: fixture.orgId, recompute: true }),
    );

    expect(targets).toHaveLength(2);
  });
});

describe("the cache", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeOrg("cache", ["Kahve güzeldi", "Servis yavaştı", "Great view"]);
  });

  it("analyzes everything on the first run and stores the content hash", async () => {
    const result = await run(fixture.orgId);

    expect(result.analyzed).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    const rows = await insightsFor(fixture.orgId);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.contentHash !== null)).toBe(true);
  });

  it("does no work at all on a second run", async () => {
    const result = await run(fixture.orgId);

    // The whole point of the hash. If this ever reports analyzed: 3, the SQL
    // digest and the TS digest have drifted apart.
    expect(result.analyzed).toBe(0);
    expect(result.skipped).toBe(3);
  });

  it("re-analyzes only the review whose text changed", async () => {
    await getAdminDb()
      .update(schema.reviews)
      .set({ text: "Kahve soğuktu ve servis berbattı" })
      .where(eq(schema.reviews.id, fixture.reviewIds[0]!));

    const result = await run(fixture.orgId);

    expect(result.analyzed).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it("is not fooled by a touched updated_at", async () => {
    // The sync upsert bumps updated_at on every run whether or not anything
    // changed. A timestamp-based cache would re-analyze the corpus daily.
    await getAdminDb()
      .update(schema.reviews)
      .set({ updatedAt: new Date() })
      .where(eq(schema.reviews.organizationId, fixture.orgId));

    const result = await run(fixture.orgId);
    expect(result.analyzed).toBe(0);
  });

  it("stores a hash matching the text that was analyzed", async () => {
    const [review] = await getAdminDb()
      .select({ id: schema.reviews.id, text: schema.reviews.text })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, fixture.reviewIds[1]!));

    const [insight] = await getAdminDb()
      .select({ contentHash: schema.reviewInsights.contentHash })
      .from(schema.reviewInsights)
      .where(eq(schema.reviewInsights.reviewId, review!.id));

    expect(insight?.contentHash).toBe(contentHash(review!.text!));
  });

  it("recompute overwrites rather than duplicating", async () => {
    const result = await run(fixture.orgId, { recompute: true });

    expect(result.analyzed).toBe(3);
    expect(await insightsFor(fixture.orgId)).toHaveLength(3);
  });
});

describe("what a run writes", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeOrg("writes", ["Personel çok ilgiliydi", "Terrible wait"]);
    await run(fixture.orgId);
  });

  it("records the model and prompt revision that produced each insight", async () => {
    const rows = await insightsFor(fixture.orgId);

    // Without these an old analysis is indistinguishable from a current one
    // after a prompt change, and there is no way to know what to recompute.
    expect(rows.every((row) => row.model === "stub-1")).toBe(true);
    expect(rows.every((row) => row.promptId.startsWith("analyze_review"))).toBe(true);
  });

  it("folds the themes into the organization's tag vocabulary", async () => {
    const tags = await getAdminDb()
      .select()
      .from(schema.tags)
      .where(eq(schema.tags.organizationId, fixture.orgId));

    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((tag) => tag.reviewCount >= 1)).toBe(true);
  });

  it("gives every insight at least one topic", async () => {
    const rows = await insightsFor(fixture.orgId);
    expect(rows.every((row) => row.topics.length > 0)).toBe(true);
  });
});

describe("embeddings", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeOrg("embed", ["Yemekler harikaydı", "Bekleme çok uzundu"]);
  });

  it("embeds the batch in a single call", async () => {
    const embeddings = countingEmbeddings();
    const result = await run(fixture.orgId, { withEmbeddings: true, embeddings });

    // Two reviews, one request. Per-review embedding calls would exhaust a
    // free tier's requests-per-minute long before its token budget.
    expect(embeddings.calls).toBe(1);
    expect(result.embedded).toBe(2);
  });

  it("keeps the embedding when the analysis is recomputed without one", async () => {
    await run(fixture.orgId, { recompute: true });

    const rows = await insightsFor(fixture.orgId);
    // Analysis is cheap to redo, embeddings are not, and the two passes
    // legitimately run at different times.
    expect(rows.every((row) => row.embedding !== null)).toBe(true);
  });

  it("still stores the analysis when embedding fails", async () => {
    const failing: EmbeddingProvider = {
      name: "failing",
      model: "x",
      async embed(): Promise<number[][]> {
        throw new Error("embedding service down");
      },
    };

    const broken = await makeOrg("embed-fail", ["Manzara güzeldi"]);
    const result = await run(broken.orgId, { withEmbeddings: true, embeddings: failing });

    expect(result.analyzed).toBe(1);
    expect(result.embedded).toBe(0);

    const rows = await insightsFor(broken.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.embedding).toBeNull();
  });

  it("backfills vectors for insights that have none", async () => {
    const broken = await makeOrg("backfill", ["Fiyatlar uygun", "Park yeri yok"]);
    await run(broken.orgId);

    const embedded = await embedMissing({
      organizationId: broken.orgId,
      embeddings: countingEmbeddings(),
    });

    expect(embedded).toBe(2);

    const rows = await insightsFor(broken.orgId);
    expect(rows.every((row) => row.embedding !== null)).toBe(true);
  });
});

describe("failures", () => {
  it("records a failed review and keeps going", async () => {
    const fixture = await makeOrg("fail", ["a", "b", "c"]);

    // One retryable failure, exhausted by the client's retries, then success.
    const result = await run(fixture.orgId, {
      provider: createStubProvider({ simulate: { failures: 1, retryable: false } }),
      concurrency: 1,
    });

    // A backfill over a thousand reviews that aborts on the first oddity is a
    // backfill that never completes.
    expect(result.failed).toBe(1);
    expect(result.analyzed).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(await insightsFor(fixture.orgId)).toHaveLength(2);
  });
});

describe("pacing", () => {
  it("spaces requests across concurrent workers, not per worker", async () => {
    const fixture = await makeOrg("pace", ["a", "b", "c", "d"]);
    const delays: number[] = [];

    await analyzeBatch({
      organizationId: fixture.orgId,
      provider: createStubProvider(),
      requestsPerMinute: 60, // one per second
      concurrency: 4,
      sleep: instantSleep(delays),
    });

    // Four workers, one slot per second: the last one must wait ~3s. If each
    // worker paced itself independently they would all fire immediately.
    const longest = Math.max(...delays);
    expect(longest).toBeGreaterThanOrEqual(2_000);
    expect(delays.filter((delay) => delay > 0).length).toBeGreaterThanOrEqual(3);
  });
});

describe("tenant isolation", () => {
  it("never analyzes another organization's reviews", async () => {
    const mine = await makeOrg("mine", ["Benim yorumum"]);
    const theirs = await makeOrg("theirs", ["Their review", "Another of theirs"]);

    const result = await run(mine.orgId);

    expect(result.analyzed).toBe(1);
    expect(await insightsFor(theirs.orgId)).toHaveLength(0);
  });

  it("clears only the requested organization's insights", async () => {
    const mine = await makeOrg("clear-mine", ["Bir yorum"]);
    const theirs = await makeOrg("clear-theirs", ["Another"]);

    await run(mine.orgId);
    await run(theirs.orgId);

    const cleared = await clearInsights(mine.orgId);

    expect(cleared).toBe(1);
    expect(await insightsFor(mine.orgId)).toHaveLength(0);
    expect(await insightsFor(theirs.orgId)).toHaveLength(1);
  });

  it("scopes a run to one location when asked", async () => {
    const fixture = await makeOrg("scoped", ["First", "Second"]);

    const [other] = await getAdminDb()
      .insert(schema.locations)
      .values({ organizationId: fixture.orgId, name: "Diğer Şube" })
      .returning({ id: schema.locations.id });

    await getAdminDb()
      .update(schema.reviews)
      .set({ locationId: other!.id })
      .where(eq(schema.reviews.id, fixture.reviewIds[0]!));

    const result = await run(fixture.orgId, { locationId: other!.id });

    expect(result.analyzed).toBe(1);
    expect(await insightsFor(fixture.orgId)).toHaveLength(1);
  });
});

/**
 * Reviews that say the same thing cost one call, not one call each.
 *
 * Short reviews repeat endlessly — "Harika", "Great place 👍" — and the content
 * hash was per *review row*, so ten of them bought ten identical answers. The
 * three tests that matter are the ones about where reuse must *stop*: another
 * organization, another vertical, and a review's own row on a recompute. A
 * cache that is too eager is not a cheaper product, it is a wrong one.
 */
describe("identical reviews", () => {
  it("asks the model once and writes an insight for each", async () => {
    const fixture = await makeOrg("dup-one", ["Harika", "Harika"]);
    const provider = countingProvider();

    const result = await run(fixture.orgId, { provider });

    expect(provider.calls).toBe(1);
    expect(result.analyzed).toBe(1);
    expect(result.copied).toBe(1);
    expect(result.failed).toBe(0);

    const rows = await insightsFor(fixture.orgId);
    expect(rows).toHaveLength(2);
    // Same words, same answer — and the same cache key, so neither row comes
    // back as stale on the next run.
    expect(new Set(rows.map((row) => row.sentiment)).size).toBe(1);
    expect(new Set(rows.map((row) => row.topics.join("|"))).size).toBe(1);
    expect(new Set(rows.map((row) => row.contentHash)).size).toBe(1);
  });

  it("never reuses another organization's analysis", async () => {
    // Two businesses can receive the identical sentence. An analysis is derived
    // from a customer's words, and the tenant wall does not have exceptions for
    // cheapness.
    const mine = await makeOrg("dup-mine", ["Harika"]);
    const theirs = await makeOrg("dup-theirs", ["Harika"]);

    const mineProvider = countingProvider();
    const theirsProvider = countingProvider();

    await run(mine.orgId, { provider: mineProvider });
    await run(theirs.orgId, { provider: theirsProvider });

    expect(mineProvider.calls).toBe(1);
    expect(theirsProvider.calls).toBe(1);

    const [row] = await insightsFor(theirs.orgId);
    expect(row?.organizationId).toBe(theirs.orgId);
  });

  it("never reuses an analysis from another vertical", async () => {
    // `analyzeReviewPrompt` narrows the canonical themes to the location's
    // category (W3.2), so "Harika" at a hotel was offered `room_comfort` and
    // "Harika" at a café was not. Same words, different question.
    const fixture = await makeOrg("dup-vertical", []);
    const hotel = await addLocation(fixture.orgId, "Otel", "hotel");
    const cafe = await addLocation(fixture.orgId, "Kafe", "cafe");

    await addReview(fixture.orgId, hotel, "Harika");
    await addReview(fixture.orgId, cafe, "Harika");

    const provider = countingProvider();
    const result = await run(fixture.orgId, { provider });

    expect(provider.calls).toBe(2);
    expect(result.analyzed).toBe(2);
    expect(result.copied).toBe(0);
  });

  it("reuses an analysis stored by an earlier run, and records what produced it", async () => {
    const fixture = await makeOrg("dup-later", ["Harika"]);
    await run(fixture.orgId, { provider: countingProvider("old-model") });

    const laterId = await addReview(fixture.orgId, fixture.locationId, "Harika");

    const provider = countingProvider("new-model");
    const result = await run(fixture.orgId, { provider });

    expect(provider.calls).toBe(0);
    expect(result.analyzed).toBe(0);
    expect(result.copied).toBe(1);

    const rows = await insightsFor(fixture.orgId);
    const copied = rows.find((row) => row.reviewId === laterId);
    // The model named on the row is the one that produced the words. Writing
    // this run's model would put a model in the record that was never asked
    // about this review — and `audit_logs`, which records calls, would disagree.
    expect(copied?.model).toBe("old-model");
    expect(copied?.sentiment).toBe(rows.find((row) => row.reviewId !== laterId)?.sentiment);
  });

  it("still asks the model on a recompute, rather than copying a row from itself", async () => {
    const fixture = await makeOrg("dup-recompute", ["Harika", "Harika"]);
    await run(fixture.orgId, { provider: countingProvider() });

    const provider = countingProvider();
    const result = await run(fixture.orgId, { provider, recompute: true });

    // One call, not zero: a recompute that copied each row from itself would
    // report success and change nothing, which is the one thing the operator
    // asked it not to do.
    expect(provider.calls).toBe(1);
    expect(result.analyzed).toBe(1);
    expect(result.copied).toBe(1);
  });

  it("copies the vector too, so a duplicate is findable by the same search", async () => {
    const fixture = await makeOrg("dup-vector", ["Harika"]);
    await run(fixture.orgId, { withEmbeddings: true, embeddings: countingEmbeddings() });

    const laterId = await addReview(fixture.orgId, fixture.locationId, "Harika");
    const embeddings = countingEmbeddings();
    await run(fixture.orgId, { provider: countingProvider(), embeddings });

    // Identical text embeds identically, so no embedding call is needed — and
    // withholding the vector would leave the duplicate out of a similarity
    // search its twin is in.
    expect(embeddings.calls).toBe(0);

    const rows = await insightsFor(fixture.orgId);
    const original = rows.find((row) => row.reviewId !== laterId);
    const copied = rows.find((row) => row.reviewId === laterId);
    expect(copied?.embedding).not.toBeNull();
    expect(copied?.embedding).toEqual(original?.embedding);
  });

  it("gives every copied row a priority, not just the one that was analyzed", async () => {
    // Same text *and* same rating, so the only thing that could make the two
    // rows differ is whether the copied one was re-scored.
    const fixture = await makeOrg("dup-priority", []);
    await addReview(fixture.orgId, fixture.locationId, "Berbat");
    await addReview(fixture.orgId, fixture.locationId, "Berbat");

    await run(fixture.orgId, { provider: countingProvider() });

    const rows = await getAdminDb()
      .select({ id: schema.reviews.id, priority: schema.reviews.priority })
      .from(schema.reviews)
      .where(eq(schema.reviews.organizationId, fixture.orgId));

    // Sentiment is the strongest input to triage. A copied row carries one, so
    // it must be re-scored like any other — otherwise half a duplicate pair
    // sorts by its star rating alone.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.priority)).size).toBe(1);
  });

  it("reports every review of a group whose one call failed", async () => {
    const fixture = await makeOrg("dup-failed", ["Harika", "Harika"]);

    const result = await run(fixture.orgId, {
      provider: createStubProvider({ simulate: { failures: 1, retryable: false } }),
      concurrency: 1,
    });

    // Neither review was analysed, and both are still stale. Reporting only the
    // one that was sent would call the other a success it never was.
    expect(result.analyzed).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.failures.some((failure) => failure.reason.includes("identical to"))).toBe(true);
    expect(await insightsFor(fixture.orgId)).toHaveLength(0);
  });
});
