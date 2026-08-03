import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setLlmProviderForTesting } from "@/ai/client";
import { setEmbeddingProviderForTesting } from "@/ai/embeddings";
import { analyzeBatch } from "@/ai/analysis-run";
import { createStubProvider } from "@/ai/providers/stub";
import type { LlmProvider, LlmRequest, LlmResponse } from "@/ai/types";
import { connectSource } from "@/connectors/sync";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { EMBEDDING_DIMENSIONS } from "@/db/schema";
import { generateDigest } from "@/digest/pipeline";
import { withTenant } from "@/lib/tenancy";
import { draftReplyForReview } from "@/replies/service";

/**
 * No cross-tenant context in any prompt (P1a-T11).
 *
 * The Definition of Done asks for "tenant scoping of every AI call (no
 * cross-org context)". Every other test in this repository checks that a
 * *query* is scoped; this one checks the thing that would actually be
 * catastrophic — that one business's customers never end up described in a
 * prompt sent on behalf of another.
 *
 * It works by recording every request the provider receives. Two organizations
 * are seeded with reviews carrying unmistakable marker strings, then each AI
 * path is run for one of them and every captured prompt is searched for the
 * other's markers. That is a stronger claim than "the query had a WHERE clause":
 * it holds no matter how the context was assembled.
 *
 * A leak here would not be a permissions bug an owner could notice. It would be
 * one restaurant's complaints quietly informing a competitor's weekly briefing.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

/** Strings that cannot occur by chance, so a substring match is conclusive. */
const MINE_MARKER = `MINEMARK${suffix.toUpperCase()}`;
const THEIRS_MARKER = `THEIRSMARK${suffix.toUpperCase()}`;

/** A provider that answers like the stub and keeps every request it saw. */
function recordingProvider(): LlmProvider & { requests: LlmRequest[] } {
  const inner = createStubProvider();
  const requests: LlmRequest[] = [];

  return {
    name: inner.name,
    model: inner.model,
    requestsPerMinute: null,
    requests,
    complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      requests.push(request);
      return inner.complete(request, signal);
    },
  };
}

/** Everything the provider was sent, flattened — system prompts included. */
function transcript(provider: { requests: LlmRequest[] }): string {
  return provider.requests
    .map((request) => `${request.system ?? ""} ${request.messages.map((m) => m.text).join(" ")}`)
    .join("\n");
}

type Fixture = { orgId: string; locationId: string; userId: string };

let counter = 0;

async function makeFixture(label: string, marker: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Scope ${label} ${suffix}`, slug: `scope-${label}-${suffix}`, locale: "tr" })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Şubesi` })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  const [user] = await getAdminDb()
    .insert(schema.users)
    .values({ email: `scope-${label}-${suffix}@example.test`, name: label, emailVerified: true })
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

  // Several reviews, each carrying the marker, so any path that gathered
  // context across tenants would pick one of them up.
  for (let index = 0; index < 3; index += 1) {
    const [review] = await getAdminDb()
      .insert(schema.reviews)
      .values({
        organizationId: org.id,
        locationId: location.id,
        source: "mock",
        sourceReviewId: `scope-${suffix}-${counter++}`,
        authorName: "Mehmet",
        rating: index === 0 ? 1 : 4,
        text: `${marker} — servis hakkında bir yorum, numara ${index}.`,
        language: "tr",
        postedAt: new Date(Date.now() - (index + 1) * 3_600_000),
        rawPayload: {},
      })
      .returning({ id: schema.reviews.id });

    await getAdminDb()
      .insert(schema.reviewInsights)
      .values({
        organizationId: org.id,
        reviewId: review!.id,
        sentiment: index === 0 ? "negative" : "positive",
        sentimentScore: index === 0 ? -0.8 : 0.7,
        topics: ["servis"],
        language: "tr",
        embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, (_, dim) => (dim === 0 ? 1 : 0)),
        promptId: "test@1",
        model: "test",
        contentHash: null,
      });
  }

  return { orgId: org.id, locationId: location.id, userId: user.id };
}

let mine: Fixture;
let theirs: Fixture;

beforeAll(async () => {
  mine = await makeFixture("mine", MINE_MARKER);
  theirs = await makeFixture("theirs", THEIRS_MARKER);

  setEmbeddingProviderForTesting({
    name: "test",
    model: "test",
    async embed(texts: string[]) {
      return texts.map(() =>
        Array.from({ length: EMBEDDING_DIMENSIONS }, (_, dim) => (dim === 0 ? 1 : 0)),
      );
    },
  });
});

afterEach(() => {
  setLlmProviderForTesting(null);
});

