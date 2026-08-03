import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setLlmProviderForTesting } from "@/ai/client";
import { setEmbeddingProviderForTesting } from "@/ai/embeddings";
import { createStubProvider } from "@/ai/providers/stub";
import { connectSource } from "@/connectors/sync";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { EMBEDDING_DIMENSIONS } from "@/db/schema";
import { weekWindow } from "@/digest/metrics";
import { generateDigest, type DigestPayload } from "@/digest/pipeline";
import { digestProgress, latestDigest, listDigests, setActionStatus } from "@/digest/queries";
import { currentPeriod } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";

/**
 * The Action Digest pipeline end to end (P1a-T7).
 *
 * The Definition of Done: "a digest object is generated per location on
 * schedule and on demand, is reproducible from stored data, and includes
 * exactly 3 concrete, evidence-linked actions + assets."
 *
 * Each clause gets a group below. "Reproducible" is tested as it is claimed —
 * the computed numbers are identical across regenerations; the composed prose
 * is persisted rather than recomputed, which is a different guarantee and the
 * only honest one to make about a language model.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

/** Last completed week, relative to a fixed clock so the test cannot drift. */
const NOW = new Date("2026-07-22T12:00:00Z");
const WINDOW = weekWindow(NOW);

type Fixture = { orgId: string; locationId: string; userId: string };

let counter = 0;

async function makeFixture(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Digest ${label} ${suffix}`, slug: `digest-${label}-${suffix}`, locale: "tr" })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Şubesi`, locale: "tr" })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  const [user] = await getAdminDb()
    .insert(schema.users)
    .values({ email: `digest-${label}-${suffix}@example.test`, name: label, emailVerified: true })
    .returning({ id: schema.users.id });
  if (!user) throw new Error("user insert returned nothing");
  userIds.push(user.id);

  await getAdminDb()
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: user.id, role: "owner" });

  await withTenant({ organizationId: org.id }, (tx) =>
    connectSource(tx, {
      organizationId: org.id,
      provider: "mock",
      config: { locationId: location.id, backfillCount: 0 },
    }),
  );

  return { orgId: org.id, locationId: location.id, userId: user.id };
}

/** A unit vector along one axis — predictable similarity for clustering. */
function vector(axis: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => (index === axis ? 1 : 0));
}

async function addReview(
  fixture: Fixture,
  options: {
    rating: number | null;
    text?: string | null;
    topics?: string[];
    sentiment?: "positive" | "neutral" | "negative";
    score?: number;
    axis?: number;
    postedAt?: Date;
    daysAgo?: number;
  },
): Promise<string> {
  const postedAt =
    options.postedAt ??
    new Date(WINDOW.start.getTime() + (options.daysAgo ?? 1) * 24 * 60 * 60 * 1000);

  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      source: "mock",
      sourceReviewId: `d-${suffix}-${counter++}`,
      authorName: "Mehmet",
      rating: options.rating,
      text: options.text === undefined ? "Servis hakkında bir yorum." : options.text,
      language: "tr",
      postedAt,
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });
  if (!review) throw new Error("review insert returned nothing");

  if (options.topics) {
    await getAdminDb()
      .insert(schema.reviewInsights)
      .values({
        organizationId: fixture.orgId,
        reviewId: review.id,
        sentiment: options.sentiment ?? "neutral",
        sentimentScore: options.score ?? 0,
        topics: options.topics,
        language: "tr",
        ...(options.axis === undefined ? {} : { embedding: vector(options.axis) }),
        promptId: "test@1",
        model: "test",
      });
  }

  return review.id;
}

async function digestRow(orgId: string) {
  const [row] = await getAdminDb()
    .select()
    .from(schema.digests)
    .where(eq(schema.digests.organizationId, orgId));
  return row;
}

async function actionRows(orgId: string) {
  return getAdminDb()
    .select()
    .from(schema.digestActions)
    .where(eq(schema.digestActions.organizationId, orgId))
    .orderBy(schema.digestActions.position);
}

