import { NextResponse } from "next/server";
import { getHealth, healthHttpStatus } from "@/lib/health";
import { childLogger } from "@/lib/logger";

/**
 * Dependency health probe.
 *
 * GET  — checks Postgres and Redis; 200 when both are reachable, 503 otherwise.
 * HEAD — liveness only: the process is up and serving. Cheap enough to poll
 *        frequently, and it never touches a dependency.
 *
 * Unauthenticated by design, so the body stays free of version banners and
 * connection details. Failure specifics go to the log, not to the caller.
 */

// A cached health check is a lie, so never prerender or revalidate this.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const log = childLogger({ module: "api/health" });

export async function GET() {
  const { report, results } = await getHealth();

  if (report.status !== "ok") {
    for (const result of results.filter((probe) => !probe.ok)) {
      log.error(
        {
          service: result.service,
          durationMs: Math.round(result.durationMs),
          detail: result.detail,
        },
        "Health check failed",
      );
    }
  }

  return NextResponse.json(report, {
    status: healthHttpStatus(report),
    headers: { "cache-control": "no-store" },
  });
}

export function HEAD() {
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}
