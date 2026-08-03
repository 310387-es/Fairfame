/**
 * Smoke-tests the configured AI provider against a real review.
 *
 *   pnpm ai:smoke
 *
 * Exists because "is the key working, on a model this account can reach?" is a
 * question that recurs — at first setup, when a free tier changes its model
 * line-up, and at go-live when the provider flips to Anthropic. It makes one
 * cheap call and prints what it cost.
 *
 * Reads AI_PROVIDER from .env, so it tests whatever the app would actually use.
 */
import { eq } from "drizzle-orm";
import { analyzeReview } from "../src/ai/analyze.ts";
import { getLlmProvider } from "../src/ai/client.ts";
import { closeDatabasePools, getAdminDb, schema } from "../src/db/client.ts";
import { getEnv } from "../src/lib/env.ts";

// A real Turkish review — the launch market's language is the one worth
// smoke-testing, since that is where quality is least certain.
const REVIEW = {
  text: "Kahvesi gerçekten güzeldi ama siparişimiz 25 dakika sürdü ve garson pek ilgili değildi.",
  rating: 2,
};

const env = getEnv();
console.log(`provider: ${env.AI_PROVIDER}`);

if (env.AI_PROVIDER === "stub") {
  console.log(
    "\nAI_PROVIDER is `stub` — this will not call anything real.\n" +
      "Set a key and switch AI_PROVIDER to `gemini` (or `anthropic`) in .env first.",
  );
}

const provider = getLlmProvider();
console.log(`model:    ${provider.model}\n`);

/**
 * Audit rows are foreign-keyed to a real organization, so borrow the seeded
 * demo org. Without one the call still works — the client logs the failed
 * bookkeeping and returns the analysis — but the noise drowns the output.
 */
const [demoOrg] = await getAdminDb()
  .select({ id: schema.organizations.id })
  .from(schema.organizations)
  .where(eq(schema.organizations.slug, "demo"))
  .limit(1);

if (!demoOrg) {
  console.log("(no demo organization — run `pnpm db:seed`; the audit write will be skipped)\n");
}

const started = Date.now();

try {
  const { analysis, costUsd, listCostUsd, model } = await analyzeReview({
    organizationId: demoOrg?.id ?? "00000000-0000-4000-8000-000000000000",
    text: REVIEW.text,
    rating: REVIEW.rating,
  });

  console.log(`review:    ${REVIEW.text}`);
  console.log(`rating:    ${REVIEW.rating}/5\n`);
  console.log(`sentiment: ${analysis.sentiment} (${analysis.sentimentScore})`);
  console.log(`topics:    ${analysis.topics.join(", ")}`);
  console.log(`language:  ${analysis.language}`);
  console.log(`\nmodel:     ${model}`);
  console.log(`cost:      $${costUsd.toFixed(6)} billed / $${listCostUsd.toFixed(6)} at list`);
  console.log(`took:      ${Date.now() - started}ms`);

  const looksRight = analysis.sentiment === "negative" && analysis.language === "tr";
  console.log(
    looksRight
      ? "\n✓ Negative sentiment in Turkish — as expected for this review."
      : "\n! Unexpected classification. Worth a look before trusting the provider.",
  );
} catch (error) {
  console.error(`\n✗ Failed after ${Date.now() - started}ms`);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDatabasePools();
}