beforeAll(() => {
  setLlmProviderForTesting(createStubProvider());
});

afterAll(async () => {
  setLlmProviderForTesting(null);
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await getAdminDb().delete(schema.users).where(inArray(schema.users.id, userIds));
  await closeDatabasePools();
});

describe("generating a digest", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("basic");

    await addReview(fixture, {
      rating: 2,
      text: "Servis çok yavaştı, yarım saat bekledik.",
      topics: ["servis"],
      sentiment: "negative",
      score: -0.8,
      axis: 0,
    });
    await addReview(fixture, {
      rating: 1,
      text: "Garson hiç ilgilenmedi, bir daha gelmeyiz.",
      topics: ["servis"],
      sentiment: "negative",
      score: -0.9,
      axis: 0,
    });
    await addReview(fixture, {
      rating: 5,
      text: "Kahvaltı tabağı çok zengindi, fiyatına göre gayet iyi.",
      topics: ["kahvaltı"],
      sentiment: "positive",
      score: 0.9,
      axis: 4,
    });

    await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      actorUserId: fixture.userId,
      window: WINDOW,
      now: NOW,
    });
  });

  it("produces a ready digest for the window", async () => {
    const row = await digestRow(fixture.orgId);

    expect(row?.status).toBe("ready");
    expect(row?.reviewCount).toBe(3);
    expect(row?.periodStart.toISOString()).toBe(WINDOW.start.toISOString());
    expect(row?.generatedAt).not.toBeNull();
  });

  it("computes a pulse the model did not invent", async () => {
    const row = await digestRow(fixture.orgId);

    // Two 1-2 star negatives and one 5-star: firmly in the lower half. The
    // number comes from code, not from the briefing text.
    const pulse = row?.pulseScore ?? -1;
    expect(pulse).toBeGreaterThan(0);
    expect(pulse).toBeLessThan(50);
  });

  it("writes exactly three actions, each linked to real evidence", async () => {
    const actions = await actionRows(fixture.orgId);

    // "exactly 3 concrete, evidence-linked actions", from the Definition of
    // Done — not "up to three".
    expect(actions).toHaveLength(3);
    expect(actions.map((row) => row.position)).toEqual([1, 2, 3]);

    for (const action of actions) {
      const evidence = action.evidence as { themeSlug: string; reviewIds: string[] };
      expect(evidence.themeSlug.length).toBeGreaterThan(0);
      expect(evidence.reviewIds.length).toBeGreaterThan(0);
    }
  });

  it("points its evidence at reviews that actually exist", async () => {
    const actions = await actionRows(fixture.orgId);
    const cited = new Set(
      actions.flatMap((action) => (action.evidence as { reviewIds: string[] }).reviewIds),
    );

    const found = await getAdminDb()
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(inArray(schema.reviews.id, [...cited]));

    // A dangling id would make "evidence-linked" a label rather than a fact.
    expect(found).toHaveLength(cited.size);
  });

  it("carries themes with real quotes", async () => {
    const row = await digestRow(fixture.orgId);
    const payload = row?.payload as DigestPayload;

    expect(payload.themes.length).toBeGreaterThan(0);

    const servis = payload.themes.find((theme) => theme.label === "servis");
    expect(servis?.count).toBe(2);
    expect(servis?.negative).toBe(2);
    expect(servis?.quotes).toHaveLength(2);

    // Worst first: an action has to answer a theme's harshest review, and the
    // owner needs the complaint verbatim more than the praise.
    expect(servis?.quotes[0]?.text).toContain("Garson hiç ilgilenmedi");
    expect(servis?.quotes[1]?.text).toContain("Servis çok yavaştı");
  });

  it("records the prompt revision and model that composed it", async () => {
    const row = await digestRow(fixture.orgId);

    expect(row?.promptId).toBe("action_digest@1");
    expect(row?.model).toBe("stub-1");
    expect(row?.locale).toBe("tr");
  });
});

