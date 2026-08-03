import { schema } from "../db/client.ts";
import { getEnv } from "../lib/env.ts";
import { recordUsage } from "../lib/entitlements.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import type { BuiltPrompt } from "../prompts/index.ts";
import { estimateCost } from "./pricing.ts";
import { createAnthropicProvider } from "./providers/anthropic.ts";
import { createGeminiProvider } from "./providers/gemini.ts";
import { createStubProvider } from "./providers/stub.ts";
import {
  LlmError,
  LlmRefusalError,
  type AiTask,
  type LlmProvider,
  type LlmResponse,
} from "./types.ts";

/**
 * The one path an AI call takes (P1a-T1).
 *
 * Nothing in the product calls a provider directly. Everything goes through
 * `runAi`, because that is where the obligations from `CLAUDE.md` are
 * discharged — and an obligation discharged in one place is one that cannot be
 * forgotten in the next feature:
 *
 *   - **Tenant scoping.** The organization is a required argument and every
 *     write happens inside its tenant transaction. A prompt is built from one
 *     organization's data and the audit row proves which.
 *   - **Audit.** Every call writes an `audit_logs` row: task, prompt version,
 *     model, tokens, cost, outcome. Never the prompt or the response — those
 *     contain customer text, and an audit trail should not become a second
 *     uncontrolled copy of personal data.
 *   - **Metering.** Token spend accumulates against the `ai_tokens` counter, so
 *     the entitlement layer can enforce plan limits on real consumption.
 *   - **Cost logging.** Every call logs an estimated cost.
 *   - **Retries and timeouts.** Owned here, uniformly, rather than per provider.
 */

const log = childLogger({ module: "ai/client" });

/** Base delay for the retry backoff. Jittered, and capped by the deadline. */
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

let cachedProvider: LlmProvider | undefined;

/** Env variable holding the model override for each task. */
const MODEL_OVERRIDE: Record<
  AiTask,
  "AI_MODEL_ANALYZE" | "AI_MODEL_DRAFT_REPLY" | "AI_MODEL_DIGEST"
> = {
  analyze: "AI_MODEL_ANALYZE",
  draft_reply: "AI_MODEL_DRAFT_REPLY",
  digest: "AI_MODEL_DIGEST",
};

/**
 * The provider for one task.
 *
 * `AiTask` has always been documented as driving model routing; this is where
 * it finally does. Without a task the provider's default model is used, which
 * is what every non-task caller (the smoke script, tests) wants.
 *
 * An override returns a *distinct* provider instance rather than mutating the
 * cached one — two tasks running concurrently on different models must not
 * race over a shared field.
 */
export function getLlmProvider(task?: AiTask): LlmProvider {
  const base = resolveBaseProvider();
  if (!task) return base;

  const override = getEnv()[MODEL_OVERRIDE[task]];
  if (!override || override === base.model) return base;

  return withModel(base, override);
}

/**
 * The same provider, talking to a different model.
 *
 * A wrapper rather than a second `createXProvider` call, so the override works
 * for any provider — including the test seam — without this function having to
 * know how each one is constructed.
 */
function withModel(provider: LlmProvider, model: string): LlmProvider {
  return {
    name: provider.name,
    model,
    ...(provider.requestsPerMinute !== undefined
      ? { requestsPerMinute: provider.requestsPerMinute }
      : {}),
    complete: (request, signal) => provider.complete({ ...request, model }, signal),
  };
}

function resolveBaseProvider(): LlmProvider {
  if (cachedProvider) return cachedProvider;

  const env = getEnv();

  switch (env.AI_PROVIDER) {
    case "gemini": {
      if (!env.GEMINI_API_KEY) {
        throw new LlmError(
          "AI_PROVIDER is gemini but GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey.",
          { provider: "gemini", retryable: false },
        );
      }
      cachedProvider = createGeminiProvider({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        baseUrl: env.GEMINI_BASE_URL,
      });
      break;
    }

    case "anthropic": {
      if (!env.ANTHROPIC_API_KEY) {
        throw new LlmError(
          "AI_PROVIDER is anthropic but ANTHROPIC_API_KEY is not set. Note a Claude subscription does not include API credits.",
          { provider: "anthropic", retryable: false },
        );
      }
      cachedProvider = createAnthropicProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL,
        baseUrl: env.ANTHROPIC_BASE_URL,
      });
      break;
    }

    case "stub":
      cachedProvider = createStubProvider();
      break;
  }

  if (!cachedProvider) throw new Error("No AI provider resolved.");
  return cachedProvider;
}

