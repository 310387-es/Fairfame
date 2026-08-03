import { describe, expect, it } from "vitest";
import { jobId, syncJobId } from "@/jobs/queue";

/**
 * Job ids must never contain a colon (P1a-T8 bug fix).
 *
 * BullMQ 6 rejects a custom id containing `:` unless it splits into exactly
 * three parts — a compatibility shim its own source marks for removal. Ids that
 * happen to have three segments pass today and break on that change; the digest
 * id embedded an ISO timestamp, whose colons made it five, and it failed the
 * moment a user pressed "Generate now".
 *
 * These tests exist so no future id can reintroduce the dependency.
 */

describe("jobId", () => {
  it("never emits a colon", () => {
    expect(jobId("digest", "loc-1", "2026-07-20T00:00:00.000Z")).not.toContain(":");
  });

  it("strips colons out of the parts it is given", () => {
    // The ISO timestamp is the case that actually broke.
    expect(jobId("digest", "loc-1", "2026-07-20T00:00:00.000Z")).toBe(
      "digest~loc-1~2026-07-20T00-00-00.000Z",
    );
  });

  it("accepts any number of parts", () => {
    // The old ids worked only because they happened to have three segments.
    expect(jobId("a", "b")).toBe("a~b");
    expect(jobId("a", "b", "c", "d", 5)).toBe("a~b~c~d~5");
  });

  it("keeps the connection id readable in a sync id", () => {
    expect(syncJobId("conn-1")).toBe("sync~conn-1");
  });
});
