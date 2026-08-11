import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **Every action that can write to somebody outside the team, and whether it
 * asks** (P5-T4).
 *
 * The *behaviour* — a refusal with a named reason for an unverified sender — is
 * asserted in `tests/db/verification-gate.test.ts`, beside the code it belongs
 * to. What that file cannot tell you is whether the list is **complete**: it
 * proves three doors are locked and would notice nothing about a fourth.
 *
 * So this is the same shape as `tests/lib/outbound-consent.test.ts`, which is
 * the file this rule was modelled on, and for the same reason. It reads source
 * rather than running anything: the question is not "does this refuse" but
 * "does this ask at all", and an action that never calls the gate cannot refuse
 * anything however carefully the rest of it is written.
 *
 * ## The classification is the rule
 *
 * - **`external`** — makes the product put a message in the inbox of somebody
 *   who is not on the team, at an address the acting user supplied. This is the
 *   whole attack surface of a throwaway signup, and it is gated.
 * - **`internal`** — reaches the team, or reaches nobody. Open, because an
 *   unverified account cannot use it to write to strangers.
 *
 * The line is *who chose the address*, not who receives it. A team invitation
 * is the sharpest case: it goes to somebody the product would call a colleague,
 * but the recipient is free text typed by the sender, so it is external.
 */

/**
 * What can start an external send from a request.
 *
 * Deliberately the **entry points**, not the transports. `outbound-consent`
 * already enumerates everything that reaches a transport; the question here is
 * different — it is about the *actor*, which only exists in a request, and by
 * the time a transport is reached the actor is long gone. That is also why the
 * scheduled path cannot be covered by this list at all, and is asserted
 * separately at the bottom.
 */
const EXTERNAL_SENDS = ["sendReviewRequests(", "runBroadcast(", "auth.api.createInvitation("];

type ServerAction = {
  audience: "external" | "internal";
  why: string;
};

/**
 * Every `src/server` module that starts an external send, and why it is on the
 * list. A module that starts none is simply absent — the enumeration below
 * derives the list from disk and compares it to these keys.
 */
const SEND_ACTIONS: Record<string, ServerAction> = {
  "campaigns.ts": {
    audience: "external",
    why:
      "Review requests (P1b-T1). The recipients are pasted or imported text — " +
      "addresses that may belong to people we have never heard of — which makes " +
      "this the cheapest way to use the product as a spam cannon.",
  },
  "broadcasts.ts": {
    audience: "external",
    why:
      "Broadcasts (P4-T4). Hundreds of contacts at once. Gated at the button " +
      "here and again inside the pipeline, because a scheduled send outlives " +
      "the session that authorised it.",
  },
  "invitations.ts": {
    audience: "external",
    why:
      "Team invitations (W1.9). The least obvious member of the list and the " +
      "one most worth gating: the recipient is free text and the message carries " +
      "the business's name to somebody who has never heard of it.",
  },
};

const read = (file: string) => readFileSync(join("src/server", file), "utf8");

const serverModules = () =>
  readdirSync("src/server")
    .filter((file) => file.endsWith(".ts"))
    .sort();

/**
 * Every `"use client"` module under `src/`.
 *
 * Shared by the organization-creation guard below: the mistake it catches is a
 * *browser* reaching a privileged operation, so a server module doing the same
 * thing is not the same bug.
 */
function clientComponents(): { path: string; source: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
    });

  return walk("src")
    .map((path) => ({ path, source: readFileSync(path, "utf8") }))
    .filter(({ source }) => source.includes('"use client"'));
}

describe("the external-send surface", () => {
  it("is exactly the actions enumerated here, so a new one cannot arrive unexamined", () => {
    const starting = serverModules()
      .filter((file) => EXTERNAL_SENDS.some((call) => read(file).includes(call)))
      .sort();

    expect(starting).toEqual(Object.keys(SEND_ACTIONS).sort());
  });

  it("says who each one reaches, and why", () => {
    // Not decoration. `internal` would be the only reason to skip the gate, so
    // the classification *is* the argument — and writing it down is what stops
    // an external path being quietly filed there later.
    for (const [file, action] of Object.entries(SEND_ACTIONS)) {
      expect(["external", "internal"], file).toContain(action.audience);
      expect(action.why.length, `${file} has no reasoning`).toBeGreaterThan(40);
    }
  });
});

