import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_CONTACT_FILTERS, contactFiltersToRecord } from "@/contacts/filters";
import { resolveDestination, type RoutableCampaign } from "@/collect/routing";
import { surveyReviewInvite } from "@/surveys/outcome";

/**
 * **No review-gating, product-wide** (P4-T7, `docs/20` §Compliance).
 *
 * The prohibited pattern has two halves, and the product has to be clean of
 * both:
 *
 *   1. **Gating** — asking how happy somebody is and then sending the happy
 *      ones to Google while the unhappy ones get a private complaints box.
 *   2. **Selective solicitation** — not asking the unhappy ones in the first
 *      place. Google's policy forbids this in the same breath, and it is the
 *      half a *broadcast* makes newly possible: an audience is a query, and a
 *      query that could say "rated us four or more" would be the same dark
 *      pattern with a database in front of it.
 *
 * The per-module behaviour is asserted where it lives — `tests/lib/collect.test.ts`
 * for review requests, `tests/lib/survey-gating.test.ts` for surveys, which is
 * the case where a score exists at the moment the destination is shown. What
 * neither can tell you is whether the list of places that hand somebody a
 * public-review link is still complete. This file enumerates them from disk and
 * fails when a new one appears, so the next surface that invites a review
 * cannot arrive without this question being asked about it.
 */

/** Every module that turns a campaign into somewhere a customer is sent. */
const DESTINATION_CALLERS = [
  "app/c/[slug]/page.tsx",
  "app/r/[token]/route.ts",
  "surveys/outcome.ts",
] as const;

/** Every module that decides *who* is asked for a review. */
const AUDIENCE_MODULES = [
  "contacts/filters.ts",
  "contacts/queries.ts",
  "broadcasts/audience.ts",
  "broadcasts/pipeline.ts",
] as const;

function sourceFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, `${prefix}${entry.name}/`);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
      ? [`${prefix}${entry.name}`]
      : [];
  });
}

const read = (file: string) => readFileSync(join("src", file), "utf8");

describe("everywhere a customer is handed a review destination", () => {
  it("is exactly the callers listed here, so a new one cannot arrive unexamined", () => {
    const callers = sourceFiles("src")
      .filter((file) => file !== "collect/routing.ts")
      .filter((file) => read(file).includes("resolveDestination("))
      .sort();

    expect(callers).toEqual([...DESTINATION_CALLERS].sort());
  });

  it("passes a campaign and a base URL, and has nothing else to pass", () => {
    /**
     * `resolveDestination(campaign, baseUrl)` — two arguments, neither of which
     * is a score. Asserted at each call site rather than only on the signature,
     * because the signature could grow an optional third parameter and every
     * existing call would still compile.
     */
    const CALL = /resolveDestination\(\s*[A-Za-z_$][\w.$]*\s*,\s*(publicBaseUrl\(\)|baseUrl)\s*\)/;

    for (const file of DESTINATION_CALLERS) {
      expect(read(file), `${file} calls resolveDestination with something else`).toMatch(CALL);
    }
  });

  it("routes from a campaign shape with nowhere to put a rating", () => {
    // The structural guarantee, on the two input types that reach the router.
    // Gating would mean widening one of them, which is an edit a reviewer sees.
    const routing = read("collect/routing.ts");
    const campaignType = routing.slice(
      routing.indexOf("export type RoutableCampaign = {"),
      routing.indexOf("export function resolveDestination"),
    );

    const outcome = read("surveys/outcome.ts");
    const surveyType = outcome.slice(
      outcome.indexOf("export type InvitableSurvey"),
      outcome.indexOf("export function surveyReviewInvite"),
    );

    for (const [name, block] of [
      ["RoutableCampaign", campaignType],
      ["InvitableSurvey", surveyType],
    ] as const) {
      for (const forbidden of ["rating", "score", "sentiment", "band"]) {
        expect(block, `${name} can see a ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("gives the same answer whatever anybody thought of the place", () => {
    // The behavioural half, stated once at the top level: the two callers that
    // *could* know a score — the survey outcome, and the collect page that
    // renders a rating widget — resolve the same campaign to the same URL.
    const campaign: RoutableCampaign = {
      slug: "kadikoy-kahve-h7m2qp",
      destination: "external",
      destinationUrl: "https://maps.example/place/kadikoy",
    };

    expect(surveyReviewInvite({ reviewCampaign: campaign }, "https://fairfame.test")).toEqual(
      resolveDestination(campaign, "https://fairfame.test"),
    );
  });
});

describe("everywhere an audience is chosen", () => {
  it("offers no way to ask only the customers who were happy", () => {
    /**
     * Selective solicitation, guarded at the one place it could enter: the
     * contact filter shape, which is also the segment format and therefore also
     * a broadcast's audience. Asserted on the real object rather than on source,
     * so a field added in any of the four spellings the filter has (the state,
     * the URL parameter, the parser, the SQL) shows up here.
     */
    const keys = Object.keys(EMPTY_CONTACT_FILTERS);

    // Every field set, so the stored form of a segment names every parameter
    // this product knows how to filter on — an empty state writes nothing and
    // would make the second assertion pass by having nothing in it.
    const stored = Object.keys(
      contactFiltersToRecord({
        query: "ayşe",
        tags: ["vip"],
        subscription: "subscribed",
        channel: "email",
        consent: "email",
        locationId: "3f1b0c8e-5a1d-4f6b-9c2e-7d8a0b1c2d3e",
        from: "2026-01-01",
        to: "2026-08-05",
        sort: "name",
      }),
    );
    expect(stored.length).toBe(keys.length);

    for (const forbidden of ["rating", "score", "sentiment", "stars", "nps", "csat"]) {
      expect(keys.join(" "), `a contact can be filtered by ${forbidden}`).not.toContain(forbidden);
      expect(stored.join(" "), `a saved segment carries ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("builds a send list out of modules that never mention a rating", () => {
    // The same claim one level down, where a raw SQL predicate could reach
    // `reviews.rating` without ever surfacing as a filter field. A contact's
    // *profile* shows their ratings (`contacts/timeline.ts`) — reading a rating
    // is fine, targeting on one is not, so only the audience path is swept.
    for (const file of AUDIENCE_MODULES) {
      const source = read(file);
      for (const forbidden of ["rating", "sentiment"]) {
        expect(source, `${file} targets on ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
