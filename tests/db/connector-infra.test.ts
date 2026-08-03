import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeOAuthConnection } from "@/connectors/connect-flow";
import { createFixtureConnector, FIXTURE_PROVIDER } from "@/connectors/fixture";
import type { TokenSet } from "@/connectors/oauth/client";
import { registerConnector, unregisterConnector } from "@/connectors/registry";
import {
  connectSource,
  syncConnection,
  syncConnectionWithin,
  toConnection,
} from "@/connectors/sync";
import { acquireProviderSlot } from "@/connectors/throttle";
import {
  getFreshAccessToken,
  ReauthorizationRequiredError,
  sealTokens,
  tokensFor,
} from "@/connectors/tokens";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { resetEnvForTesting } from "@/lib/env";
import { closeRateLimiter } from "@/lib/rate-limit";
import { withTenant } from "@/lib/tenancy";
import { decryptSecret, connectionContext, resetVaultKeysForTesting } from "@/lib/vault";
import { runScan } from "@/jobs/workers/sync-reviews";
import type { ReviewJob } from "@/jobs/queue";
import type { Queue } from "bullmq";

/**
 * P1b-T0 against a real database: the token vault on a real row, refresh under
 * a real lock, and the scheduler's pacing decisions.
 *
 * The environment is deliberately rewritten here — a vault key and the fixture
 * provider switched to `real` — because the behaviour under test is precisely
 * what changes when an environment is configured for a live provider.
 */

const VAULT_KEY = "t0:" + Buffer.alloc(32, 7).toString("base64");
const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

/** A fixture connector that answers with one empty page and a fixed token. */
function stubFixtureConnector(pages: () => Response) {
  return createFixtureConnector({
    readToken: async () => "static-access-token",
    fetchImpl: async () => pages(),
  });
}

function emptyPage(): Response {
  return new Response(JSON.stringify({ reviews: [], next_page_token: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type Fixture = { orgId: string; locationId: string };

async function makeOrg(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `T0 ${label} ${suffix}`, slug: `t0-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Şubesi` })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  return { orgId: org.id, locationId: location.id };
}

function tokenSet(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scope: "reviews.read",
    tokenType: "Bearer",
    ...overrides,
  };
}

/** Creates a fixture-provider connection carrying sealed credentials. */
async function makeConnection(
  fixture: Fixture,
  tokens: TokenSet | null = tokenSet(),
): Promise<string> {
  const sealed = tokens
    ? sealTokens(tokens, {
        organizationId: fixture.orgId,
        locationId: fixture.locationId,
        provider: FIXTURE_PROVIDER,
      })
    : null;

  const [row] = await getAdminDb()
    .insert(schema.connections)
    .values({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      provider: FIXTURE_PROVIDER,
      status: "active",
      capabilities: { read: "excerpt", reply: "none", realtime: false },
      config: {
        locationId: fixture.locationId,
        externalLocationId: "loc-1",
        apiBaseUrl: "https://fixture.test/v1",
      },
      encryptedTokens: sealed,
    })
    // `unique(location_id, provider)` means a location can hold only one
    // connection per provider, so re-fixturing must actually replace the
    // credentials and the state — otherwise a later test silently inherits an
    // earlier one's live token.
    .onConflictDoUpdate({
      target: [schema.connections.locationId, schema.connections.provider],
      set: {
        encryptedTokens: sealed,
        status: "active",
        failureCount: 0,
        lastError: null,
        nextSyncAt: null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schema.connections.id });

  if (!row) throw new Error("connection insert returned nothing");
  return row.id;
}

async function readConnection(connectionId: string) {
  const [row] = await getAdminDb()
    .select()
    .from(schema.connections)
    .where(eq(schema.connections.id, connectionId));
  if (!row) throw new Error("connection missing");
  return row;
}

let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  // A vault key and a live fixture provider: the configuration a real
  // deployment would have, which is the only one where these paths run.
  process.env.TOKEN_VAULT_KEYS = VAULT_KEY;
  process.env.CONNECTOR_FIXTURE_MODE = "real";
  resetEnvForTesting();
  resetVaultKeysForTesting();

  registerConnector(stubFixtureConnector(emptyPage));

  a = await makeOrg("a");
  b = await makeOrg("b");
});