describe("progress", () => {
  /**
   * What the Home button polls while a digest is being composed.
   *
   * It exists because Home renders the newest *ready* digest, so during a
   * regeneration the screen shows the previous week and has no other way to
   * know that a new one is on its way.
   */

  it("says none when nothing has been asked for", async () => {
    const fixture = await makeFixture("progress-none");

    const progress = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      digestProgress(tx, fixture.orgId, fixture.locationId, WINDOW.start),
    );

    // Distinct from `pending`: nothing is running, so a watcher should not wait
    // for something that was never queued.
    expect(progress).toEqual({ status: "none", generatedAt: null });
  });

  it("reports a claimed row as pending before it is composed", async () => {
    const fixture = await makeFixture("progress-pending");

    // The claim the pipeline makes before spending anything on the model.
    await getAdminDb().insert(schema.digests).values({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      periodStart: WINDOW.start,
      periodEnd: WINDOW.end,
      status: "pending",
      reviewCount: 0,
    });

    const progress = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      digestProgress(tx, fixture.orgId, fixture.locationId, WINDOW.start),
    );

    expect(progress.status).toBe("pending");
    expect(progress.generatedAt).toBeNull();
  });

  it("reports ready with the time it was composed", async () => {
    const fixture = await makeFixture("progress-ready");

    await addReview(fixture, {
      rating: 4,
      text: "Kahve güzeldi, servis hızlıydı.",
      topics: ["kahve"],
      sentiment: "positive",
      score: 0.7,
      axis: 2,
    });

    await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      actorUserId: fixture.userId,
      window: WINDOW,
      now: NOW,
    });

    const progress = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      digestProgress(tx, fixture.orgId, fixture.locationId, WINDOW.start),
    );

    // `ready` is the signal the button refreshes on, so a null `generatedAt`
    // here would mean refreshing onto a digest with no compose time to show.
    expect(progress.status).toBe("ready");
    expect(progress.generatedAt).not.toBeNull();
  });

  it("answers only for the caller's own organization", async () => {
    const mine = await makeFixture("progress-mine");
    const theirs = await makeFixture("progress-theirs");

    await getAdminDb().insert(schema.digests).values({
      organizationId: theirs.orgId,
      locationId: theirs.locationId,
      periodStart: WINDOW.start,
      periodEnd: WINDOW.end,
      status: "ready",
      reviewCount: 5,
    });

    // Someone else's location id, asked for under my tenant context. RLS should
    // make this indistinguishable from a digest that does not exist — a status
    // leak would confirm that another business had a digest that week.
    const progress = await withTenant({ organizationId: mine.orgId }, (tx) =>
      digestProgress(tx, mine.orgId, theirs.locationId, WINDOW.start),
    );

    expect(progress.status).toBe("none");
  });
});

describe("reproducibility", () => {
  it("computes identical numbers on a regeneration", async () => {
    const fixture = await makeFixture("repro");

    await addReview(fixture, {
      rating: 4,
      topics: ["servis"],
      sentiment: "positive",
      score: 0.5,
      axis: 0,
    });
    await addReview(fixture, {
      rating: 2,
      topics: ["fiyat"],
      sentiment: "negative",
      score: -0.6,
      axis: 3,
    });

    const args = {
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: WINDOW,
      now: NOW,
    };

    await generateDigest(args);
    const first = await digestRow(fixture.orgId);

    await generateDigest({ ...args, force: true });
    const second = await digestRow(fixture.orgId);

    // The claim is about the computed half: pulse, counts and theme structure
    // are pure functions of stored rows. The prose is persisted, not
    // recomputed — asserting byte-identical model output would be a claim
    // about someone else's sampler.
    expect(second?.pulseScore).toBe(first?.pulseScore);
    expect(second?.reviewCount).toBe(first?.reviewCount);
    expect((second?.payload as DigestPayload).themes).toEqual(
      (first?.payload as DigestPayload).themes,
    );
  });

  it("keeps one digest per location and window", async () => {
    const fixture = await makeFixture("one-per-week");
    await addReview(fixture, { rating: 5, topics: ["servis"], sentiment: "positive", score: 0.8 });

    const args = {
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: WINDOW,
      now: NOW,
    };

    await generateDigest(args);
    await generateDigest({ ...args, force: true });

    const rows = await getAdminDb()
      .select()
      .from(schema.digests)
      .where(eq(schema.digests.organizationId, fixture.orgId));

    expect(rows).toHaveLength(1);
  });

  it("replaces the previous actions rather than accumulating them", async () => {
    const fixture = await makeFixture("replace-actions");
    await addReview(fixture, { rating: 2, topics: ["servis"], sentiment: "negative", score: -0.7 });

    const args = {
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: WINDOW,
      now: NOW,
    };

    await generateDigest(args);
    await generateDigest({ ...args, force: true });

    // Six actions would leave the owner acting on a superseded briefing.
    expect(await actionRows(fixture.orgId)).toHaveLength(3);
  });

  it("does nothing on a second run without force", async () => {
    const fixture = await makeFixture("idempotent");
    await addReview(fixture, { rating: 5, topics: ["servis"], sentiment: "positive", score: 0.9 });

    const args = {
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: WINDOW,
      now: NOW,
    };

    await generateDigest(args);
    const second = await generateDigest(args);

    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("already_exists");
  });
});