afterAll(async () => {
  setEmbeddingProviderForTesting(null);
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await getAdminDb().delete(schema.users).where(inArray(schema.users.id, userIds));
  await closeDatabasePools();
});

describe("analysis", () => {
  it("sends only the analyzed tenant's text", async () => {
    const provider = recordingProvider();
    setLlmProviderForTesting(provider);

    await analyzeBatch({
      organizationId: mine.orgId,
      recompute: true,
      requestsPerMinute: 6_000,
      sleep: async () => {},
    });

    const sent = transcript(provider);

    expect(provider.requests.length).toBeGreaterThan(0);
    expect(sent).toContain(MINE_MARKER);
    expect(sent).not.toContain(THEIRS_MARKER);
  });
});

describe("reply drafting", () => {
  it("sends only the review being answered", async () => {
    const provider = recordingProvider();
    setLlmProviderForTesting(provider);

    const [review] = await getAdminDb()
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(eq(schema.reviews.organizationId, mine.orgId))
      .limit(1);

    await withTenant({ organizationId: mine.orgId, userId: mine.userId }, (tx) =>
      draftReplyForReview({
        tx,
        organizationId: mine.orgId,
        actorUserId: mine.userId,
        reviewId: review!.id,
      }),
    );

    const sent = transcript(provider);

    // A reply prompt has no reason to hold any other review at all — not even
    // another of this tenant's.
    expect(sent).toContain(MINE_MARKER);
    expect(sent).not.toContain(THEIRS_MARKER);
  });
});

describe("the digest", () => {
  it("composes from one tenant's reviews only", async () => {
    const provider = recordingProvider();
    setLlmProviderForTesting(provider);

    const now = new Date();
    const window = {
      start: new Date(now.getTime() - 7 * 86_400_000),
      end: new Date(now.getTime() + 86_400_000),
    };

    await generateDigest({
      organizationId: mine.orgId,
      locationId: mine.locationId,
      window,
      now,
      withAssets: true,
      force: true,
    });

    const sent = transcript(provider);

    // The digest is the widest-reaching prompt in the product: it gathers a
    // window of reviews, clusters them and quotes them. If any AI call were
    // going to cross a tenant boundary, it would be this one.
    expect(provider.requests.length).toBeGreaterThan(0);
    expect(sent).toContain(MINE_MARKER);
    expect(sent).not.toContain(THEIRS_MARKER);
  });

  it("does not leak through the quotes it selects", async () => {
    const provider = recordingProvider();
    setLlmProviderForTesting(provider);

    const now = new Date();
    const window = {
      start: new Date(now.getTime() - 7 * 86_400_000),
      end: new Date(now.getTime() + 86_400_000),
    };

    await generateDigest({
      organizationId: theirs.orgId,
      locationId: theirs.locationId,
      window,
      now,
      withAssets: true,
      force: true,
    });

    // Run from the other side too: a scoping bug that happened to favour the
    // first fixture would pass the previous test and fail here.
    const sent = transcript(provider);
    expect(sent).toContain(THEIRS_MARKER);
    expect(sent).not.toContain(MINE_MARKER);
  });
});

describe("the audit trail", () => {
  async function auditCount(organizationId: string): Promise<number> {
    const rows = await getAdminDb()
      .select({ id: schema.auditLogs.id })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, organizationId));
    return rows.length;
  }

  it("attributes every AI call to the tenant that made it", async () => {
    setLlmProviderForTesting(createStubProvider());

    // A delta, not an absolute: earlier tests in this file legitimately wrote
    // rows for both fixtures. Asserting zero would be measuring test order.
    const before = { mine: await auditCount(mine.orgId), theirs: await auditCount(theirs.orgId) };

    await analyzeBatch({
      organizationId: mine.orgId,
      recompute: true,
      requestsPerMinute: 6_000,
      sleep: async () => {},
    });

    const after = { mine: await auditCount(mine.orgId), theirs: await auditCount(theirs.orgId) };

    expect(after.mine).toBeGreaterThan(before.mine);
    // Analysing one tenant's reviews must not write a single row against
    // another's — the audit log is what a KVKK request is answered from.
    expect(after.theirs).toBe(before.theirs);
  });

  it("never writes the customer's words into the audit meta", async () => {
    const rows = await getAdminDb()
      .select({ meta: schema.auditLogs.meta })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, mine.orgId));

    // An append-only log is the worst possible second copy of personal data:
    // it is exactly the store you cannot easily erase from.
    for (const row of rows) {
      expect(JSON.stringify(row.meta)).not.toContain(MINE_MARKER);
    }
  });
});