afterAll(async () => {
  unregisterConnector(FIXTURE_PROVIDER);
  delete process.env.TOKEN_VAULT_KEYS;
  delete process.env.CONNECTOR_FIXTURE_MODE;
  resetEnvForTesting();
  resetVaultKeysForTesting();

  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeRateLimiter();
  await closeDatabasePools();
});

describe("credentials at rest", () => {
  it("stores ciphertext, never the token itself", async () => {
    const connectionId = await makeConnection(a);
    const row = await readConnection(connectionId);

    expect(row.encryptedTokens).toBeTruthy();
    // The one assertion that would catch a regression to plaintext storage.
    expect(row.encryptedTokens).not.toContain("refresh-token-value");
    expect(row.encryptedTokens).not.toContain("access-token-value");
    expect(row.encryptedTokens?.startsWith("v1.t0.")).toBe(true);
  });

  it("reads back through the connection's own slot", async () => {
    const connectionId = await makeConnection(a);
    const connection = toConnection(await readConnection(connectionId));

    expect(tokensFor(connection)?.refreshToken).toBe("refresh-token-value");
  });

  it("refuses to open one tenant's payload against another's slot", async () => {
    const connectionId = await makeConnection(a);
    const row = await readConnection(connectionId);

    // Copying the ciphertext into org B's row must not hand B the credentials.
    expect(() =>
      decryptSecret(
        row.encryptedTokens ?? "",
        connectionContext(b.orgId, b.locationId, FIXTURE_PROVIDER),
      ),
    ).toThrow();
  });
});

