/**
 * Runs sentiment + theme analysis over an organization's reviews.
 *
 *   pnpm ai:analyze                        # the demo org, cached
 *   pnpm ai:analyze -- --org acme          # by slug
 *   pnpm ai:analyze -- --embeddings        # also compute vectors
 *   pnpm ai:analyze -- --recompute         # ignore the cache
 *   pnpm ai:analyze -- --limit 10          # a cheap trial run
 *
 * The backfill that P1a-T3's Definition of Done asks for. T4 wires the same
 * `analyzeBatch` into ingestion so new reviews are analyzed as they arrive;
 * this stays as the operator's tool for the existing corpus, a model change, or
 * a prompt revision.
 */
import { eq } from "drizzle-orm";
import { analyzeBatch } from "../src/ai/analysis-run.ts";
import { getLlmProvider } from "../src/ai/client.ts";
import { getEmbeddingProvider } from "../src/ai/embeddings.ts";
import { closeDatabasePools, getAdminDb, schema } from "../src/db/client.ts";
import { getEnv } from "../src/lib/env.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const slug = value("--org") ?? "demo";
const limit = Number(value("--limit") ?? "500");

const env = getEnv();

const [org] = await getAdminDb()
  .select({ id: schema.organizations.id, name: schema.organizations.name })
  .from(schema.organizations)
  .where(eq(schema.organizations.slug, slug))
  .limit(1);

if (!org) {
  console.error(`No organization with slug "${slug}". Run \`pnpm db:seed\` or pass --org.`);
  await closeDatabasePools();
  process.exit(1);
}

const withEmbeddings = flag("--embeddings");

console.log(`org:        ${org.name} (${slug})`);
console.log(`provider:   ${env.AI_PROVIDER} (${getLlmProvider("analyze").model})`);
if (withEmbeddings) console.log(`embeddings: ${getEmbeddingProvider().model}`);
console.log(`mode:       ${flag("--recompute") ? "recompute (cache ignored)" : "incremental"}`);
console.log(
  `pacing:     ${env.AI_REQUESTS_PER_MINUTE}/min, ${env.AI_BATCH_CONCURRENCY} in flight\n`,
);

const started = Date.now();

try {
  const result = await analyzeBatch({
    organizationId: org.id,
    recompute: flag("--recompute"),
    withEmbeddings,
    limit,
    onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total}`),
  });

  process.stdout.write("\r\x1b[K");

  console.log(`analyzed:   ${result.analyzed}`);
  console.log(`cached:     ${result.skipped}`);
  console.log(`failed:     ${result.failed}`);
  if (withEmbeddings) console.log(`embedded:   ${result.embedded}`);
  console.log(`cost:       $${result.costUsd.toFixed(6)} billed`);
  // On a free tier the billed figure is zero and says nothing about what this
  // workload costs once billing is on. That is the number to plan with.
  console.log(`            $${result.listCostUsd.toFixed(6)} at published rates`);
  console.log(`took:       ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (result.failures.length > 0) {
    console.log("\nfailures:");
    for (const failure of result.failures.slice(0, 20)) {
      console.log(`  ${failure.reviewId}  ${failure.reason}`);
    }
    if (result.failures.length > 20) {
      console.log(`  … and ${result.failures.length - 20} more`);
    }
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await closeDatabasePools();
}
