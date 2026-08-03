/**
 * The go-live readiness suite (P1b-T6).
 *
 *   pnpm golive              # every platform
 *   pnpm golive -- google    # one
 *   pnpm golive -- --json
 *
 * Run this when credentials arrive. It answers one question per platform —
 * *would this actually work right now?* — by checking configuration and then,
 * where it safely can, making a **read-only** call against the live API.
 *
 * Two rules shape it:
 *
 *   - **Nothing here writes.** No reply is posted, no message is sent, no
 *     consent is uploaded. A readiness check that had side effects would be a
 *     thing people are afraid to run, and the first run happens against a real
 *     business's account.
 *   - **"Not configured" is a normal answer, not a failure of the script.** The
 *     expected state today is that every platform is unconfigured; the exit code
 *     reflects whether anything is *broken*, not whether everything is ready.
 *
 * The per-platform prerequisites — the accounts, verifications and approvals
 * that have to exist before any of this can pass — are in `docs/13-go-live.md`.
 */
import { eq } from "drizzle-orm";
import { installIysGateway } from "../src/compliance/iys-gateway.ts";
import { createGoogleClient } from "../src/connectors/google/client.ts";
import { createInstagramClient } from "../src/connectors/instagram/client.ts";
import { pendingTemplates } from "../src/connectors/whatsapp/templates.ts";
import { getProvider, resolveMode } from "../src/connectors/providers.ts";
import { closeDatabasePools, getAdminDb, schema } from "../src/db/client.ts";
import { getEnv } from "../src/lib/env.ts";
import { toConnection } from "../src/connectors/sync.ts";

type Status = "ready" | "not_configured" | "blocked";

type Check = { label: string; status: Status; detail?: string };
type PlatformReport = { platform: string; status: Status; checks: Check[] };

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const only = args.filter((arg) => !arg.startsWith("--"));

const env = getEnv();

/** Worst status wins: one blocked check blocks the platform. */
function rollUp(checks: Check[]): Status {
  if (checks.some((check) => check.status === "blocked")) return "blocked";
  if (checks.some((check) => check.status === "not_configured")) return "not_configured";
  return "ready";
}

/** Is a provider's flag set to real, with credentials and a vault behind it? */
function modeCheck(provider: string): Check {
  const descriptor = getProvider(provider);
  if (!descriptor) return { label: "provider registered", status: "blocked" };

  const resolution = resolveMode(provider);

  if (resolution.mode === "real") return { label: "provider mode", status: "ready" };

  if (resolution.configured !== "real") {
    return {
      label: "provider mode",
      status: "not_configured",
      detail: `${descriptor.modeEnvVar}=${resolution.configured}; set it to \`real\``,
    };
  }

  // Asked for real and demoted. That is a misconfiguration rather than an
  // absence, so it blocks: someone believes this is live and it is not.
  return {
    label: "provider mode",
    status: "blocked",
    detail:
      resolution.reason === "missing_credentials"
        ? "asked for `real` but the credentials are missing"
        : "asked for `real` but TOKEN_VAULT_KEYS is missing or unparseable",
  };
}

function envCheck(label: string, value: string | undefined, hint: string): Check {
  return value ? { label, status: "ready" } : { label, status: "not_configured", detail: hint };
}

/** The first active connection for a provider, if a tenant has made one. */
async function firstConnection(provider: string) {
  const [row] = await getAdminDb()
    .select()
    .from(schema.connections)
    .where(eq(schema.connections.provider, provider))
    .limit(1);

  return row ?? null;
}

async function googleReport(): Promise<PlatformReport> {
  const checks: Check[] = [
    modeCheck("google"),
    envCheck(
      "GOOGLE_CLIENT_ID",
      env.GOOGLE_CLIENT_ID,
      "create OAuth credentials in the Cloud project",
    ),
    envCheck("GOOGLE_CLIENT_SECRET", env.GOOGLE_CLIENT_SECRET, "same place as the client id"),
    envCheck(
      "TOKEN_VAULT_KEYS",
      env.TOKEN_VAULT_KEYS,
      "generate a 32-byte key: see src/lib/vault.ts",
    ),
  ];

  const connection = await firstConnection("google");

  if (!connection) {
    checks.push({
      label: "live read",
      status: "not_configured",
      detail: "no Google connection exists yet — connect one from Locations first",
    });
  } else if (rollUp(checks) !== "ready") {
    checks.push({
      label: "live read",
      status: "not_configured",
      detail: "skipped: not configured",
    });
  } else {
    // Read-only: list the accounts the token can see. Proves the token, the
    // scopes and API access in one call, and changes nothing.
    try {
      const accounts = await createGoogleClient().listAccounts(toConnection(connection));
      checks.push({
        label: "live read",
        status: "ready",
        detail: `${accounts.length} account(s) visible`,
      });
    } catch (error) {
      checks.push({
        label: "live read",
        status: "blocked",
        detail: error instanceof Error ? error.message : "unknown failure",
      });
    }
  }

  return { platform: "google", status: rollUp(checks), checks };
}