describe("access token refresh", () => {
  it("returns a live token without calling the provider", async () => {
    const connectionId = await makeConnection(a, tokenSet());
    let called = false;

    const token = await withTenant({ organizationId: a.orgId }, async (tx) =>
      getFreshAccessToken(tx, toConnection(await readConnection(connectionId)), {
        fetchImpl: async () => {
          called = true;
          return new Response("{}", { status: 200 });
        },
      }),
    );

    expect(token).toBe("access-token-value");
    expect(called).toBe(false);
  });

  it("refreshes an expired token, persists it, and keeps the refresh token", async () => {
    const connectionId = await makeConnection(
      a,
      tokenSet({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    );

    const token = await withTenant({ organizationId: a.orgId }, async (tx) =>
      getFreshAccessToken(tx, toConnection(await readConnection(connectionId)), {
        // The provider issues no new refresh token — the Google behaviour that
        // silently kills a connection if the response is stored verbatim.
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              access_token: "fresh-access",
              expires_in: 3600,
              token_type: "Bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      }),
    );

    expect(token).toBe("fresh-access");

    const stored = tokensFor(toConnection(await readConnection(connectionId)));
    expect(stored?.accessToken).toBe("fresh-access");
    expect(stored?.refreshToken).toBe("refresh-token-value");
  });

  it("parks the connection when the grant is revoked", async () => {
    const connectionId = await makeConnection(
      a,
      tokenSet({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    );

    const failure = await withTenant({ organizationId: a.orgId }, async (tx) =>
      getFreshAccessToken(tx, toConnection(await readConnection(connectionId)), {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      }).catch((error: unknown) => error),
    );

    expect(failure).toBeInstanceOf(ReauthorizationRequiredError);
    // Parked, so the scheduler stops retrying a dead grant and the UI can ask
    // for a reconnect.
    expect((await readConnection(connectionId)).status).toBe("error");
  });

  it("asks for reauthorization when there are no credentials at all", async () => {
    const connectionId = await makeConnection(a, null);

    const failure = await withTenant({ organizationId: a.orgId }, async (tx) =>
      getFreshAccessToken(tx, toConnection(await readConnection(connectionId))).catch(
        (error: unknown) => error,
      ),
    );

    expect(failure).toBeInstanceOf(ReauthorizationRequiredError);
  });
});

describe("completing an OAuth handshake", () => {
  it("creates a pending connection carrying sealed credentials", async () => {
    const c = await makeOrg("c");

    const { connectionId } = await withTenant({ organizationId: c.orgId }, (tx) =>
      completeOAuthConnection(tx, {
        organizationId: c.orgId,
        locationId: c.locationId,
        provider: FIXTURE_PROVIDER,
        tokens: tokenSet(),
        actorUserId: null,
      }),
    );

    const row = await readConnection(connectionId);
    // Authorized but not yet mapped: the provider's own step finishes it.
    expect(row.status).toBe("pending");
    expect(tokensFor(toConnection(row))?.accessToken).toBe("access-token-value");

    const [audit] = await getAdminDb()
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, c.orgId));

    expect(audit?.action).toBe("connection.authorized");
    // The audit trail records that it happened, never what was granted.
    expect(JSON.stringify(audit?.meta)).not.toContain("access-token-value");
  });

  it("clears the error state when a customer reconnects", async () => {
    const d = await makeOrg("d");
    const connectionId = await makeConnection(d, tokenSet());

    await getAdminDb()
      .update(schema.connections)
      .set({
        status: "error",
        failureCount: 5,
        lastError: "invalid_grant",
        nextSyncAt: new Date(Date.now() + 3_600_000),
      })
      .where(eq(schema.connections.id, connectionId));

    await withTenant({ organizationId: d.orgId }, (tx) =>
      completeOAuthConnection(tx, {
        organizationId: d.orgId,
        locationId: d.locationId,
        provider: FIXTURE_PROVIDER,
        tokens: tokenSet({ accessToken: "reconnected" }),
        actorUserId: null,
      }),
    );

    const row = await readConnection(connectionId);
    expect(row.failureCount).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.nextSyncAt).toBeNull();
    expect(tokensFor(toConnection(row))?.accessToken).toBe("reconnected");
  });

  it("refuses a location belonging to another organization", async () => {
    await expect(
      withTenant({ organizationId: a.orgId }, (tx) =>
        completeOAuthConnection(tx, {
          organizationId: a.orgId,
          // B's location, A's tenant context.
          locationId: b.locationId,
          provider: FIXTURE_PROVIDER,
          tokens: tokenSet(),
          actorUserId: null,
        }),
      ),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("sync pacing", () => {
  it("records the schedule after a successful sync", async () => {
    const e = await makeOrg("e");

    const connection = await withTenant({ organizationId: e.orgId }, (tx) =>
      connectSource(tx, {
        organizationId: e.orgId,
        provider: "mock",
        config: { locationId: e.locationId, backfillCount: 3 },
      }),
    );

    const outcome = await withTenant({ organizationId: e.orgId }, (tx) =>
      syncConnectionWithin(tx, toConnection(connection)),
    );

    expect(outcome.skipped).toBeUndefined();
    expect(outcome.inserted).toBeGreaterThan(0);

    const row = await readConnection(connection.id);
    expect(row.lastSyncedAt).not.toBeNull();
    expect(row.nextSyncAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
    expect(row.failureCount).toBe(0);
  });

  it("declines a second sync inside the interval, unless told to ignore it", async () => {
    const f = await makeOrg("f");

    const connection = await withTenant({ organizationId: f.orgId }, (tx) =>
      connectSource(tx, {
        organizationId: f.orgId,
        provider: "mock",
        config: { locationId: f.locationId, backfillCount: 2 },
      }),
    );

    await withTenant({ organizationId: f.orgId }, (tx) =>
      syncConnectionWithin(tx, toConnection(connection)),
    );

    const tooSoon = await withTenant({ organizationId: f.orgId }, async (tx) =>
      syncConnectionWithin(tx, toConnection(await readConnection(connection.id))),
    );
    expect(tooSoon.skipped).toBe("not_due");

    // "Sync now" in the UI is allowed to jump the interval.
    const forced = await withTenant({ organizationId: f.orgId }, async (tx) =>
      syncConnectionWithin(tx, toConnection(await readConnection(connection.id)), {
        ignoreSchedule: true,
      }),
    );
    expect(forced.skipped).toBeUndefined();
  });

  it("backs a failing connection off, further each time", async () => {
    const g = await makeOrg("g");

    const connection = await withTenant({ organizationId: g.orgId }, (tx) =>
      connectSource(tx, {
        organizationId: g.orgId,
        provider: "mock",
        config: {
          locationId: g.locationId,
          simulate: { failFetch: true, failReply: false, retryable: true },
        },
      }),
    );

    // syncConnection, not syncConnectionWithin: the failure bookkeeping lives
    // in the wrapper that owns the transaction boundary.
    await expect(syncConnection(g.orgId, connection.id, { ignoreSchedule: true })).rejects.toThrow(
      /Simulated upstream failure/,
    );

    const first = await readConnection(connection.id);
    expect(first.status).toBe("error");
    expect(first.failureCount).toBe(1);
    expect(first.lastError).toMatch(/Simulated upstream failure/);
    const firstDelay = (first.nextSyncAt?.getTime() ?? 0) - Date.now();
    expect(firstDelay).toBeGreaterThan(0);

    await expect(
      syncConnection(g.orgId, connection.id, { ignoreSchedule: true }),
    ).rejects.toThrow();

    const second = await readConnection(connection.id);
    expect(second.failureCount).toBe(2);
    // Each consecutive failure waits longer, so a source that is genuinely
    // down is not retried sixty times an hour forever.
    expect((second.nextSyncAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(firstDelay);
  });

  it("defers when the provider's per-minute budget is spent", async () => {
    const h = await makeOrg("h");
    const connectionId = await makeConnection(h, tokenSet());

    // The fixture provider's policy is 10 requests a minute; spend them.
    for (let i = 0; i < 10; i += 1) {
      await acquireProviderSlot(FIXTURE_PROVIDER);
    }

    const outcome = await withTenant({ organizationId: h.orgId }, async (tx) =>
      syncConnectionWithin(tx, toConnection(await readConnection(connectionId)), {
        ignoreSchedule: true,
      }),
    );

    // Deferred, not failed: the budget is shared across tenants and processes.
    expect(outcome.skipped).toBe("rate_limited");
    expect((await readConnection(connectionId)).nextSyncAt?.getTime() ?? 0).toBeGreaterThan(
      Date.now(),
    );
    expect((await readConnection(connectionId)).status).not.toBe("error");
  });
});

describe("the scheduled scan", () => {
  function fakeQueue(): { queue: Queue<ReviewJob>; added: string[] } {
    const added: string[] = [];
    const queue = {
      add: async (_name: string, data: ReviewJob) => {
        if (data.kind === "sync") added.push(data.connectionId);
        return {};
      },
    } as unknown as Queue<ReviewJob>;

    return { queue, added };
  }

  it("skips connections that are still backing off", async () => {
    const i = await makeOrg("i");
    const due = await makeConnection(i, tokenSet());

    const j = await makeOrg("j");
    const parked = await makeConnection(j, tokenSet());
    await getAdminDb()
      .update(schema.connections)
      .set({ nextSyncAt: new Date(Date.now() + 3_600_000) })
      .where(eq(schema.connections.id, parked));

    const { queue, added } = fakeQueue();
    await runScan(queue);

    expect(added).toContain(due);
    // Without this the minute-by-minute rescan would defeat every backoff.
    expect(added).not.toContain(parked);
  });

  it("never dispatches a source that cannot be read", async () => {
    const k = await makeOrg("k");

    const [row] = await getAdminDb()
      .insert(schema.connections)
      .values({
        organizationId: k.orgId,
        locationId: k.locationId,
        // WhatsApp is outbound messaging, not a review feed.
        provider: "whatsapp",
        status: "active",
        capabilities: { read: "none", reply: "api", realtime: true },
        config: { locationId: k.locationId },
      })
      .returning({ id: schema.connections.id });

    const { queue, added } = fakeQueue();
    await runScan(queue);

    expect(added).not.toContain(row?.id);
  });
});
