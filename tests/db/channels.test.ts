import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  channelCredentials,
  connectChannel,
  disconnectChannel,
  getChannelConnection,
  listChannelConnections,
  recordChannelError,
} from "@/channels/store";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { resetEnvForTesting } from "@/lib/env";
import { withTenant } from "@/lib/tenancy";
import { resetVaultKeysForTesting } from "@/lib/vault";

/**
 * Messaging channels (W2.2).
 *
 * A channel is where a message *leaves*, which makes this table the one place
 * in the product holding a credential that can write to somebody else's phone.
 * So the assertions are about the two things that would matter if they were
 * wrong: that the credential never crosses a tenant boundary, and that it is
 * never readable from the row.
 */

/**
 * The suite supplies its own vault key, as every other credential-handling DB
 * test here does (`connector-infra`, `instagram-ingest`).
 *
 * It has to. `TOKEN_VAULT_KEYS` is a deployment secret and is deliberately
 * absent from CI's generated `.env`, so a suite that relied on the developer's
 * own `.env` passes on the machine it was written on and fails everywhere
 * else — which is exactly what happened: green locally, eight failures on the
 * first CI run. A test about sealing credentials must set up the seal itself.
 */
const VAULT_KEY = "t0:" + Buffer.alloc(32, 11).toString("base64");

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

async function makeOrg(label: string): Promise<string> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Channel ${label} ${suffix}`, slug: `channel-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);
  return org.id;
}

const connect = (organizationId: string, token: string, externalId = "phone-1") =>
  withTenant({ organizationId }, (tx) =>
    connectChannel(tx, {
      organizationId,
      channel: "whatsapp",
      externalId,
      displayName: "WhatsApp Business",
      accessToken: token,
    }),
  );

beforeAll(async () => {
  process.env.TOKEN_VAULT_KEYS = VAULT_KEY;
  resetEnvForTesting();
  resetVaultKeysForTesting();

  await makeOrg("a");
  await makeOrg("b");
});

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();

  // Put the process back as it was found: these are module-level caches, and a
  // suite that leaves a key behind makes the next one pass for its reasons.
  delete process.env.TOKEN_VAULT_KEYS;
  resetEnvForTesting();
  resetVaultKeysForTesting();
});

describe("connecting a channel", () => {
  it("stores the account and hands back credentials to send with", async () => {
    const org = await makeOrg("connect");
    await connect(org, "token-connect");

    const credentials = await withTenant({ organizationId: org }, (tx) =>
      channelCredentials(tx, org, "whatsapp"),
    );

    expect(credentials).toEqual({ accessToken: "token-connect", externalId: "phone-1" });
  });

  it("never writes the token where the row can be read", async () => {
    // The one assertion that would matter if it were wrong. Checked against the
    // stored bytes rather than against the API, because the API is not what a
    // backup, a log drain or a support query reads.
    const org = await makeOrg("sealed");
    await connect(org, "super-secret-token");

    const [row] = await getAdminDb()
      .select({ tokens: schema.channelConnections.encryptedTokens })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.organizationId, org));

    expect(row?.tokens).toBeTruthy();
    expect(row?.tokens).not.toContain("super-secret-token");
  });

  it("replaces the credentials rather than adding a second account", async () => {
    // Reconnecting is the ordinary case — a token expires, a business moves
    // number. A second row would be a second answer to "which token do we send
    // with", decided by whichever query sorted first.
    const org = await makeOrg("reconnect");
    await connect(org, "first-token", "phone-1");
    await connect(org, "second-token", "phone-2");

    const rows = await withTenant({ organizationId: org }, (tx) => listChannelConnections(tx, org));
    const credentials = await withTenant({ organizationId: org }, (tx) =>
      channelCredentials(tx, org, "whatsapp"),
    );

    expect(rows).toHaveLength(1);
    expect(credentials).toEqual({ accessToken: "second-token", externalId: "phone-2" });
  });

  it("clears a previous error when it reconnects", async () => {
    // A card still showing why last week's attempt failed, beside a channel
    // that now works, is a card nobody believes.
    const org = await makeOrg("recover");
    await connect(org, "t1");
    await withTenant({ organizationId: org }, (tx) =>
      recordChannelError(tx, org, "whatsapp", "Token expired"),
    );

    const failed = await withTenant({ organizationId: org }, (tx) =>
      getChannelConnection(tx, org, "whatsapp"),
    );
    expect(failed).toMatchObject({ status: "error", lastError: "Token expired" });

    await connect(org, "t2");
    const recovered = await withTenant({ organizationId: org }, (tx) =>
      getChannelConnection(tx, org, "whatsapp"),
    );

    expect(recovered).toMatchObject({ status: "active", lastError: null });
  });
});

