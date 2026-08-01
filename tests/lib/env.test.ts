import { describe, expect, it } from "vitest";
import { parseEnvForTesting } from "@/lib/env";

const validEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://revira:revira@localhost:5432/revira",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
} satisfies NodeJS.ProcessEnv;

describe("env config", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = parseEnvForTesting(validEnv);

    expect(env.NODE_ENV).toBe("development");
    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(env.REDIS_URL).toBe(validEnv.REDIS_URL);
    // Stripe is a Phase 0 stub — absent is valid.
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it("treats an empty STRIPE_SECRET_KEY as absent rather than as a real key", () => {
    const env = parseEnvForTesting({ ...validEnv, STRIPE_SECRET_KEY: "" });
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it("coerces LOG_PRETTY from its string forms", () => {
    expect(parseEnvForTesting({ ...validEnv, LOG_PRETTY: "true" }).LOG_PRETTY).toBe(true);
    expect(parseEnvForTesting({ ...validEnv, LOG_PRETTY: "0" }).LOG_PRETTY).toBe(false);
  });

  it("rejects a missing DATABASE_URL with a readable message", () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = validEnv;

    expect(() => parseEnvForTesting(withoutDb)).toThrow(/DATABASE_URL/);
    expect(() => parseEnvForTesting(withoutDb)).toThrow(/Copy \.env\.example/);
  });

  it("rejects a database URL pointing at the wrong protocol", () => {
    expect(() =>
      parseEnvForTesting({ ...validEnv, DATABASE_URL: "mysql://localhost:3306/x" }),
    ).toThrow(/postgres/);
  });

  it("rejects a weak BETTER_AUTH_SECRET", () => {
    expect(() => parseEnvForTesting({ ...validEnv, BETTER_AUTH_SECRET: "change-me" })).toThrow(
      /at least 32 characters/,
    );
  });

  it("reports every problem at once, not just the first", () => {
    const { DATABASE_URL: _a, REDIS_URL: _b, ...broken } = validEnv;

    try {
      parseEnvForTesting(broken);
      expect.unreachable("expected validation to throw");
    } catch (error) {
      const message = String(error);
      expect(message).toMatch(/DATABASE_URL/);
      expect(message).toMatch(/REDIS_URL/);
    }
  });
});
