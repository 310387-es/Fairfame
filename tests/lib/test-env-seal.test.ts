import { describe, expect, it } from "vitest";
import { SEALED_CREDENTIALS } from "../setup-unit-env.ts";

/**
 * The unit suite carries no credentials.
 *
 * A completeness test in the sense `docs/16` means: it proves nothing about
 * behaviour and everything about the environment behaviour is measured in. The
 * suites it protects — billing, AI, messaging — are all written as "with nothing
 * configured, this refuses", and every one of them passes for the wrong reason
 * on a machine that happens to export the real thing. CI was that machine for
 * one commit, and the failure was three tests deep in a file nobody had touched.
 *
 * If the seal in `tests/setup-unit-env.ts` is removed or a setup file stops
 * being loaded, this is what says so, instead of a payment provider answering
 * 401 six files later.
 */
describe("the unit suite is sealed against real credentials", () => {
  it.each(SEALED_CREDENTIALS)("%s is not visible to a test", (key) => {
    expect(
      process.env[key],
      `${key} reached the unit suite. It is sealed in tests/setup-unit-env.ts because a ` +
        "test that can see it can reach the service behind it; set it inside the test that " +
        "needs it and restore it afterwards.",
    ).toBeUndefined();
  });

  it("names every credential once", () => {
    expect(new Set(SEALED_CREDENTIALS).size).toBe(SEALED_CREDENTIALS.length);
  });
});
