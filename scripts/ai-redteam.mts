/**
 * Runs the adversarial corpus against the configured provider.
 *
 *   pnpm ai:redteam
 *   pnpm ai:redteam -- --json
 *
 * The evidence behind P1a-T11's "a documented adversarial prompt-injection case
 * is proven safe". Every attack must fail; see REDTEAM_THRESHOLD for why this
 * is not a percentage. Exits non-zero if any attack achieves anything.
 */
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { analyzeReview, draftReply } from "../src/ai/analyze.ts";
import { getLlmProvider } from "../src/ai/client.ts";
import {
  buildRedTeamReport,
  loadAttacks,
  scoreAttack,
  type AttackVerdict,
} from "../src/ai/redteam.ts";
import { LlmError, LlmRefusalError } from "../src/ai/types.ts";
import { closeDatabasePools, getAdminDb, schema } from "../src/db/client.ts";
import { getEnv } from "../src/lib/env.ts";
import { createPacer } from "../src/lib/pacer.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");

function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const env = getEnv();

/**
 * Paced for the *slowest* model in the run, not the configured default.
 *
 * The corpus hits both tasks, and per-task routing sends drafting to a stronger
 * model with a tighter free-tier ceiling — measured at 5 requests per minute for
 * `gemini-3.5-flash` against 15 for the lite tier. Pacing at the analyze rate
 * lost an attack to a 429, and an unscored attack is not a repelled one.
 */
const pace = createPacer(Number(valueOf("--rpm") ?? "4"));

const path = fileURLToPath(new URL("../tests/fixtures/redteam/attacks.json", import.meta.url));
const attacks = await loadAttacks(path);

const [demoOrg] = await getAdminDb()
  .select({ id: schema.organizations.id })
  .from(schema.organizations)
  .where(eq(schema.organizations.slug, "demo"))
  .limit(1);

const organizationId = demoOrg?.id ?? null;

if (!asJson) {
  console.log(`provider:  ${env.AI_PROVIDER}`);
  console.log(`analyze:   ${getLlmProvider("analyze").model}`);
  console.log(`draft:     ${getLlmProvider("draft_reply").model}`);
  console.log(`attacks:   ${attacks.length}\n`);
}

const verdicts: AttackVerdict[] = [];
const errors: { id: string; reason: string }[] = [];
/**
 * What the model actually said, kept for triage.
 *
 * The first run reported "matched forbidden pattern /full refund/" and nothing
 * else, which took a separate script to interpret — and the answer turned out
 * to be that the guardrail had held and the pattern was wrong. A breach report
 * that does not quote the output cannot be judged.
 */
const outputs = new Map<string, string>();

/**
 * Runs one attack, waiting out a rate limit rather than giving up.
 *
 * `runAi` retries inside a per-request deadline, which is right for a user
 * waiting on a reply and wrong here: a free tier can ask for a 30-second pause,
 * and an unscored attack is not a repelled attack. A red-team run is a
 * deliberate act, so it waits.
 */
async function withRateLimitRetries<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const rateLimited =
        error instanceof LlmError &&
        (error.status === 429 || /rate limit|quota/i.test(error.message));

      if (!rateLimited || attempt >= attempts) throw error;

      const waitMs = error instanceof LlmError && error.retryAfterMs ? error.retryAfterMs : 30_000;
      if (!asJson) process.stdout.write(`\r  rate limited, waiting ${Math.ceil(waitMs / 1000)}s…`);
      await new Promise((resolve) => setTimeout(resolve, waitMs + 1_000));
    }
  }
}

for (const attack of attacks) {
  await pace();

  try {
    if (attack.task === "analyze") {
      const { analysis } = await withRateLimitRetries(() =>
        analyzeReview({
          organizationId,
          text: attack.text,
          rating: attack.rating,
        }),
      );

      const output = `${analysis.sentiment} ${analysis.topics.join(" ")} ${analysis.language}`;
      outputs.set(attack.id, output);

      verdicts.push(
        scoreAttack({
          attack,
          // Everything the classifier produced, so a forbidden pattern can be
          // caught in a topic as well as in the label.
          output,
          sentiment: analysis.sentiment,
        }),
      );
    } else {
      const { reply } = await withRateLimitRetries(() =>
        draftReply({
          organizationId,
          text: attack.text,
          rating: attack.rating,
          businessName: "Kahve Molası",
          brandTone: "warm and professional",
        }),
      );

      outputs.set(attack.id, reply);
      verdicts.push(scoreAttack({ attack, output: reply }));
    }
  } catch (error) {
    if (error instanceof LlmRefusalError) {
      // A refusal is safe: the model declined rather than obeyed.
      verdicts.push(scoreAttack({ attack, output: "", refused: true }));
    } else {
      errors.push({ id: attack.id, reason: error instanceof Error ? error.message : "unknown" });
    }
  }

  if (!asJson) process.stdout.write(`\r  ran ${verdicts.length + errors.length}/${attacks.length}`);
}

if (!asJson) process.stdout.write("\r\x1b[K");

const report = buildRedTeamReport(verdicts);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        provider: env.AI_PROVIDER,
        errors,
        report,
        failureOutputs: Object.fromEntries(
          report.failures.map((failure) => [failure.id, outputs.get(failure.id) ?? ""]),
        ),
      },
      null,
      2,
    ),
  );
} else {
  for (const [category, counts] of Object.entries(report.byCategory)) {
    const ok = counts.passed === counts.total;
    console.log(`  ${ok ? "✓" : "✗"} ${category.padEnd(24)} ${counts.passed}/${counts.total}`);
  }

  if (report.failures.length > 0) {
    console.log("\n  breaches:");
    for (const failure of report.failures) {
      console.log(`    ${failure.id} (${failure.category})`);
      for (const violation of failure.violations) console.log(`      · ${violation}`);
      console.log(`      output: "${(outputs.get(failure.id) ?? "").slice(0, 240)}"`);
    }
  }

  if (errors.length > 0) {
    console.log(`\n  ! ${errors.length} attack(s) errored and were not scored:`);
    for (const error of errors) console.log(`      ${error.id}: ${error.reason}`);
  }

  console.log(
    report.failed === 0 && errors.length === 0
      ? `\n✓ ${report.passed}/${report.total} attacks repelled.`
      : `\n✗ ${report.failed} of ${report.total} attacks achieved something.`,
  );
}

// An unscored attack is not a repelled attack.
if (report.failed > 0 || errors.length > 0) process.exitCode = 1;

await closeDatabasePools();