describe("themes across languages", () => {
  it("merges a Turkish and an English theme that mean the same thing", async () => {
    const fixture = await makeFixture("bilingual");
    const shared = 7;

    // The pipeline embeds theme *labels*, so the merge is driven by a stub
    // provider that maps both slugs to the same vector — the offline stand-in
    // for `personel ~ staff = 0.855` on the real model.
    setEmbeddingProviderForTesting({
      name: "test",
      model: "test",
      async embed(texts: string[]) {
        return texts.map((text) =>
          text === "personel" || text === "staff" ? vector(shared) : vector(11),
        );
      },
    });

    await addReview(fixture, {
      rating: 2,
      text: "Personel ilgisizdi.",
      topics: ["personel"],
      sentiment: "negative",
      score: -0.7,
      axis: shared,
    });
    await addReview(fixture, {
      rating: 2,
      text: "The staff were not attentive.",
      topics: ["staff"],
      sentiment: "negative",
      score: -0.7,
      axis: shared,
    });
    await addReview(fixture, {
      rating: 1,
      text: "Personel yine yoktu.",
      topics: ["personel"],
      sentiment: "negative",
      score: -0.8,
      axis: shared,
    });

    await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: WINDOW,
      now: NOW,
    });

    setEmbeddingProviderForTesting(null);

    const payload = (await digestRow(fixture.orgId))?.payload as DigestPayload;

    // The follow-up flagged in T3 and T4: without this the briefing lists
    // "personel (2)" and "staff (1)" as two unrelated concerns.
    expect(payload.themes).toHaveLength(1);
    expect(payload.themes[0]?.count).toBe(3);
    expect(payload.themes[0]?.slugs).toEqual(expect.arrayContaining(["personel", "staff"]));
  });
});

describe("assets", () => {
  it("drafts replies for unanswered negatives and one social post", async () => {
    const fixture = await makeFixture("assets");

    await addReview(fixture, {
      rating: 1,
      text: "Yemek soğuktu ve servis çok yavaştı, hiç memnun kalmadık.",
      topics: ["servis"],
      sentiment: "negative",
      score: -0.9,
    });
    await addReview(fixture, {
      rating: 5,
      text: "Kahvaltı tabağı beklediğimden çok daha zengindi ve personel gerçekten ilgiliydi.",
      topics: ["kahvaltı"],
      sentiment: "positive",
      score: 0.9,
    });

    await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      actorUserId: fixture.userId,
      window: WINDOW,
      now: NOW,
    });

    const payload = (await digestRow(fixture.orgId))?.payload as DigestPayload;

    expect(payload.assets.replyDrafts).toHaveLength(1);
    expect(payload.assets.socialPost).not.toBeNull();

    // The draft is a real reply row the Inbox can pick up, not loose text.
    const [reply] = await getAdminDb()
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.id, payload.assets.replyDrafts[0]!.replyId));

    expect(reply?.status).toBe("draft");
    expect(reply?.aiGenerated).toBe(true);
  });

  it("skips the assets when the plan has spent its allowance", async () => {
    const fixture = await makeFixture("capped-assets");

    await getAdminDb().insert(schema.usageCounters).values({
      organizationId: fixture.orgId,
      metric: "ai_analyses_per_month",
      period: currentPeriod(),
      count: 250,
    });

    await addReview(fixture, {
      rating: 1,
      text: "Servis berbattı.",
      topics: ["servis"],
      sentiment: "negative",
      score: -0.9,
    });

    await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: WINDOW,
      now: NOW,
    });

    const row = await digestRow(fixture.orgId);
    const payload = row?.payload as DigestPayload;

    // The briefing is the product; the assets are a head start. Losing them to
    // a spent allowance must not lose the digest.
    expect(row?.status).toBe("ready");
    expect(payload.assets.replyDrafts).toEqual([]);
  });
});