describe("the sender is verified before the product writes to a stranger", () => {
  it("calls the gate in every external action", () => {
    for (const [file, action] of Object.entries(SEND_ACTIONS)) {
      if (action.audience !== "external") continue;

      expect(read(file), `${file} starts an external send and never asks`).toContain(
        "requireVerifiedSender(",
      );
    }
  });

  it("asks before it does the work, not after", () => {
    /**
     * Ordering, which a "does it call the gate" check cannot see.
     *
     * A verification check placed after the recipients are prepared would still
     * refuse the send — and would leave behind the contacts that preparing them
     * created, for a campaign that never went out. The gate has to come before
     * the first write, and in each of these files that means before the call
     * that does the sending.
     */
    for (const [file, action] of Object.entries(SEND_ACTIONS)) {
      if (action.audience !== "external") continue;

      const source = read(file);
      const gate = source.indexOf("requireVerifiedSender(");
      const send = Math.min(
        ...EXTERNAL_SENDS.map((call) => source.indexOf(call)).filter((index) => index >= 0),
      );

      expect(gate, `${file} asks the gate after it has already sent`).toBeLessThan(send);
    }
  });

  it("re-asks on the scheduled path, where the session is long gone", () => {
    /**
     * The rule CLAUDE.md states as "anything with a delay between the decision
     * and the act needs the entitlement asked twice", applied to verification.
     *
     * `sendBroadcastAction` refuses the person at the button. It cannot refuse
     * a broadcast queued on Monday and fired by the sweep on Friday — there is
     * no actor in that process at all — so the pipeline reads the *creator's*
     * verification at send time, next to where it re-reads the plan.
     *
     * Not in the enumeration above because it is not a server action and has no
     * request behind it, which is exactly what makes it the easy one to forget.
     */
    const pipeline = readFileSync("src/broadcasts/pipeline.ts", "utf8");
    expect(pipeline).toContain("senderVerification(");
    expect(pipeline).toContain("createdByUserId");
  });

  it("keeps the rule in one module, with no second opinion about it", () => {
    /**
     * The failure this guards against is not a missing call but a *rival*
     * answer: a screen or an action that reads `emailVerified` itself and
     * decides what it means. That is how a product ends up with one surface
     * refusing and another waving the same account through.
     *
     * `src/auth/verification.ts` is the only module allowed to read the column.
     * The app shell asks it (`senderVerification`) to decide whether to draw the
     * banner, which is a *rendering* decision derived from the one answer, not
     * a second one.
     */
    const readers = serverModules().filter((file) => read(file).includes("emailVerified"));

    expect(readers).toEqual([]);
  });
});

/**
 * **Organization creation goes through the plan** (11 Aug 2026).
 *
 * Here rather than in a file of its own because it is the same *shape* of rule
 * as the one above and guards the same class of mistake: a screen reaching a
 * privileged operation directly, with the server layer that should have had an
 * opinion nowhere on the path.
 *
 * The original bug was not a missing check but a missing *seam*.
 * `CreateOrganizationForm` called BetterAuth's `organization.create` straight
 * from the browser, so there was no server action for anyone to add a check to.
 * The fix is the seam; this keeps it.
 */
describe("creating a workspace asks the plan", () => {
  it("has no client component calling organization.create directly", () => {
    /**
     * The regression this exists to catch, exactly as it happened. A
     * `"use client"` module reaching `organization.create` has bypassed the
     * entitlement layer completely — and since every new organization is granted
     * its own 14-day top-tier trial, that is unbounded free trials on one
     * account.
     *
     * `setActive` is deliberately *not* covered: it writes the session cookie,
     * which is the browser's, and grants nothing.
     */
    const offenders = clientComponents()
      .filter(({ source }) => /\borganization\.create\s*\(/.test(source))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it("checks the allowance before it creates, not after", () => {
    const source = readFileSync("src/server/organizations.ts", "utf8");

    const check = source.indexOf("organizationAllowance(");
    const create = source.indexOf("auth.api.createOrganization(");

    expect(check, "the action must ask the allowance at all").toBeGreaterThanOrEqual(0);
    expect(create, "the action must be the thing that creates").toBeGreaterThanOrEqual(0);
    expect(check, "asking after creating is not a check").toBeLessThan(create);
  });

  it("keeps the per-user limit out of the per-organization resolver", () => {
    /**
     * `withinLimit` has no way to answer this key — no resource counter, so it
     * would read `usage_counters`, find nothing and return 0 forever. The guard
     * that makes that loud lives in `entitlements.ts`, and a refactor that
     * removed it would restore a silently-passing check.
     */
    expect(readFileSync("src/lib/entitlements.ts", "utf8")).toContain(
      'metric === "max_organizations"',
    );
  });
});
