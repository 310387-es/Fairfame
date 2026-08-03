import { describe, expect, it, vi } from "vitest";
import {
  CONTENT_HASH_LENGTH,
  contentHash,
  createGeminiEmbeddingProvider,
  createStubEmbeddingProvider,
  normalize,
} from "@/ai/embeddings";
import { EMBEDDING_DIMENSIONS } from "@/db/schema";
import type { LlmError } from "@/ai/types";

/**
 * The embedding seam without a network (P1a-T3).
 *
 * The failures worth catching here are the quiet ones: a response whose order
 * or length does not match what we asked for. A wrong-order batch attaches one
 * customer's meaning to another's review and every downstream page still
 * renders perfectly.
 */

function fakeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function vectorsOf(count: number): { values: number[] }[] {
  return Array.from({ length: count }, (_, index) => ({
    values: Array.from({ length: EMBEDDING_DIMENSIONS }, (_, dim) => (dim === index ? 2 : 0)),
  }));
}

function provider(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  return createGeminiEmbeddingProvider({ apiKey: "test-key", model: "test-embed", fetchImpl });
}

describe("normalize", () => {
  it("scales to unit length", () => {
    const result = normalize([3, 4]);
    expect(Math.hypot(...result)).toBeCloseTo(1, 10);
    expect(result).toEqual([0.6, 0.8]);
  });

  it("leaves a zero vector alone rather than dividing by zero", () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("contentHash", () => {
  it("is stable for the same text", () => {
    expect(contentHash("aynı yorum")).toBe(contentHash("aynı yorum"));
  });

  it("changes when the text changes", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });

  it("is the length the SQL staleness check assumes", () => {
    // ../../src/ai/analysis-run.ts truncates the same digest in Postgres with
    // left(..., CONTENT_HASH_LENGTH). If these disagree, every review reads as
    // stale forever and the batch re-analyzes the whole corpus each run.
    expect(contentHash("x")).toHaveLength(CONTENT_HASH_LENGTH);
  });
});

describe("the Gemini embedding provider", () => {
  it("sends the key as a header, not a query parameter", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ embeddings: vectorsOf(1) }));
    await provider(fetchImpl).embed(["merhaba"]);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("key=");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  });

  it("asks for the dimension the column is declared with", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ embeddings: vectorsOf(1) }));
    await provider(fetchImpl).embed(["merhaba"]);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      requests: { output_dimensionality: number; model: string }[];
    };

    expect(body.requests[0]?.output_dimensionality).toBe(EMBEDDING_DIMENSIONS);
    // The batch endpoint requires the model on each entry as well as the URL.
    expect(body.requests[0]?.model).toBe("models/test-embed");
  });

  it("normalizes what the API returns", async () => {
    const fetchImpl = async () => fakeResponse({ embeddings: vectorsOf(1) });
    const [vector] = await provider(fetchImpl).embed(["merhaba"]);

    expect(Math.hypot(...(vector ?? []))).toBeCloseTo(1, 10);
  });

  it("accepts the single-embedding response shape too", async () => {
    const fetchImpl = async () => fakeResponse({ embedding: vectorsOf(1)[0] });

    const vectors = await provider(fetchImpl).embed(["merhaba"]);
    expect(vectors).toHaveLength(1);
  });

  it("rejects a response with the wrong number of vectors", async () => {
    // The dangerous case: fewer vectors than texts would shift every
    // subsequent review onto the wrong row, silently.
    const fetchImpl = async () => fakeResponse({ embeddings: vectorsOf(2) });

    await expect(provider(fetchImpl).embed(["a", "b", "c"])).rejects.toThrow(/received 2/);
  });

  it("rejects a vector of the wrong width", async () => {
    const fetchImpl = async () => fakeResponse({ embeddings: [{ values: [1, 2, 3] }] });

    await expect(provider(fetchImpl).embed(["a"])).rejects.toThrow(/3 dimensions/);
  });

  it("rejects an unrecognized shape instead of storing nothing useful", async () => {
    const fetchImpl = async () => fakeResponse({ data: [] });
    await expect(provider(fetchImpl).embed(["a"])).rejects.toThrow(/unrecognized shape/);
  });

  it("marks a 429 retryable and a 400 not", async () => {
    const rateLimited = await provider(async () => fakeResponse({}, 429))
      .embed(["a"])
      .catch((error: unknown) => error as LlmError);

    const badRequest = await provider(async () => fakeResponse({}, 400))
      .embed(["a"])
      .catch((error: unknown) => error as LlmError);

    expect((rateLimited as LlmError).retryable).toBe(true);
    expect((badRequest as LlmError).retryable).toBe(false);
  });

  it("splits large inputs into batches", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requests: unknown[] };
      return fakeResponse({ embeddings: vectorsOf(body.requests.length) });
    });

    const vectors = await provider(fetchImpl).embed(Array.from({ length: 250 }, (_, i) => `t${i}`));

    expect(vectors).toHaveLength(250);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("makes no call for an empty input", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ embeddings: [] }));
    expect(await provider(fetchImpl).embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the stub provider", () => {
  it("is deterministic", async () => {
    const stub = createStubEmbeddingProvider();
    const [first] = await stub.embed(["kahve güzeldi"]);
    const [second] = await stub.embed(["kahve güzeldi"]);

    expect(first).toEqual(second);
  });

  it("returns unit vectors of the right width", async () => {
    const [vector] = await createStubEmbeddingProvider().embed(["servis yavaştı"]);

    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(Math.hypot(...(vector ?? []))).toBeCloseTo(1, 10);
  });

  it("puts texts sharing vocabulary closer than unrelated ones", async () => {
    const stub = createStubEmbeddingProvider();
    const [a, b, c] = await stub.embed([
      "servis çok yavaştı",
      "servis yavaştı ve soğuktu",
      "manzara harikaydı",
    ]);

    const dot = (x: number[], y: number[]) => x.reduce((sum, v, i) => sum + v * (y[i] ?? 0), 0);

    // Crude but real: enough for the clustering code to be exercised offline.
    expect(dot(a ?? [], b ?? [])).toBeGreaterThan(dot(a ?? [], c ?? []));
  });
});