describe("closing the loop", () => {
  it("reports what happened to the previous week's actions", async () => {
    const fixture = await makeFixture("loop");
    const priorWindowRange = {
      start: new Date(WINDOW.start.getTime() - 7 * 24 * 60 * 60 * 1000),
      end: WINDOW.start,
    };

    await addReview(fixture, {
      rating: 2,
      topics: ["servis"],
      sentiment: "negative",
      score: -0.7,
      postedAt: new Date(priorWindowRange.start.getTime() + 24 * 60 * 60 * 1000),
    });

    await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: priorWindowRange,
      now: NOW,
    });

    const priorActions = await actionRows(fixture.orgId);
    expect(priorActions).toHaveLength(3);

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      setActionStatus(tx, {
        organizationId: fixture.orgId,
        actionId: priorActions[0]!.id,
        status: "done",
        userId: fixture.userId,
      }),
    );
    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      setActionStatus(tx, {
        organizationId: fixture.orgId,
        actionId: priorActions[1]!.id,
        status: "dismissed",
        userId: fixture.userId,
      }),
    );

    await addReview(fixture, {
      rating: 4,
      topics: ["servis"],
      sentiment: "positive",
      score: 0.5,
    });

    await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: WINDOW,
      now: NOW,
    });

    const [current] = await getAdminDb()
      .select()
      .from(schema.digests)
      .where(
        and(
          eq(schema.digests.organizationId, fixture.orgId),
          eq(schema.digests.periodStart, WINDOW.start),
        ),
      );

    const outcome = (current?.payload as DigestPayload).priorActionsOutcome;

    // Without this a digest is a weekly report. With it, the next one can say
    // "you fixed the wait times, here is what is next".
    expect(outcome).toMatchObject({ total: 3, done: 1, dismissed: 1, open: 1 });
    expect(outcome?.stillOpen).toHaveLength(1);
  });

  it("computes a delta against the previous digest", async () => {
    const fixture = await makeFixture("delta");
    const earlier = {
      start: new Date(WINDOW.start.getTime() - 7 * 24 * 60 * 60 * 1000),
      end: WINDOW.start,
    };

    await addReview(fixture, {
      rating: 1,
      topics: ["servis"],
      sentiment: "negative",
      score: -0.9,
      postedAt: new Date(earlier.start.getTime() + 3600_000),
    });
    await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: earlier,
      now: NOW,
    });

    await addReview(fixture, { rating: 5, topics: ["servis"], sentiment: "positive", score: 0.9 });
    await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: WINDOW,
      now: NOW,
    });

    const [current] = await getAdminDb()
      .select()
      .from(schema.digests)
      .where(
        and(
          eq(schema.digests.organizationId, fixture.orgId),
          eq(schema.digests.periodStart, WINDOW.start),
        ),
      );

    expect(current?.pulseDelta).not.toBeNull();
    expect(current?.pulseDelta ?? 0).toBeGreaterThan(0);
  });
});

