import { afterEach, describe, expect, it } from "vitest";
import { createGoogleClient } from "@/connectors/google/client";
import { createInstagramClient } from "@/connectors/instagram/client";
import { resetEnvForTesting } from "@/lib/env";
import type { Connection } from "@/connectors/types";

/**
 * The connectors can be pointed at `pnpm mock:platform`.
 *
 * The behaviour half of `env-example.test.ts`. That one proves the variables
 * exist and are documented; this proves setting them does something, which is
 * the part that was missing — `createGoogleClient` and `createInstagramClient`
 * both took a base URL as an option, only tests ever passed it, and the fake
 * Google and fake Meta served requests the connectors were never sent.
 *
 * Asserted on the URL the client actually fetches rather than on the option it
 * was constructed with: the whole failure was a value that existed and was
 * never carried anywhere.
 */

const connection = {
  id: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  provider: "google",
  externalId: "accounts/1",
} as unknown as Connection;

/** Captures the first URL asked for, then answers something schema-shaped. */
function recorder(body: unknown) {
  const seen: string[] = [];

  const fetchImpl = (input: string) => {
    seen.push(input);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  return { seen, fetchImpl };
}

afterEach(() => {
  delete process.env.GOOGLE_ACCOUNT_MANAGEMENT_BASE_URL;
  delete process.env.META_GRAPH_BASE_URL;
  resetEnvForTesting();
});

describe("base URLs come from the environment", () => {
  it("Google reads GOOGLE_ACCOUNT_MANAGEMENT_BASE_URL", async () => {
    process.env.GOOGLE_ACCOUNT_MANAGEMENT_BASE_URL = "http://localhost:4319/google/account/v1";
    resetEnvForTesting();

    const { seen, fetchImpl } = recorder({ accounts: [] });
    const client = createGoogleClient({ fetchImpl, readToken: () => Promise.resolve("token") });
    await client.listAccounts(connection);

    expect(seen[0]).toBe("http://localhost:4319/google/account/v1/accounts?pageSize=100");
  });

  it("Instagram reads META_GRAPH_BASE_URL", async () => {
    process.env.META_GRAPH_BASE_URL = "http://localhost:4319/meta/v21.0";
    resetEnvForTesting();

    const { seen, fetchImpl } = recorder({ id: "17841400000000000", username: "cafe" });
    const client = createInstagramClient({ fetchImpl, readToken: () => Promise.resolve("token") });
    await client.getAccount(connection, "17841400000000000");

    expect(seen[0]).toContain("http://localhost:4319/meta/v21.0/");
  });

  it("falls back to the real API when nothing is set", async () => {
    resetEnvForTesting();

    const { seen, fetchImpl } = recorder({ accounts: [] });
    const client = createGoogleClient({ fetchImpl, readToken: () => Promise.resolve("token") });
    await client.listAccounts(connection);

    // The only correct answer for a customer, and the reason these are absent
    // from every real deployment.
    expect(seen[0]).toContain("https://mybusinessaccountmanagement.googleapis.com/v1");
  });

  it("an explicit option still wins over the environment", async () => {
    process.env.GOOGLE_ACCOUNT_MANAGEMENT_BASE_URL = "http://localhost:4319/google/account/v1";
    resetEnvForTesting();

    const { seen, fetchImpl } = recorder({ accounts: [] });
    const client = createGoogleClient({
      fetchImpl,
      readToken: () => Promise.resolve("token"),
      accountManagementBaseUrl: "http://localhost:9999/v1",
    });
    await client.listAccounts(connection);

    // Contract tests pass the option directly and must not be overridden by
    // whatever a developer left in their `.env`.
    expect(seen[0]).toContain("http://localhost:9999/v1");
  });
});
