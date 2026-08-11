import pino from "pino";
import { describe, expect, it } from "vitest";
import { loggerOptions } from "@/lib/logger";

/**
 * Reviews and connection tokens are personal data / credentials (KVKK-GDPR).
 * Redaction is a compliance control, so it gets a real test rather than a
 * manual eyeball — pino matches redact paths literally, and a bare `token`
 * key is NOT covered by a `*.token` path.
 */
function captureLog(payload: Record<string, unknown>, message: string): Record<string, unknown> {
  const lines: string[] = [];

  // The level is pinned rather than inherited. loggerOptions.level comes from
  // LOG_LEVEL, so these tests silently emitted nothing wherever that was set
  // above "info" — they passed locally and failed in CI, which runs at "warn".
  // What is under test here is serialization and redaction, not filtering.
  const log = pino(
    { ...loggerOptions, level: "trace" },
    {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  );

  log.info(payload, message);

  const [line] = lines;
  expect(line, "expected exactly one log line").toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

describe("logger", () => {
  it("emits structured JSON with the app name and an ISO timestamp", () => {
    const entry = captureLog({ orgId: "org_123" }, "hello");

    expect(entry.level).toBe("info");
    expect(entry.app).toBe("fairfame");
    expect(entry.msg).toBe("hello");
    expect(entry.orgId).toBe("org_123");
    expect(String(entry.time)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("redacts secrets at the top level", () => {
    const entry = captureLog({ token: "super-secret", password: "hunter2" }, "top level");

    expect(entry.token).toBe("[redacted]");
    expect(entry.password).toBe("[redacted]");
  });

  it("redacts secrets nested one level down", () => {
    const entry = captureLog(
      { conn: { accessToken: "nested-secret", refreshToken: "also-secret", provider: "mock" } },
      "nested",
    );

    const conn = entry.conn as Record<string, unknown>;
    expect(conn.accessToken).toBe("[redacted]");
    expect(conn.refreshToken).toBe("[redacted]");
    // Non-secret fields must survive redaction.
    expect(conn.provider).toBe("mock");
  });

  it("does not claim the reserved `service` field, so callers may use it", () => {
    // A base binding named "service" would shadow the far more useful
    // per-record meaning: which dependency, queue or provider this is about.
    const entry = captureLog({ service: "redis", ok: false }, "probe failed");

    expect(entry.app).toBe("fairfame");
    expect(entry.service).toBe("redis");
  });

  it("leaves non-secret tenant fields intact", () => {
    const entry = captureLog({ organizationId: "org_1", locationId: "loc_1" }, "tenant scope");

    expect(entry.organizationId).toBe("org_1");
    expect(entry.locationId).toBe("loc_1");
  });
});