/** Test seam: install a provider directly, or reset with null. */
export function setLlmProviderForTesting(provider: LlmProvider | null): void {
  cachedProvider = provider ?? undefined;
}

export type RunAiArgs = {
  /**
   * The tenant this call belongs to, or **null for the anonymous sample
   * digest** (P1a-T10), which has no tenant to attribute anything to.
   *
   * A null skips the audit *row* and the usage counter — both are foreign-keyed
   * to an organization, and inventing a placeholder id is precisely the bug
   * that put an empty string into a uuid column in T7. The call is still logged
   * with `anonymous: true`, so cost and volume stay observable; what is lost is
   * a database row that could never have pointed anywhere real.
   */
  organizationId: string | null;
  /** The user who triggered it, or null for scheduled work. */
  actorUserId?: string | null;
  task: AiTask;
  prompt: BuiltPrompt;
  /** Reuse an open tenant transaction instead of opening one. */
  tx?: TenantDatabase | undefined;
  /** Overrides for a single call. */
  provider?: LlmProvider | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  /** Injected for deterministic backoff in tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
};

export type AiOutcome = {
  response: LlmResponse;
  /** What this call is billed. Zero on a free tier. */
  costUsd: number;
  /** What it would be billed at published rates — see ./pricing.ts. */
  listCostUsd: number;
  attempts: number;
  durationMs: number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Full jitter, capped, and never longer than the time actually left.
 *
 * Sleeping past the deadline would burn the whole budget waiting for an
 * attempt that can no longer be made.
 */
function backoffFor(
  attempt: number,
  msRemaining: number,
  hinted: number | undefined,
  random: () => number,
): number {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jittered = Math.floor(exponential / 2 + random() * (exponential / 2));
  // A provider that tells us when to come back knows better than our curve.
  const wanted = hinted ?? jittered;

  return Math.max(0, Math.min(wanted, msRemaining - 250));
}

/**
 * Runs one AI call: retry, time-bound, audit, meter, log.
 *
 * The timeout is a deadline over the *whole* operation, retries and backoff
 * included — otherwise "3 retries × 60s" is a silently three-minute call.
 */
export async function runAi(args: RunAiArgs): Promise<AiOutcome> {
  // Read configuration only for what the caller left unspecified. `getEnv()`
  // validates the *entire* environment, so touching it unconditionally would
  // mean a caller that supplies its own provider, timeout and retry budget
  // still needs a database URL — which is how a unit-testable operation
  // quietly becomes one that requires a fully configured process.
  const needsEnv =
    args.provider === undefined || args.timeoutMs === undefined || args.maxRetries === undefined;
  const env = needsEnv ? getEnv() : null;

  // Per-task routing: the task decides the model unless the caller supplied a
  // provider outright (tests, and the batch runner which resolves once).
  const provider = args.provider ?? getLlmProvider(args.task);
  const timeoutMs = args.timeoutMs ?? env?.AI_TIMEOUT_MS ?? 60_000;
  const maxRetries = args.maxRetries ?? env?.AI_MAX_RETRIES ?? 2;
  const sleep = args.sleep ?? defaultSleep;
  const random = args.random ?? Math.random;

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  let attempts = 0;
  let lastError: unknown;

  while (attempts <= maxRetries) {
    attempts += 1;

    const msRemaining = deadline - Date.now();
    if (msRemaining <= 0) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), msRemaining);

    try {
      const response = await provider.complete(args.prompt.request, controller.signal);
      const durationMs = Date.now() - startedAt;
      const cost = estimateCost(response.model, response.usage);

      log.info(
        {
          organizationId: args.organizationId,
          task: args.task,
          promptId: args.prompt.id,
          provider: response.provider,
          model: response.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          thinkingTokens: response.usage.thinkingTokens,
          costUsd: cost.usd,
          listCostUsd: cost.listUsd,
          priced: cost.priced,
          attempts,
          durationMs,
          truncated: response.truncated,
          // Surfaced so an injection attempt is visible in the logs even
          // though it never changes behaviour.
          suspiciousInput: args.prompt.untrusted?.suspicious ?? false,
        },
        "AI call completed",
      );

      await record(args, {
        outcome: "ok",
        provider: response.provider,
        model: response.model,
        usage: response.usage,
        costUsd: cost.usd,
        attempts,
        durationMs,
      });

      return { response, costUsd: cost.usd, listCostUsd: cost.listUsd, attempts, durationMs };
    } catch (error) {
      lastError = error;

      const isAbort = error instanceof Error && error.name === "AbortError";
      const retryable = !isAbort && error instanceof LlmError && error.retryable;

      if (!retryable || attempts > maxRetries) break;

      const delay = backoffFor(
        attempts,
        deadline - Date.now(),
        error instanceof LlmError ? error.retryAfterMs : undefined,
        random,
      );
      if (delay <= 0) break;

      log.warn(
        {
          organizationId: args.organizationId,
          task: args.task,
          provider: provider.name,
          attempt: attempts,
          delayMs: delay,
          err: error instanceof Error ? error.message : String(error),
        },
        "AI call failed; retrying",
      );

      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  const durationMs = Date.now() - startedAt;
  const failure = normalizeFailure(lastError, provider.name, timeoutMs);

  log.error(
    {
      organizationId: args.organizationId,
      task: args.task,
      promptId: args.prompt.id,
      provider: provider.name,
      attempts,
      durationMs,
      err: failure.message,
    },
    "AI call failed",
  );

  await record(args, {
    outcome: failure instanceof LlmRefusalError ? "refused" : "error",
    provider: provider.name,
    model: provider.model,
    usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
    costUsd: 0,
    attempts,
    durationMs,
    error: failure.message,
  });

  throw failure;
}

function normalizeFailure(error: unknown, provider: string, timeoutMs: number): LlmError {
  if (error instanceof LlmError) return error;

  if (error instanceof Error && error.name === "AbortError") {
    return new LlmError(`The AI call exceeded its ${timeoutMs}ms budget.`, {
      provider,
      // The deadline is the caller's, so a longer one is the fix, not a retry.
      retryable: false,
      code: "timeout",
    });
  }

  return new LlmError(error instanceof Error ? error.message : "Unknown AI failure.", {
    provider,
    retryable: false,
  });
}

type RecordArgs = {
  outcome: "ok" | "error" | "refused";
  provider: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; thinkingTokens: number };
  costUsd: number;
  attempts: number;
  durationMs: number;
  error?: string;
};

