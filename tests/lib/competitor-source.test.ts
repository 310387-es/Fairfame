import { describe, expect, it } from "vitest";
import { createFixtureSource, createNoSource } from "@/competitors/source";

/**
 * Where competitor figures come from (P3-T6).
 *
 * Every assertion here is about **honesty rather than arithmetic**, because
 * until a real connector lands every number this produces is invented — and a
 * benchmark is exactly the kind of figure a business repeats to a landlord or a
 * supplier.
 *
 * The three properties that matter:
 *   1. A fixture reading says it is a fixture, in the data, not in a comment.
 *   2. `isReal` is false, so no surface can render the table without a notice.
 *   3. The numbers do not move. A figure that changed on every render would
 *      read as live data, which is the single most misleading thing a fixture
 *      can do.
 */

const competitor = (id: string) => ({
  id,
  name: "The café across the street",
  provider: "google",
  externalRef: "ChIJexample",
});

describe("the fixture source", () => {
  it("labels every reading as a fixture", async () => {
    const reading = await createFixtureSource().read(competitor("a"));
    expect(reading?.source).toBe("fixtures");
  });

  it("declares itself unreal, so the UI cannot forget the notice", async () => {
    expect(createFixtureSource().isReal).toBe(false);
  });

  it("returns the same numbers every time, for the same competitor", async () => {
    // Deterministic on purpose. A random rating would move on every page load
    // and read as a live feed.
    const source = createFixtureSource();
    const first = await source.read(competitor("stable-id"));
    const second = await source.read(competitor("stable-id"));

    expect(second?.rating).toBe(first?.rating);
    expect(second?.reviewCount).toBe(first?.reviewCount);
  });

  it("gives different competitors different numbers", async () => {
    const source = createFixtureSource();
    const readings = await Promise.all(
      ["a", "b", "c", "d", "e"].map((id) => source.read(competitor(id))),
    );

    expect(new Set(readings.map((reading) => reading?.rating)).size).toBeGreaterThan(1);
  });

  it("stays inside a plausible range, and is not rigged to flatter", async () => {
    // A fixture that always made the competitor worse would let somebody demo a
    // flattering comparison and call it a feature.
    const source = createFixtureSource();
    const ratings: number[] = [];

    for (let index = 0; index < 40; index += 1) {
      const reading = await source.read(competitor(`c-${index}`));
      ratings.push(reading!.rating!);
      expect(reading!.reviewCount!).toBeGreaterThanOrEqual(40);
      expect(reading!.reviewCount!).toBeLessThan(1_200);
    }

    expect(Math.min(...ratings)).toBeGreaterThanOrEqual(3.4);
    expect(Math.max(...ratings)).toBeLessThanOrEqual(4.8);
    // Both above and below a typical 4.0, so the comparison can go either way.
    expect(ratings.some((rating) => rating > 4.2)).toBe(true);
    expect(ratings.some((rating) => rating < 3.9)).toBe(true);
  });
});

describe("no source configured", () => {
  it("returns nothing rather than something plausible", async () => {
    // The default. A benchmark with no data is one a business can see is not
    // working; a benchmark with numbers from nowhere is one they will quote.
    expect(await createNoSource().read(competitor("a"))).toBeNull();
    expect(createNoSource().isReal).toBe(false);
  });
});
