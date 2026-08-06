import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setLlmProviderForTesting } from "@/ai/client";
import { setEmbeddingProviderForTesting } from "@/ai/embeddings";
import { createStubProvider } from "@/ai/providers/stub";
import { connectSource } from "@/connectors/sync";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { EMBEDDING_DIMENSIONS } from "@/db/schema";
import { weekWindow } from "@/digest/metrics";
import { generateDigest, MIN_ANALYSED_REVIEWS, type DigestPayload } from "@/digest/pipeline";
import {
  actionCompletionRecord,
  digestProgress,
  latestDigest,
  listDigests,
  RECORD_DIGESTS,
  setActionStatus,
} from "@/digest/queries";
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

/**
 * Tops a fixture up past `MIN_ANALYSED_REVIEWS` (W1.6).
 *
 * The pipeline now declines to compose a briefing from fewer than five
 * analysed reviews — three is an anecdote, and the audit's filler digest came
 * from exactly that. Suites that test *composition* therefore have to hand it a
 * real week's worth; the refusal itself is tested on its own below.
 *
 * Deliberately neutral filler on its own theme, so it adds volume without
 * moving any assertion about the themes a suite actually cares about.
 */
async function padToThreshold(
  fixture: Fixture,
  options: { axis?: number; postedAt?: Date } = {},
): Promise<void> {
  for (let index = 0; index < MIN_ANALYSED_REVIEWS; index += 1) {
    await addReview(fixture, {
      rating: 4,
      text: `Dolgu yorumu ${index + 1}: yer fena değildi.`,
      topics: ["genel"],
      sentiment: "neutral",
      score: 0.05,
      axis: options.axis ?? 6,
      ...(options.postedAt ? { postedAt: options.postedAt } : {}),
    });
  }
}

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
    // Past `MIN_ANALYSED_REVIEWS` (W1.6). Three analysed reviews is an
    // anecdote, and the pipeline now declines to compose a briefing from one —
    // so a fixture that tests *composition* has to give it a real week's worth.
    await addReview(fixture, {
      rating: 4,
      text: "Kahve güzeldi ama masalar biraz kirliydi.",
      topics: ["temizlik"],
      sentiment: "neutral",
      score: 0.1,
      axis: 2,
    });
    await addReview(fixture, {
      rating: 2,
      text: "Siparişimiz karıştı, servis yine yavaştı.",
      topics: ["servis"],
      sentiment: "negative",
      score: -0.7,
      axis: 0,
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
    expect(row?.reviewCount).toBe(5);
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
    expect(servis?.count).toBe(3);
    expect(servis?.negative).toBe(3);
    expect(servis?.quotes).toHaveLength(3);

    // Worst first: an action has to answer a theme's harshest review, and the
    // owner needs the complaint verbatim more than the praise.
    expect(servis?.quotes[0]?.text).toContain("Garson hiç ilgilenmedi");
    expect(servis?.quotes[1]?.text).toContain("Servis çok yavaştı");
    expect(servis?.quotes[2]?.text).toContain("Siparişimiz karıştı");
  });

  it("never quotes the same review under two themes (W2.1)", async () => {
    // A review carries several topics, so overlapping clusters is correct —
    // but choosing each theme's quotes independently let the same worst review
    // win under every theme it belonged to. A generated digest showed `fiyat`
    // and `bekleme süresi` side by side quoting an identical pair, which reads
    // as a broken page and files a queue complaint under a heading about price.
    const row = await digestRow(fixture.orgId);
    const payload = row?.payload as DigestPayload;

    const quoted = payload.themes.flatMap((theme) => theme.quotes.map((quote) => quote.reviewId));

    expect(quoted).toHaveLength(new Set(quoted).size);
  });

  it("still gives every theme a quote, even one whose reviews are all spoken for", async () => {
    // The fallback, and it matters more than the rule: a theme with no quote is
    // a theme the model cannot ground an action in, so losing the evidence
    // would be a worse failure than repeating it.
    const row = await digestRow(fixture.orgId);
    const payload = row?.payload as DigestPayload;

    for (const theme of payload.themes) {
      expect(theme.quotes.length).toBeGreaterThan(0);
    }
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
    await padToThreshold(fixture);

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
    await padToThreshold(fixture);

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
    await padToThreshold(mine);
    const theirs = await makeFixture("progress-theirs");
    await padToThreshold(theirs);

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
    await padToThreshold(fixture);

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
    await padToThreshold(fixture);
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
    await padToThreshold(fixture);
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
    await padToThreshold(fixture);
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
    // Padded on the same two labels rather than with neutral filler, so the
    // theme count stays a statement about the merge (W1.6).
    for (let index = 0; index < 3; index += 1) {
      await addReview(fixture, {
        rating: 4,
        topics: ["personel"],
        sentiment: "positive",
        score: 0.6,
        axis: index,
      });
    }
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
    expect(payload.themes[0]?.count).toBe(6);
    expect(payload.themes[0]?.slugs).toEqual(expect.arrayContaining(["personel", "staff"]));
  });
});