/**
 * Writes the audit row and meters the tokens.
 *
 * Deliberately never records the prompt or the completion. Reviews are
 * personal data under KVKK; copying them into an append-only audit table would
 * create a second store to export and erase from, for no operational gain.
 */
async function record(args: RunAiArgs, detail: RecordArgs): Promise<void> {
  const meta = {
    task: args.task,
    promptId: args.prompt.id,
    provider: detail.provider,
    model: detail.model,
    outcome: detail.outcome,
    inputTokens: detail.usage.inputTokens,
    outputTokens: detail.usage.outputTokens,
    thinkingTokens: detail.usage.thinkingTokens,
    costUsd: detail.costUsd,
    attempts: detail.attempts,
    durationMs: detail.durationMs,
    suspiciousInput: args.prompt.untrusted?.suspicious ?? false,
    inputTruncated: args.prompt.untrusted?.truncated ?? false,
    ...(detail.error ? { error: detail.error.slice(0, 300) } : {}),
  };

  const totalTokens =
    detail.usage.inputTokens + detail.usage.outputTokens + detail.usage.thinkingTokens;

  const organizationId = args.organizationId;

  if (organizationId === null) {
    // No tenant: observability lives in the log line, not in a row that has
    // nowhere to point.
    log.info({ ...meta, anonymous: true }, "AI call recorded without a tenant");
    return;
  }

  const write = async (tx: TenantDatabase): Promise<void> => {
    await tx.insert(schema.auditLogs).values({
      organizationId,
      actorUserId: args.actorUserId ?? null,
      action: `ai.${args.task}`,
      entity: `prompt:${args.prompt.id}`,
      meta,
    });

    if (totalTokens > 0) {
      await recordUsage({ organizationId, tx }, "ai_tokens", totalTokens);
    }
  };

  try {
    if (args.tx) {
      await write(args.tx);
      return;
    }
    await withTenant({ organizationId }, write);
  } catch (error) {
    // Bookkeeping must never mask the AI result — a lost audit row is bad, a
    // lost analysis because the audit insert failed is worse.
    log.error(
      { organizationId: args.organizationId, task: args.task, err: error },
      "Could not record AI usage",
    );
  }
}