async function instagramReport(): Promise<PlatformReport> {
  const checks: Check[] = [
    modeCheck("instagram"),
    envCheck(
      "META_APP_ID",
      env.META_APP_ID,
      "create the Meta app and complete business verification",
    ),
    envCheck("META_APP_SECRET", env.META_APP_SECRET, "same app"),
    envCheck(
      "INSTAGRAM_VERIFY_TOKEN",
      env.INSTAGRAM_VERIFY_TOKEN,
      "any secret string; Meta echoes it when subscribing the webhook",
    ),
    envCheck("TOKEN_VAULT_KEYS", env.TOKEN_VAULT_KEYS, "generate a 32-byte key"),
  ];

  const connection = await firstConnection("instagram");

  if (!connection) {
    checks.push({
      label: "live read",
      status: "not_configured",
      detail: "no Instagram connection exists yet",
    });
  } else if (rollUp(checks) !== "ready") {
    checks.push({
      label: "live read",
      status: "not_configured",
      detail: "skipped: not configured",
    });
  } else {
    const accountId = (connection.config as { accountId?: string }).accountId;

    try {
      const account = await createInstagramClient().getAccount(
        toConnection(connection),
        accountId ?? "",
      );
      checks.push({
        label: "live read",
        status: "ready",
        detail: `@${account.username ?? account.id}`,
      });
    } catch (error) {
      checks.push({
        label: "live read",
        status: "blocked",
        detail: error instanceof Error ? error.message : "unknown failure",
      });
    }
  }

  return { platform: "instagram", status: rollUp(checks), checks };
}

async function whatsappReport(): Promise<PlatformReport> {
  const pending = pendingTemplates();

  const checks: Check[] = [
    envCheck("WHATSAPP_ACCESS_TOKEN", env.WHATSAPP_ACCESS_TOKEN, "system-user token for the WABA"),
    envCheck(
      "WHATSAPP_PHONE_NUMBER_ID",
      env.WHATSAPP_PHONE_NUMBER_ID,
      "the number *id* from the WhatsApp Manager, not the display number",
    ),
    envCheck("WHATSAPP_VERIFY_TOKEN", env.WHATSAPP_VERIFY_TOKEN, "any secret string"),
    envCheck("WHATSAPP_APP_SECRET", env.WHATSAPP_APP_SECRET, "used to verify inbound webhooks"),
    pending.length === 0
      ? { label: "message templates", status: "ready" }
      : {
          label: "message templates",
          status: "not_configured",
          detail: `${pending.length} awaiting approval: ${pending.map((t) => t.name).join(", ")}`,
        },
  ];

  // No live call. The cheapest WhatsApp API call still touches a number Meta
  // rate-limits and quality-scores, and there is no read-only endpoint worth
  // the risk on a first run against a real business's line.
  checks.push({
    label: "live send",
    status: "not_configured",
    detail: "not attempted: every WhatsApp call is a write. Verify manually — see docs/13.",
  });

  return { platform: "whatsapp", status: rollUp(checks), checks };
}

async function complianceReport(): Promise<PlatformReport> {
  const gateway = installIysGateway();

  const checks: Check[] = [
    env.IYS_REQUIRED
      ? { label: "İYS applies", status: "ready", detail: "IYS_REQUIRED=true" }
      : {
          label: "İYS applies",
          status: "not_configured",
          detail: "IYS_REQUIRED=false — correct only outside Türkiye",
        },
    gateway === null
      ? {
          label: "İYS gateway",
          // Unconfigured is the *intended* state before go-live — commercial
          // sends refuse, which is the whole design. It only becomes a
          // misconfiguration in production, where someone believes the product
          // can send and it cannot.
          status: env.NODE_ENV === "production" && env.IYS_REQUIRED ? "blocked" : "not_configured",
          detail: "IYS_GATEWAY=none: every commercial send is refused",
        }
      : gateway === "local" && env.NODE_ENV === "production"
        ? {
            label: "İYS gateway",
            status: "blocked",
            detail: "IYS_GATEWAY=local in production; it refuses, and rightly so",
          }
        : { label: "İYS gateway", status: "ready", detail: gateway },
  ];

  return { platform: "compliance", status: rollUp(checks), checks };
}

const REPORTERS: Record<string, () => Promise<PlatformReport>> = {
  google: googleReport,
  instagram: instagramReport,
  whatsapp: whatsappReport,
  compliance: complianceReport,
};

const selected = only.length > 0 ? only : Object.keys(REPORTERS);
const unknown = selected.filter((name) => !(name in REPORTERS));

if (unknown.length > 0) {
  console.error(`Unknown platform(s): ${unknown.join(", ")}`);
  console.error(`Available: ${Object.keys(REPORTERS).join(", ")}`);
  await closeDatabasePools();
  process.exit(1);
}

const reports: PlatformReport[] = [];
for (const name of selected) {
  reports.push(await REPORTERS[name]!());
}

const SYMBOL: Record<Status, string> = {
  ready: "✓",
  not_configured: "·",
  blocked: "✗",
};

if (asJson) {
  console.log(JSON.stringify({ nodeEnv: env.NODE_ENV, reports }, null, 2));
} else {
  console.log(`environment: ${env.NODE_ENV}\n`);

  for (const report of reports) {
    console.log(`${SYMBOL[report.status]} ${report.platform}`);
    for (const check of report.checks) {
      const detail = check.detail ? `  — ${check.detail}` : "";
      console.log(`    ${SYMBOL[check.status]} ${check.label}${detail}`);
    }
    console.log("");
  }

  const blocked = reports.filter((report) => report.status === "blocked");
  const ready = reports.filter((report) => report.status === "ready");

  console.log(
    blocked.length > 0
      ? `✗ ${blocked.length} platform(s) misconfigured: ${blocked.map((r) => r.platform).join(", ")}`
      : `${ready.length}/${reports.length} platform(s) ready. The rest are unconfigured, which is expected before go-live.`,
  );
  console.log("\nPrerequisites per platform: docs/13-go-live.md");
}

// Blocked means someone believes a platform is live and it is not — worth
// failing a pipeline over. Merely unconfigured is the expected state today.
if (reports.some((report) => report.status === "blocked")) process.exitCode = 1;

await closeDatabasePools();