describe("assets", () => {
  it("drafts replies for unanswered negatives and one social post", async () => {
    const fixture = await makeFixture("assets");
    await padToThreshold(fixture);

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
    await padToThreshold(fixture);

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
    await padToThreshold(fixture);
    const priorWindowRange = {
      start: new Date(WINDOW.start.getTime() - 7 * 24 * 60 * 60 * 1000),
      end: WINDOW.start,
    };
    // Both weeks need a real week's worth: the point of this test is that the
    // *prior* digest produced actions to report on, and a declined one has none.
    await padToThreshold(fixture, {
      postedAt: new Date(priorWindowRange.start.getTime() + 2 * 60 * 60 * 1000),
    });

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
    await padToThreshold(fixture);
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

/**
 * The running completion record (W2.1).
 *
 * `priorActionsOutcome` above is a *snapshot*, frozen into the payload when a
 * briefing is composed. This is the live read, and it answers the question the
 * digest's whole claim rests on: over the last month, how much of what we told
 * this business to do actually got done.
 *
 * Digests are inserted directly rather than generated. Every assertion here is
 * about arithmetic over stored statuses, and driving the model to produce them
 * would make the fixtures unreadable and the counts incidental.
 */
describe("the running completion record", () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  /** A ready digest `weeksAgo` before the current window, with its actions. */
  async function addDigest(
    fixture: Fixture,
    weeksAgo: number,
    actions: { status: "open" | "done" | "dismissed"; lever?: string | null }[],
  ): Promise<string> {
    const periodStart = new Date(WINDOW.start.getTime() - weeksAgo * WEEK);

    const [digest] = await getAdminDb()
      .insert(schema.digests)
      .values({
        organizationId: fixture.orgId,
        locationId: fixture.locationId,
        periodStart,
        periodEnd: new Date(periodStart.getTime() + WEEK),
        status: "ready",
        reviewCount: 5,
        generatedAt: periodStart,
      })
      .returning({ id: schema.digests.id });
    if (!digest) throw new Error("digest insert returned nothing");

    if (actions.length > 0) {
      await getAdminDb()
        .insert(schema.digestActions)
        .values(
          actions.map((action, index) => ({
            organizationId: fixture.orgId,
            digestId: digest.id,
            position: index + 1,
            text: `Eylem ${index + 1}`,
            evidence: { themeSlug: "servis", reviewIds: [] },
            lever: action.lever === undefined ? "process" : action.lever,
            status: action.status,
            ...(action.status === "open" ? {} : { completedAt: periodStart }),
          })),
        );
    }

    return digest.id;
  }

  const read = (fixture: Fixture, before: Date, digests?: number) =>
    withTenant({ organizationId: fixture.orgId }, (tx) =>
      actionCompletionRecord(tx, fixture.orgId, fixture.locationId, { before, digests }),
    );

  it("counts what was done across the recent briefings", async () => {
    const fixture = await makeFixture("record");
    await addDigest(fixture, 1, [{ status: "done" }, { status: "done" }, { status: "open" }]);
    await addDigest(fixture, 2, [{ status: "done" }, { status: "open" }, { status: "open" }]);

    const record = await read(fixture, WINDOW.start);

    expect(record).toMatchObject({ total: 6, done: 3, open: 3, dismissed: 0, digests: 2 });
  });

  it("leaves out the briefing being read", async () => {
    // The one that would otherwise make the number worst on the morning it is
    // published: this week's three actions are hours old and necessarily open.
    const fixture = await makeFixture("record-current");
    await addDigest(fixture, 0, [{ status: "open" }, { status: "open" }, { status: "open" }]);
    await addDigest(fixture, 1, [{ status: "done" }, { status: "done" }, { status: "open" }]);

    const record = await read(fixture, WINDOW.start);

    expect(record).toMatchObject({ total: 3, done: 2, digests: 1 });
  });

  it("keeps a dismissal out of the ratio", async () => {
    // Deciding a recommendation is wrong for your business is engagement, not
    // failure. Counting it done would flatter; counting it open would punish.
    const fixture = await makeFixture("record-dismissed");
    await addDigest(fixture, 1, [
      { status: "done" },
      { status: "dismissed" },
      { status: "dismissed" },
    ]);

    const record = await read(fixture, WINDOW.start);

    expect(record).toMatchObject({ total: 1, done: 1, dismissed: 2, open: 0 });
  });

  it("looks no further back than the window it claims", async () => {
    const fixture = await makeFixture("record-window");
    for (let week = 1; week <= 6; week += 1) {
      await addDigest(fixture, week, [{ status: "done" }]);
    }

    expect(await read(fixture, WINDOW.start)).toMatchObject({ digests: RECORD_DIGESTS, done: 4 });
    expect(await read(fixture, WINDOW.start, 2)).toMatchObject({ digests: 2, done: 2 });
  });

  it("says nothing at all before there is a record", async () => {
    // A business in its first fortnight must not be shown "0 of 3": that is a
    // fact about how long they have been here, not a finding about them.
    const fixture = await makeFixture("record-new");
    await addDigest(fixture, 0, [{ status: "open" }, { status: "open" }]);

    expect(await read(fixture, WINDOW.start)).toMatchObject({ total: 0, digests: 0, byLever: [] });
  });

  it("ranks which kinds of action get finished", async () => {
    const fixture = await makeFixture("record-lever");
    await addDigest(fixture, 1, [
      { status: "done", lever: "staffing" },
      { status: "open", lever: "hours" },
      { status: "open", lever: "hours" },
    ]);

    const record = await read(fixture, WINDOW.start);

    expect(record.byLever.map((entry) => entry.lever)).toEqual(["staffing", "hours"]);
    expect(record.byLever[0]).toMatchObject({ total: 1, done: 1 });
    expect(record.byLever[1]).toMatchObject({ total: 2, done: 0 });
  });

  it("counts a pre-lever action in the totals but not in the breakdown", async () => {
    // `lever` is nullable so digests written before W1.6 keep their meaning.
    // Dropping those rows from the totals would understate real work done.
    const fixture = await makeFixture("record-nolever");
    await addDigest(fixture, 1, [{ status: "done", lever: null }, { status: "done" }]);

    const record = await read(fixture, WINDOW.start);

    expect(record).toMatchObject({ total: 2, done: 2 });
    expect(record.byLever).toHaveLength(1);
  });

  it("ignores another location's briefings", async () => {
    const fixture = await makeFixture("record-scope");
    const [other] = await getAdminDb()
      .insert(schema.locations)
      .values({ organizationId: fixture.orgId, name: "Diğer Şube", locale: "tr" })
      .returning({ id: schema.locations.id });
    if (!other) throw new Error("location insert returned nothing");

    await addDigest(fixture, 1, [{ status: "done" }]);
    await addDigest({ ...fixture, locationId: other.id }, 1, [
      { status: "done" },
      { status: "done" },
    ]);

    expect(await read(fixture, WINDOW.start)).toMatchObject({ total: 1, done: 1 });
  });
});

describe("marking an action", () => {
  /**
   * The record buckets by `completed_at`, so that timestamp is the moment the
   * action stopped being open and must not move afterwards — a second press of
   * a button that is already pressed would otherwise carry a closure from one
   * month's record into the next one's.
   */
  async function anAction(fixture: Fixture): Promise<string> {
    const periodStart = new Date(WINDOW.start.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [digest] = await getAdminDb()
      .insert(schema.digests)
      .values({
        organizationId: fixture.orgId,
        locationId: fixture.locationId,
        periodStart,
        periodEnd: WINDOW.start,
        status: "ready",
        reviewCount: 1,
      })
      .returning({ id: schema.digests.id });
    if (!digest) throw new Error("digest insert returned nothing");

    const [action] = await getAdminDb()
      .insert(schema.digestActions)
      .values({
        organizationId: fixture.orgId,
        digestId: digest.id,
        position: 1,
        text: "Eylem",
        evidence: { themeSlug: "servis", reviewIds: [] },
        lever: "process",
      })
      .returning({ id: schema.digestActions.id });
    if (!action) throw new Error("action insert returned nothing");

    return action.id;
  }

  const mark = (fixture: Fixture, actionId: string, status: "open" | "done" | "dismissed") =>
    withTenant({ organizationId: fixture.orgId }, (tx) =>
      setActionStatus(tx, {
        organizationId: fixture.orgId,
        actionId,
        status,
        userId: fixture.userId,
      }),
    );

  it("does not move a completion time when it is marked done twice", async () => {
    const fixture = await makeFixture("mark-twice");
    const actionId = await anAction(fixture);

    const first = await mark(fixture, actionId, "done");
    const second = await mark(fixture, actionId, "done");

    expect(first?.completedAt).not.toBeNull();
    expect(second?.completedAt?.getTime()).toBe(first?.completedAt?.getTime());
    // `updated_at` is free to move — it records the write, not the closure.
    expect(second?.updatedAt?.getTime()).toBeGreaterThanOrEqual(first!.updatedAt!.getTime());
  });

  it("keeps the moment it was closed when done becomes dismissed", async () => {
    const fixture = await makeFixture("mark-change");
    const actionId = await anAction(fixture);

    const done = await mark(fixture, actionId, "done");
    const dismissed = await mark(fixture, actionId, "dismissed");

    expect(dismissed?.status).toBe("dismissed");
    expect(dismissed?.completedAt?.getTime()).toBe(done?.completedAt?.getTime());
  });

  it("clears the completion when an action is reopened, and takes a fresh one after", async () => {
    const fixture = await makeFixture("mark-reopen");
    const actionId = await anAction(fixture);

    const done = await mark(fixture, actionId, "done");
    const reopened = await mark(fixture, actionId, "open");
    const redone = await mark(fixture, actionId, "done");

    expect(reopened?.completedAt).toBeNull();
    expect(reopened?.completedByUserId).toBeNull();
    // Reopening is a real change of mind, so the second closure is a new one.
    expect(redone?.completedAt?.getTime()).toBeGreaterThan(done!.completedAt!.getTime());
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

    // Not padded: this test counts what fell *inside* the window, and filler
    // would be counted too. It asserts the window filter, not composition, so
    // the digest declining for thin data is fine here.
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
    await padToThreshold(fixture);
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
    await padToThreshold(fixture);
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
    await padToThreshold(fixture);
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
    await padToThreshold(mine);
    const theirs = await makeFixture("iso-theirs");
    await padToThreshold(theirs);

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
    await padToThreshold(mine);
    const theirs = await makeFixture("iso-action-theirs");
    await padToThreshold(theirs);

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
