import { afterEach, describe, expect, it } from "vitest";
import { setLlmProviderForTesting } from "@/ai/client";
import { createStubProvider } from "@/ai/providers/stub";
import { clearSampleCache, getSampleDigest } from "@/digest/sample";
import { samplePriorReviews, sampleReviews, SAMPLE_BUSINESS } from "@/digest/sample-data";
import { DIGEST_ACTION_COUNT } from "@/prompts/index";

/**
 * The public sample digest (P1a-T10).
 *
 * Two properties matter more than the copy. It must **touch no database** — an
 * unauthenticated page that reads tenant rows is one mistake away from showing
 * a real customer's words to a stranger — and it must **render on a bad day**,
 * because a marketing page that 500s when a third party is slow is worse than
 * one showing a written briefing over real numbers.
 *
 * Note this file lives in the unit suite, not `tests/db`. That placement is the
 * assertion: if the sample ever grew a query, it would fail here for want of a
 * connection.
 */

afterEach(() => {
  setLlmProviderForTesting(null);
  clearSampleCache();
});

const NOW = new Date("2026-07-22T12:00:00Z");

describe("the demo corpus", () => {
  it("is invented, not borrowed from a tenant", () => {
    const reviews = sampleReviews(NOW);

    // Ids are synthetic strings, not uuids: nothing here came out of the
    // database, and nothing here can be traced to a real person.
    expect(reviews.length).toBeGreaterThan(10);
    expect(reviews.every((review) => review.id.startsWith("sample-"))).toBe(true);
    expect(SAMPLE_BUSINESS).toBeTruthy();
  });

  it("holds both languages and both moods", () => {
    const reviews = sampleReviews(NOW);

    // A demo where everything is fine demonstrates nothing.
    expect(reviews.some((review) => review.language === "tr")).toBe(true);
    expect(reviews.some((review) => review.language === "en")).toBe(true);
    expect(reviews.some((review) => review.sentiment === "negative")).toBe(true);
    expect(reviews.some((review) => review.sentiment === "positive")).toBe(true);
  });

  it("dates itself relative to now, so the sample never goes stale", () => {
    const reviews = sampleReviews(NOW);
    const newest = Math.max(...reviews.map((review) => review.postedAt?.getTime() ?? 0));

    expect(NOW.getTime() - newest).toBeLessThan(3 * 24 * 60 * 60 * 1000);
  });

  it("has a prior period to compare against", () => {
    const prior = samplePriorReviews(NOW);
    const current = sampleReviews(NOW);
    const oldestCurrent = Math.min(...current.map((review) => review.postedAt?.getTime() ?? 0));

    // Every prior review must fall before the current window, or the deltas
    // describe an overlap rather than a change.
    expect(prior.every((review) => (review.postedAt?.getTime() ?? 0) < oldestCurrent)).toBe(true);
  });
});

describe("building the sample", () => {
  it("produces a full digest offline, with no model and no database", async () => {
    const digest = await getSampleDigest({ locale: "tr", now: NOW, offline: true });

    expect(digest.fallback).toBe(true);
    expect(digest.headline.length).toBeGreaterThan(0);
    expect(digest.actions).toHaveLength(DIGEST_ACTION_COUNT);
    expect(digest.themes.length).toBeGreaterThan(0);
  });

  it("computes its numbers rather than stating them", async () => {
    const digest = await getSampleDigest({ locale: "en", now: NOW, offline: true });
    const reviews = sampleReviews(NOW);

    // The pulse and the counts come from the same pure functions a real digest
    // uses, so a demo can never quote a figure the pipeline would not produce.
    expect(digest.reviewCount).toBe(reviews.length);
    expect(digest.pulse).not.toBeNull();
    expect(digest.pulse ?? 0).toBeGreaterThan(0);
    expect(digest.pulse ?? 0).toBeLessThan(100);
  });

  it("shows movement against the previous period", async () => {
    const digest = await getSampleDigest({ locale: "en", now: NOW, offline: true });

    // The prior fortnight is uniformly good and the current one is not, so the
    // sample has something to say about a decline.
    expect(digest.delta).not.toBeNull();
    expect(digest.delta ?? 0).toBeLessThan(0);
    expect(digest.changes.length).toBeGreaterThan(0);
  });

  it("gives every theme at least one real quote", async () => {
    const digest = await getSampleDigest({ locale: "tr", now: NOW, offline: true });

    for (const theme of digest.themes) {
      expect(theme.quotes.length).toBeGreaterThan(0);
      expect(theme.quotes[0]?.text.length).toBeGreaterThan(10);
    }
  });

  it("writes the fallback briefing in the requested language", async () => {
    const tr = await getSampleDigest({ locale: "tr", now: NOW, offline: true });
    clearSampleCache();
    const en = await getSampleDigest({ locale: "en", now: NOW, offline: true });

    expect(tr.headline).not.toBe(en.headline);
  });

  it("composes with a provider when one is available", async () => {
    setLlmProviderForTesting(createStubProvider());

    const digest = await getSampleDigest({ locale: "tr", now: NOW });

    expect(digest.fallback).toBe(false);
    expect(digest.actions).toHaveLength(DIGEST_ACTION_COUNT);
  });

  it("falls back rather than throwing when the model fails", async () => {
    setLlmProviderForTesting(createStubProvider({ simulate: { failures: 99, retryable: false } }));

    const digest = await getSampleDigest({ locale: "en", now: NOW });

    // A marketing page that 500s because a third party is slow is worse than
    // one showing canned prose over real numbers.
    expect(digest.fallback).toBe(true);
    expect(digest.headline.length).toBeGreaterThan(0);
    expect(digest.actions).toHaveLength(DIGEST_ACTION_COUNT);
  });

  it("pins every action to a theme that exists", async () => {
    setLlmProviderForTesting(createStubProvider());

    const digest = await getSampleDigest({ locale: "en", now: NOW });
    const labels = digest.themes.map((theme) => theme.label);

    // The sample must not advertise evidence it does not have.
    expect(digest.actions.every((action) => labels.includes(action.theme))).toBe(true);
  });
});

describe("caching", () => {
  it("does not let a visitor trigger a model call", async () => {
    let calls = 0;
    const counting = createStubProvider();
    const wrapped = {
      ...counting,
      complete: (...args: Parameters<typeof counting.complete>) => {
        calls += 1;
        return counting.complete(...args);
      },
    };

    setLlmProviderForTesting(wrapped);

    await getSampleDigest({ locale: "tr", now: NOW });
    await getSampleDigest({ locale: "tr", now: NOW });
    await getSampleDigest({ locale: "tr", now: NOW });

    // A public URL that composes per request is an unauthenticated way to
    // spend the AI budget, and a bored script is all it takes.
    expect(calls).toBe(1);
  });

  it("caches each language separately", async () => {
    let calls = 0;
    const counting = createStubProvider();
    setLlmProviderForTesting({
      ...counting,
      complete: (...args: Parameters<typeof counting.complete>) => {
        calls += 1;
        return counting.complete(...args);
      },
    });

    await getSampleDigest({ locale: "tr", now: NOW });
    await getSampleDigest({ locale: "en", now: NOW });

    expect(calls).toBe(2);
  });
});
