/**
 * Scores the configured AI provider against the labelled TR/EN set.
 *
 *   pnpm ai:eval                  # the whole set
 *   pnpm ai:eval -- --language tr # one half
 *   pnpm ai:eval -- --json        # machine-readable, for CI
 *
 * This is the evidence behind "comparable TR and EN quality". It runs 40 real
 * calls, so it is a deliberate act, not something the test suite does on every
 * commit — `tests/lib/eval.test.ts` covers the scoring itself with synthetic
 * predictions and no network.
 *
 * Exits non-zero when a threshold is missed, so it can gate a model change.
 */
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { analyzeReview } from "../src/ai/analyze.ts";
import { getLlmProvider } from "../src/ai/client.ts";
import {
  buildReport,
  loadEvalSet,
  scoreCase,
  SENTIMENTS,
  THRESHOLDS,
  type EvalCase,
  type Metrics,
  type Scored,
} from "../src/ai/eval.ts";
import { closeDatabasePools, getAdminDb, schema } from "../src/db/client.ts";
import { getEnv } from "../src/lib/env.ts";
import { createPacer } from "../src/lib/pacer.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const languageFilter = valueOf("--language");

function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const env = getEnv();
// The eval must score the model that actually analyzes reviews.
const provider = getLlmProvider("analyze");

// The first version of this script fired three concurrent calls with no pacing
// and lost 38 of 40 cases to Gemini's 15-requests-per-minute free tier. The
// eval is subject to the same ceiling as any other batch, so it uses the same
// pacer and the same configured rate.
const concurrency = Number(valueOf("--concurrency") ?? String(env.AI_BATCH_CONCURRENCY));
const perMinute = Number(valueOf("--rpm") ?? String(env.AI_REQUESTS_PER_MINUTE));
const pace = createPacer(perMinute);

const setPath = fileURLToPath(new URL("../tests/fixtures/eval/reviews.json", import.meta.url));
const all = await loadEvalSet(setPath);
const cases = languageFilter ? all.filter((item) => item.language === languageFilter) : all;

if (cases.length === 0) {
  console.error(`No cases match --language ${languageFilter}.`);
  process.exit(1);
}

// Audit rows are foreign-keyed to a real organization; borrow the seeded demo.
const [demoOrg] = await getAdminDb()
  .select({ id: schema.organizations.id })
  .from(schema.organizations)
  .where(eq(schema.organizations.slug, "demo"))
  .limit(1);

const organizationId = demoOrg?.id ?? "00000000-0000-4000-8000-000000000000";

if (!asJson) {
  console.log(`provider:  ${env.AI_PROVIDER} (${provider.model})`);
  console.log(`cases:     ${cases.length}${languageFilter ? ` [${languageFilter}]` : ""}`);
  console.log(`pacing:    ${perMinute}/min, ${concurrency} in flight`);
  console.log(`estimate:  ~${Math.ceil((cases.length / perMinute) * 60)}s`);
  if (env.AI_PROVIDER === "stub") {
    console.log(
      "\n! AI_PROVIDER is `stub` — these numbers describe a canned response, not a model.",
    );
  }
  console.log("");
}

const scored: Scored[] = [];
const errors: { id: string; reason: string }[] = [];
let costUsd = 0;
let listCostUsd = 0;
let cursor = 0;

const started = Date.now();

async function worker(): Promise<void> {
  while (cursor < cases.length) {
    const item: EvalCase | undefined = cases[cursor++];
    if (!item) continue;

    await pace();

    try {
      const outcome = await analyzeReview({
        organizationId,
        text: item.text,
        rating: item.rating,
      });

      costUsd += outcome.costUsd;
      listCostUsd += outcome.listCostUsd;
      scored.push(
        scoreCase(item, {
          sentiment: outcome.analysis.sentiment,
          language: outcome.analysis.language,
          topics: outcome.analysis.topics,
        }),
      );
    } catch (error) {
      // A case that errored is not a case that scored. Counting it as a miss
      // would blame the model for an outage; dropping it silently would let a
      // half-failed run look like a clean pass. It is reported separately.
      errors.push({ id: item.id, reason: error instanceof Error ? error.message : "unknown" });
    }

    if (!asJson)
      process.stdout.write(`\r  analyzed ${scored.length + errors.length}/${cases.length}`);
  }
}

await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, cases.length)) }, worker));

if (!asJson) process.stdout.write("\r\x1b[K");

