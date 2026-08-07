import { describe, expect, it } from "vitest";
import { composeReport } from "@/reports/pipeline";
import type { InsightFact, InsightFacts } from "@/analytics/facts";

/**
 * What the scheduled report *prints*, as opposed to what it computes.
 *
 * The PDF is the surface with the longest gap between writing it and seeing it:
 * it renders only when a schedule fires, it arrives as an attachment, and
 * nobody on the team is a recipient. That is how it kept showing the sentiment
 * figure on the retired −1…1 scale for days after W3.3 replaced it — the
 * *data* had been the positive share for some time, but the formatter was still
 * `number(value, 2)`, left over from when two decimals were the only thing
 * distinguishing one signed score from another. A 72% positive share printed as
 * "72,00", in a bare number, in a column beside "%82".
 *
 * So this file asserts the rendering, not the arithmetic. `trends.test.ts`
 * already covers the maths; nothing covered what a customer reads.
 */

const LOCATION = "11111111-1111-4111-8111-111111111111";

function fact(over: Partial<InsightFact>): InsightFact {
  return {
    id: crypto.randomUUID(),
    locationId: LOCATION,
    source: "google",
    rating: 5,
    createdAt: new Date("2026-07-28T10:00:00Z"),
    sentiment: "positive",
    sentimentScore: 0.8,
    themes: [],
    canonicalThemes: [],
    staff: [],
    repliedAt: new Date("2026-07-28T12:00:00Z"),
    ...over,
  } as InsightFact;
}

/** Seven positive of ten scored — a 70% share, and not a round number of stars. */
const CURRENT: InsightFact[] = [
  ...Array.from({ length: 7 }, () => fact({ sentiment: "positive" })),
  ...Array.from({ length: 3 }, () => fact({ sentiment: "negative", rating: 2 })),
];

const FACTS: InsightFacts = { current: CURRENT, previous: [] } as InsightFacts;

function compose(locale: "en" | "tr") {
  return composeReport(FACTS, {
    locale,
    title: "Kadıköy Kahve",
    period: {
      start: new Date("2026-07-27T00:00:00Z"),
      end: new Date("2026-08-03T00:00:00Z"),
    } as never,
    cadence: "weekly" as never,
    locationName: () => "Kadıköy Şubesi",
    generatedAt: new Date("2026-08-03T09:00:00Z"),
  });
}

describe("the scheduled report's sentiment figure", () => {
  it("prints a share, never the retired −1…1 score", () => {
    for (const locale of ["en", "tr"] as const) {
      const report = compose(locale);
      const tile = report.content.metrics.find((metric) =>
        /sentiment|duygu/i.test(String(metric.label)),
      );

      expect(tile, "the report should carry a sentiment tile").toBeTruthy();

      /*
        A percent sign is the assertion that matters. The retired scale had no
        unit at all — "0,38" — so its absence is what distinguishes the two, and
        it is what a reader needs to tell this cell from the four-point rating
        beside it.
      */
      expect(String(tile!.value)).toMatch(/%/);

      // Seven of ten, so 70% — never "0,7", "0,70" or "70,00".
      expect(String(tile!.value)).not.toMatch(/^0[.,]/);
      expect(String(tile!.value)).not.toMatch(/[.,]00/);
    }
  });

  it("prints it in the same unit as the response rate beside it", () => {
    // The two cells are both shares of reviews. Before this they were a bare
    // two-decimal number and a percentage, which invited reading them as
    // different kinds of quantity.
    const report = compose("en");
    const labels = report.content.metrics.map((metric) => String(metric.label));
    const sentiment = report.content.metrics[labels.findIndex((l) => /sentiment/i.test(l))];
    const replied = report.content.metrics[labels.findIndex((l) => /replied/i.test(l))];

    expect(sentiment?.value).toMatch(/%/);
    expect(replied?.value).toMatch(/%/);
  });
});
