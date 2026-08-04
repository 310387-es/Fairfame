/**
 * Runs the fake platform.
 *
 *   pnpm mock:platform
 *
 * Exists so the *real* connectors can be exercised end to end before any
 * credentials arrive: point their base URLs at this and the whole loop — sync,
 * pagination, backoff, token refresh, reply posting — runs against something
 * that answers over HTTP and disagrees when the connector is wrong.
 *
 * It also keeps producing reviews. A platform that returned a fixed set would
 * let a sync look correct once; new content arriving behind rows already seen is
 * what actually exercises cursors, dedup and incremental sync.
 */
import { startMockPlatform } from "../src/connectors/mock-platform/server.ts";
import { childLogger } from "../src/lib/logger.ts";

const log = childLogger({ module: "mock-platform" });

const port = Number(process.env.MOCK_PLATFORM_PORT ?? 4010);
const backfill = Number(process.env.MOCK_PLATFORM_BACKFILL ?? 60);
const dripMs = Number(process.env.MOCK_PLATFORM_DRIP_MS ?? 30_000);

const seed = process.env.MOCK_PLATFORM_SEED ?? "mock-platform";

const platform = await startMockPlatform({
  port,
  google: { backfill, dripMs, seed },
  meta: { backfill, dripMs, seed },
});

log.info(
  {
    url: platform.url,
    googleAccount: platform.google.accountId,
    googleLocations: platform.google.locationIds,
    instagramAccount: platform.meta.accountId,
    whatsappPhoneNumberId: platform.meta.phoneNumberId,
    backfill,
    dripSeconds: Math.round(dripMs / 1000),
  },
  "Mock platform listening",
);

// Printed rather than logged: these are meant to be copied into .env.
console.log(
  [
    "",
    "Google — three services, three base URLs, as the real API has:",
    `  GOOGLE_ACCOUNT_MANAGEMENT_BASE_URL=${platform.googleBaseUrls.accountManagementBaseUrl}`,
    `  GOOGLE_BUSINESS_INFORMATION_BASE_URL=${platform.googleBaseUrls.businessInformationBaseUrl}`,
    `  GOOGLE_REVIEWS_BASE_URL=${platform.googleBaseUrls.reviewsBaseUrl}`,
    "",
    "Instagram and WhatsApp — one Graph API, one base URL:",
    `  META_GRAPH_BASE_URL=${platform.metaBaseUrl}`,
    `  instagram account   ${platform.meta.accountId}`,
    `  whatsapp phone id   ${platform.meta.phoneNumberId}`,
    "",
    `A new review and a new Instagram comment arrive every ${Math.round(dripMs / 1000)}s.`,
    "",
  ].join("\n"),
);

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "Mock platform shutting down");
  await platform.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
