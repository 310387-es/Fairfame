import { describe, expect, it } from "vitest";
import { healthHttpStatus, toHealthReport } from "@/lib/health";
import type { ProbeResult } from "@/lib/infra";

function probe(service: "postgres" | "redis", ok: boolean, detail = ""): ProbeResult {
  return { service, ok, detail, durationMs: 12.7 };
}

describe("toHealthReport", () => {
  it("is ok only when every dependency is reachable", () => {
    expect(toHealthReport([probe("postgres", true), probe("redis", true)]).status).toBe("ok");
  });

  it.each([
    ["postgres down", [probe("postgres", false), probe("redis", true)]],
    ["redis down", [probe("postgres", true), probe("redis", false)]],
    ["both down", [probe("postgres", false), probe("redis", false)]],
  ])("is degraded when %s", (_label, results) => {
    // No partial credit: the app cannot serve tenant data without Postgres,
    // nor sync without Redis.
    expect(toHealthReport(results).status).toBe("degraded");
  });

  it("reports one check per dependency, with rounded timings", () => {
    const report = toHealthReport([probe("postgres", true), probe("redis", true)]);

    expect(report.checks).toHaveLength(2);
    expect(report.checks.map((check) => check.service)).toEqual(["postgres", "redis"]);
    expect(report.checks[0]?.durationMs).toBe(13);
  });

  it("never leaks probe detail into the response", () => {
    // `/health` is unauthenticated. On success the Postgres detail is a full
    // version banner; on failure it contains host and port. Neither should be
    // readable by anyone who can reach the URL.
    const report = toHealthReport([
      probe("postgres", true, "PostgreSQL 17.10 on aarch64-unknown-linux-musl"),
      probe("redis", false, "connect ECONNREFUSED 127.0.0.1:6379"),
    ]);

    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain("PostgreSQL");
    expect(serialised).not.toContain("ECONNREFUSED");
    expect(serialised).not.toContain("127.0.0.1");
    expect(serialised).not.toContain("6379");
  });

  it("treats an empty probe list as ok rather than crashing", () => {
    // Defensive: a future refactor that probes nothing should not report a
    // false outage.
    expect(toHealthReport([]).status).toBe("ok");
  });
});

describe("healthHttpStatus", () => {
  it("returns 200 when healthy", () => {
    expect(healthHttpStatus({ status: "ok", checks: [] })).toBe(200);
  });

  it("returns 503 when degraded, so a load balancer stops sending traffic", () => {
    expect(healthHttpStatus({ status: "degraded", checks: [] })).toBe(503);
  });
});