describe("edge cases", () => {
  it("still produces a digest for a week with no reviews", async () => {
    const fixture = await makeFixture("empty");

    const result = await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: WINDOW,
      now: NOW,
    });

    // A missing row would read as a broken pipeline. The absence is the news.
    expect(result.status).toBe("ready");
    expect(result.reason).toBe("no_reviews");

    const row = await digestRow(fixture.orgId);
    expect(row?.pulseScore).toBeNull();
    expect(row?.reviewCount).toBe(0);
  });

  it("ignores reviews outside the window", async () => {
    const fixture = await makeFixture("window");

    await addReview(fixture, { rating: 5, topics: ["servis"], sentiment: "positive", score: 0.9 });
    await addReview(fixture, {
      rating: 1,
      topics: ["servis"],
      sentiment: "negative",
      score: -0.9,
      postedAt: new Date(WINDOW.end.getTime() + 3600_000),
    });

    await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: WINDOW,
      now: NOW,
    });

    expect((await digestRow(fixture.orgId))?.reviewCount).toBe(1);
  });

  it("records a failure rather than leaving the row pending", async () => {
    const fixture = await makeFixture("fail");
    await addReview(fixture, { rating: 3, topics: ["servis"], sentiment: "neutral", score: 0 });

    setLlmProviderForTesting(createStubProvider({ simulate: { failures: 99, retryable: false } }));

    const result = await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: WINDOW,
      now: NOW,
    });

    setLlmProviderForTesting(createStubProvider());

    expect(result.status).toBe("failed");

    const row = await digestRow(fixture.orgId);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBeTruthy();
  });
});

describe("reads and isolation", () => {
  it("returns the newest ready digest with its actions", async () => {
    const fixture = await makeFixture("read");
    await addReview(fixture, { rating: 4, topics: ["servis"], sentiment: "positive", score: 0.4 });

    await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: WINDOW,
      now: NOW,
    });

    const view = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      latestDigest(tx, fixture.orgId, fixture.locationId),
    );

    expect(view?.status).toBe("ready");
    expect(view?.actions).toHaveLength(3);
    expect(view?.payload?.headline.length).toBeGreaterThan(0);
  });

  it("lists a location's digest history", async () => {
    const fixture = await makeFixture("history");
    await addReview(fixture, { rating: 4, topics: ["servis"], sentiment: "positive", score: 0.4 });

    await generateDigest({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      window: WINDOW,
      now: NOW,
    });

    const history = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listDigests(tx, fixture.orgId, fixture.locationId),
    );

    expect(history).toHaveLength(1);
  });

  it("never reads another organization's digest", async () => {
    const mine = await makeFixture("iso-mine");
    const theirs = await makeFixture("iso-theirs");

    await addReview(theirs, { rating: 1, topics: ["servis"], sentiment: "negative", score: -0.9 });
    await generateDigest({
      organizationId: theirs.orgId,
      locationId: theirs.locationId,
      window: WINDOW,
      now: NOW,
    });

    const view = await withTenant({ organizationId: mine.orgId }, (tx) =>
      latestDigest(tx, mine.orgId, theirs.locationId),
    );

    // A digest concentrates a business's weak points and its customers' words
    // into one row. RLS keeps it inside the tenant.
    expect(view).toBeNull();
  });

  it("cannot close another organization's action", async () => {
    const mine = await makeFixture("iso-action-mine");
    const theirs = await makeFixture("iso-action-theirs");

    await addReview(theirs, { rating: 2, topics: ["servis"], sentiment: "negative", score: -0.5 });
    await generateDigest({
      organizationId: theirs.orgId,
      locationId: theirs.locationId,
      window: WINDOW,
      now: NOW,
    });

    const [theirAction] = await actionRows(theirs.orgId);

    const updated = await withTenant({ organizationId: mine.orgId }, (tx) =>
      setActionStatus(tx, {
        organizationId: mine.orgId,
        actionId: theirAction!.id,
        status: "done",
        userId: mine.userId,
      }),
    );

    expect(updated).toBeNull();
  });
});
