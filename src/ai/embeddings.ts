import { createHash } from "node:crypto";
import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "../db/schema.ts";
import { getEnv } from "../lib/env.ts";
import { LlmError } from "./types.ts";

/**
 * Turning review text into vectors (P1a-T3).
 *
 * A separate seam from the completion provider, and not an oversight: no
 * vendor's chat model and embedding model are the same thing, and Anthropic
 * does not publish an embedding model at all. So "which model writes our
 * replies" and "which model embeds our reviews" are genuinely independent
 * choices, and the production answer may well be two different companies.
 *
 * Batching is the point of this module. On Gemini's free tier the binding
 * constraint is requests per minute, not tokens, so embedding 97 reviews as 97
 * calls would take minutes and burn the daily quota, while one
 * `batchEmbedContents` call does it at once.
 *
 * **Vectors are normalized to unit length here**, regardless of provider.
 * `gemini-embedding-2` already does this for truncated dimensions, but doing it
 * ourselves means cosine distance and inner product stay interchangeable and a
 * future provider that does not normalize cannot quietly corrupt the index.
 */

export type EmbeddingProvider = {
  readonly name: string;
  readonly model: string;
  /** Vectors in the same order as the input, each `EMBEDDING_DIMENSIONS` long. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
};

/**
 * Google's response shape differs between the single and batch endpoints, and
 * has changed across embedding model generations. Accepting both known shapes
 * costs one union and avoids a parse failure on a working API.
 */
const vectorSchema = z.object({ values: z.array(z.number()) });

const embedResponseSchema = z
  .object({
    embeddings: z.array(vectorSchema).optional(),
    embedding: vectorSchema.optional(),
  })
  .loose()
  .refine((value) => value.embeddings !== undefined || value.embedding !== undefined, {
    message: "expected either `embeddings` or `embedding`",
  });

/** Scales a vector to unit length. A zero vector is returned unchanged. */
export function normalize(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? values : values.map((value) => value / magnitude);
}

/**
 * Length of a stored content hash, in hex characters.
 *
 * 128 bits of a SHA-256 — far past collision relevance for a per-tenant review
 * corpus, and half the storage. Exported because the staleness check in
 * ./analysis-run.ts recomputes the same hash *in SQL*, and the two truncations
 * must agree or every review reads as stale.
 */
export const CONTENT_HASH_LENGTH = 32;

/** Stable cache key for a piece of text. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, CONTENT_HASH_LENGTH);
}

export type GeminiEmbeddingOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
};

/** Google caps a batch request; stay well under it. */
const MAX_BATCH = 100;

export function createGeminiEmbeddingProvider(options: GeminiEmbeddingOptions): EmbeddingProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com").replace(
    /\/+$/,
    "",
  );

  async function embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(options.model)}:batchEmbedContents`;

    const body = {
      requests: texts.map((text) => ({
        // Each entry repeats the model — the batch endpoint requires it.
        model: `models/${options.model}`,
        content: { parts: [{ text }] },
        output_dimensionality: EMBEDDING_DIMENSIONS,
      })),
    };

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "x-goog-api-key": options.apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new LlmError(
        `Could not reach the embedding API: ${error instanceof Error ? error.message : "unknown"}`,
        { provider: "gemini-embeddings", retryable: true },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new LlmError(`Embedding request failed (${response.status}): ${detail.slice(0, 300)}`, {
        provider: "gemini-embeddings",
        status: response.status,
        // 429 and 5xx are worth another attempt; a rejected key or model is not.
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const parsed = embedResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new LlmError("The embedding API returned an unrecognized shape.", {
        provider: "gemini-embeddings",
        retryable: false,
      });
    }

    const { embeddings, embedding } = parsed.data;
    const vectors = embeddings
      ? embeddings.map((entry) => entry.values)
      : embedding
        ? [embedding.values]
        : [];

    if (vectors.length !== texts.length) {
      // Silently mismatched ordering would attach one review's meaning to
      // another's row — worse than an error, because it looks fine.
      throw new LlmError(`Asked for ${texts.length} embeddings and received ${vectors.length}.`, {
        provider: "gemini-embeddings",
        retryable: false,
      });
    }

    return vectors.map((values) => {
      if (values.length !== EMBEDDING_DIMENSIONS) {
        throw new LlmError(
          `Embedding model returned ${values.length} dimensions, expected ${EMBEDDING_DIMENSIONS}.`,
          { provider: "gemini-embeddings", retryable: false },
        );
      }
      return normalize(values);
    });
  }

  return {
    name: "gemini-embeddings",
    model: options.model,

    async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
      if (texts.length === 0) return [];

      const out: number[][] = [];
      for (let index = 0; index < texts.length; index += MAX_BATCH) {
        out.push(...(await embedBatch(texts.slice(index, index + MAX_BATCH), signal)));
      }
      return out;
    },
  };
}

/**
 * Deterministic offline embeddings.
 *
 * Not random: the vector is derived from the text, so the same review always
 * embeds identically and similar strings land near each other — enough for the
 * clustering code to be exercised without a network. It is emphatically not a
 * semantic model, and the eval script will say so if anyone points it at this.
 */
export function createStubEmbeddingProvider(): EmbeddingProvider {
  return {
    name: "stub-embeddings",
    model: "stub-embed-1",

    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const values = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);

        // Hash trick: each token contributes to one bucket. Shared vocabulary
        // therefore produces genuine (if crude) similarity.
        for (const token of text.toLocaleLowerCase("tr").split(/\W+/).filter(Boolean)) {
          const digest = createHash("sha256").update(token).digest();
          const bucket = digest.readUInt16BE(0) % EMBEDDING_DIMENSIONS;
          values[bucket] = (values[bucket] ?? 0) + 1;
        }

        return normalize(values);
      });
    },
  };
}

let cached: EmbeddingProvider | undefined;

/** The embedding provider this environment is configured to use. */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (cached) return cached;

  const env = getEnv();

  // Embeddings follow the chat provider only where that provider has one.
  // Anthropic does not, so an Anthropic deployment still embeds with Gemini —
  // which is exactly why this is a separate seam.
  if (env.GEMINI_API_KEY) {
    cached = createGeminiEmbeddingProvider({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_EMBEDDING_MODEL,
      baseUrl: env.GEMINI_BASE_URL,
    });
  } else {
    cached = createStubEmbeddingProvider();
  }

  return cached;
}

export function setEmbeddingProviderForTesting(provider: EmbeddingProvider | null): void {
  cached = provider ?? undefined;
}