describe("what may be sent with", () => {
  it("refuses to hand back credentials for a disconnected channel", async () => {
    // The record stays — "was connected and is not any more" is a different
    // fact from "never was" — but nothing may be sent with it.
    const org = await makeOrg("disconnect");
    await connect(org, "token-gone");
    await withTenant({ organizationId: org }, (tx) => disconnectChannel(tx, org, "whatsapp"));

    const credentials = await withTenant({ organizationId: org }, (tx) =>
      channelCredentials(tx, org, "whatsapp"),
    );
    const row = await withTenant({ organizationId: org }, (tx) =>
      getChannelConnection(tx, org, "whatsapp"),
    );

    expect(credentials).toBeNull();
    expect(row?.status).toBe("disconnected");
  });

  it("refuses credentials that failed the last time they were used", async () => {
    // Retrying a revoked token on a customer-facing send is how a business gets
    // its number rate-limited for a credential that died a week ago.
    const org = await makeOrg("errored");
    await connect(org, "token-bad");
    await withTenant({ organizationId: org }, (tx) =>
      recordChannelError(tx, org, "whatsapp", "401 Unauthorized"),
    );

    const credentials = await withTenant({ organizationId: org }, (tx) =>
      channelCredentials(tx, org, "whatsapp"),
    );

    expect(credentials).toBeNull();
  });

  it("has nothing to say about a channel that was never connected", async () => {
    const org = await makeOrg("absent");

    const credentials = await withTenant({ organizationId: org }, (tx) =>
      channelCredentials(tx, org, "whatsapp"),
    );

    expect(credentials).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("never returns another organization's channel", async () => {
    const [one, two] = [await makeOrg("iso-one"), await makeOrg("iso-two")];
    await connect(one, "one-token", "one-phone");
    await connect(two, "two-token", "two-phone");

    const seen = await withTenant({ organizationId: one }, (tx) => listChannelConnections(tx, one));
    const credentials = await withTenant({ organizationId: one }, (tx) =>
      channelCredentials(tx, one, "whatsapp"),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.externalId).toBe("one-phone");
    expect(credentials?.accessToken).toBe("one-token");
  });

  it("cannot open another organization's credentials even holding the bytes", async () => {
    // The vault binds a channel's tokens to `channel:{org}:{channel}`, so the
    // ciphertext is worthless in another tenant's row. Asserted by moving the
    // bytes across, which is exactly what a bad restore or a careless script
    // would do.
    const [victim, attacker] = [await makeOrg("aad-victim"), await makeOrg("aad-attacker")];
    await connect(victim, "victim-token", "victim-phone");
    await connect(attacker, "attacker-token", "attacker-phone");

    const [stolen] = await getAdminDb()
      .select({ tokens: schema.channelConnections.encryptedTokens })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.organizationId, victim));

    await getAdminDb()
      .update(schema.channelConnections)
      .set({ encryptedTokens: stolen?.tokens ?? null })
      .where(eq(schema.channelConnections.organizationId, attacker));

    const credentials = await withTenant({ organizationId: attacker }, (tx) =>
      channelCredentials(tx, attacker, "whatsapp"),
    );

    // Null, not the victim's token: the blob will not open under this binding,
    // and a channel that cannot produce credentials simply cannot send.
    expect(credentials).toBeNull();
  });
});
