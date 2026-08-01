import { checkInfra, type ProbeResult } from "./infra.ts";

/**
 * Health reporting.
 *
 * The shaping is a pure function so it can be tested without a database, and
 * so the one judgement that matters — which failures make the service
 * unhealthy — lives somewhere a test can pin it.
 *
 * Deliberately terse in what it returns. `/health` is typically reachable
 * without authentication, and a probe's `detail` carries the Postgres version
 * banner on success and a connection string fragment on failure. Neither
 * belongs in an unauthenticated response, so both are logged instead.
 */

export type HealthStatus = "ok" | "degraded";

export type HealthCheck = {
  service: string;
  ok: boolean;
  durationMs: number;
};

export type HealthReport = {
  status: HealthStatus;
  checks: HealthCheck[];
};

/** Pure: turns raw probes into the public payload. */
export function toHealthReport(results: ProbeResult[]): HealthReport {
  return {
    // Any unreachable dependency is degraded. There is no partial credit: the
    // app cannot serve tenant data without Postgres, nor sync without Redis.
    status: results.every((result) => result.ok) ? "ok" : "degraded",
    checks: results.map((result) => ({
      service: result.service,
      ok: result.ok,
      durationMs: Math.round(result.durationMs),
    })),
  };
}

/** HTTP status for a report: 503 tells a load balancer to stop sending traffic. */
export function healthHttpStatus(report: HealthReport): number {
  return report.status === "ok" ? 200 : 503;
}

/** Probes every dependency and shapes the result. Never throws. */
export async function getHealth(): Promise<{ report: HealthReport; results: ProbeResult[] }> {
  const { results } = await checkInfra();
  return { report: toHealthReport(results), results };
}
