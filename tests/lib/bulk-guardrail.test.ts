import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The one guardrail the build plan states outright (P2-T6):
 *
 *   > no bulk *auto-post* of public replies without per-item review
 *   > (protects the brand + platform ToS)
 *
 * `tests/db/bulk.test.ts` asserts the behaviour — every reply a bulk action
 * writes comes out as an unapproved, unposted draft. This file asserts the
 * *structure*, because behaviour tests only cover the paths that exist today and
 * the risk here is a path somebody adds tomorrow.
 *
 * A source-reading test is unusual and deliberate. The failure it guards against
 * is not a bug, it is a plausible feature request — "can we auto-post the
 * five-star ones?" — implemented by someone who never read the comment
 * explaining why not. Behavioural tests would all still pass. This one would
 * not, and it names the reason in its own failure message.
 */

/**
 * Comments stripped first: the guard is about what the code does, and the
 * modules below explain the rule in prose that necessarily names the very
 * things being forbidden. Scanning the comments too would make the header
 * "this module does not import postReply" fail a test asserting exactly that.
 *
 * Crude on purpose — a `//` inside a string literal would be stripped as well.
 * Neither file contains one, and a real parser here would be a lot of machinery
 * guarding four `includes` calls.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

const BULK_SOURCE = code("src/reviews/bulk.ts");
const ACTIONS_SOURCE = code("src/server/bulk.ts");

describe("bulk actions cannot publish", () => {
  it("never writes a reply status other than draft", () => {
    const statuses = [...BULK_SOURCE.matchAll(/status:\s*"(\w+)"/g)].map((match) => match[1]);
    const replyStatuses = statuses.filter((status) =>
      ["draft", "approved", "posted", "failed"].includes(status ?? ""),
    );

    expect(replyStatuses.length).toBeGreaterThan(0);
    expect(replyStatuses).toEqual(replyStatuses.map(() => "draft"));
  });

  it("records no approval", () => {
    // An approval is the accountable human signature. A batch cannot give one.
    expect(BULK_SOURCE).not.toContain("approvedAt");
    expect(BULK_SOURCE).not.toContain("approvedByUserId");
  });

  it("cannot reach a platform", () => {
    // No connector, no post call: there is no wire out of this module, so bulk
    // publishing is not something that can be switched on by mistake.
    for (const forbidden of ["connectors/registry", "postReply", "approveReply", "externalId"]) {
      expect(BULK_SOURCE).not.toContain(forbidden);
    }
  });

  it("exposes no bulk post or bulk approve action", () => {
    // The absence is the feature. Publishing stays a per-item decision made in
    // the composer, where a person has read the words in front of them.
    expect(ACTIONS_SOURCE).not.toMatch(/export async function bulk\w*(Post|Approve)\w*Action/);
    expect(ACTIONS_SOURCE).not.toContain("postReply");
    expect(ACTIONS_SOURCE).not.toContain("approveReply");
  });
});