const report = buildReport(scored);
const elapsedMs = Date.now() - started;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        provider: env.AI_PROVIDER,
        model: provider.model,
        cases: cases.length,
        errors,
        costUsd: Number(costUsd.toFixed(6)),
        listCostUsd: Number(listCostUsd.toFixed(6)),
        elapsedMs,
        thresholds: THRESHOLDS,
        report,
      },
      null,
      2,
    ),
  );
} else {
  printTable(report.overall, "overall", report.byLanguage);
  printFailures(report.failures);

  console.log(
    `\ncost:      $${costUsd.toFixed(6)} billed, ` +
      `$${listCostUsd.toFixed(6)} at published rates   time: ${(elapsedMs / 1000).toFixed(1)}s`,
  );

  if (errors.length > 0) {
    console.log(`\n! ${errors.length} case(s) errored and were excluded from the scores:`);
    for (const error of errors) console.log(`    ${error.id}: ${error.reason}`);
  }
}

// A run that could not score most of its cases is not a passing run, whatever
// the surviving cases said. The first version of this script printed "all
// thresholds met" over 38 quota failures, which is exactly the kind of green
// tick that gets quoted later as evidence.
const tooManyErrors = errors.length > cases.length * 0.1;

if (!asJson) {
  console.log("");
  if (tooManyErrors) {
    console.log(
      `✗ Run incomplete — ${errors.length} of ${cases.length} cases errored. ` +
        "The scores above describe only what survived and should not be quoted.",
    );
  } else if (report.passed) {
    console.log("✓ All thresholds met.");
  } else {
    console.log("✗ Below threshold:");
    for (const violation of report.violations) console.log(`    ${violation}`);
  }
}

if (!report.passed || tooManyErrors) process.exitCode = 1;

await closeDatabasePools();

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`.padStart(6);
}

function printTable(overall: Metrics, _label: string, byLanguage: Record<string, Metrics>): void {
  const columns = [...Object.keys(byLanguage), "all"];
  const metrics: Record<string, Metrics> = { ...byLanguage, all: overall };

  const row = (name: string, pick: (m: Metrics) => string) =>
    `  ${name.padEnd(20)}${columns.map((key) => pick(metrics[key]!).padStart(9)).join("")}`;

  console.log(`  ${"".padEnd(20)}${columns.map((key) => key.padStart(9)).join("")}`);
  console.log(`  ${"-".repeat(20 + columns.length * 9)}`);
  console.log(row("cases", (m) => String(m.count)));
  console.log(row("sentiment accuracy", (m) => pct(m.sentimentAccuracy)));
  console.log(row("macro-F1", (m) => pct(m.macroF1)));
  console.log(row("language detection", (m) => pct(m.languageAccuracy)));
  console.log(row("theme hit rate", (m) => pct(m.themeHitRate)));
  console.log(row("  easy cases", (m) => (m.easyAccuracy === null ? "  -" : pct(m.easyAccuracy))));
  console.log(row("  hard cases", (m) => (m.hardAccuracy === null ? "  -" : pct(m.hardAccuracy))));

  console.log("\n  per class (overall)");
  for (const label of SENTIMENTS) {
    const cls = overall.perClass[label];
    console.log(
      `    ${label.padEnd(10)} P ${pct(cls.precision)}  R ${pct(cls.recall)}  ` +
        `F1 ${pct(cls.f1)}  n=${cls.support}`,
    );
  }

  console.log("\n  confusion (rows expected, columns predicted)");
  console.log(`    ${"".padEnd(10)}${SENTIMENTS.map((s) => s.padStart(10)).join("")}`);
  for (const expected of SENTIMENTS) {
    const row = SENTIMENTS.map((predicted) =>
      String(overall.confusion[expected][predicted]).padStart(10),
    ).join("");
    console.log(`    ${expected.padEnd(10)}${row}`);
  }
}

function printFailures(failures: Scored[]): void {
  if (failures.length === 0) return;

  console.log(`\n  misclassified (${failures.length})`);
  for (const failure of failures) {
    const detail = failure.sentimentCorrect
      ? `language ${failure.prediction.language} ≠ ${failure.case.language}`
      : `${failure.prediction.sentiment} ≠ ${failure.case.sentiment}`;

    console.log(`    ${failure.case.id}  ${detail}${failure.case.hard ? "  (hard)" : ""}`);
    console.log(`      "${failure.case.text.slice(0, 84)}"`);
    console.log(`      topics: ${failure.prediction.topics.join(", ")}`);
  }
}
