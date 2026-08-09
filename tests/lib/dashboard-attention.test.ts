import { describe, expect, it } from "vitest";
import { rankAttention, scoreUrgency, type AttentionRow } from "@/dashboard/attention";
import { composeInsight } from "@/dashboard/insight";
import type { DashboardFacts, ReviewFact } from "@/dashboard/facts";

/**
 * The two widgets that tell someone what to do.
 *
 * Both make a claim stronger than a number does — "this is the one to answer",
 * "this is what people are unhappy about" — so the cases below are the ones
 * where a plausible ranking sends an owner to the wrong review, or the strip
 * announces a trend that is one person's bad morning.
 */

const NOW = new Date("2026-08-03T12:00:00Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1_000);
}

let counter = 0;

function row(overrides: Partial<AttentionRow>): AttentionRow {
  counter += 1;

  return {
    reviewId: `review-${counter}`,
    source: "google",
    itemType: "review",
    rating: null,
    text: "Bir yorum.",
    authorName: null,
    at: hoursAgo(2),
    sentiment: null,
    themes: [],
    locationId: "branch-1",
    url: null,
    drafted: false,
    urgency: 0,
    ...overrides,
  };
}

describe("urgency", () => {
  it("puts one star above two", () => {
    expect(
      scoreUrgency({ rating: 1, sentiment: "negative", at: hoursAgo(48) }, NOW),
    ).toBeGreaterThan(scoreUrgency({ rating: 2, sentiment: "negative", at: hoursAgo(48) }, NOW));
  });

  it("treats an angry comment with no stars as a serious complaint", () => {
    // Every Instagram comment arrives without a rating. Scoring only on stars
    // would hide the angriest voices on the fastest-moving source.
    expect(
      scoreUrgency({ rating: null, sentiment: "negative", at: hoursAgo(2) }, NOW),
    ).toBeGreaterThan(0);
  });

  it("ignores anything that is not a complaint", () => {
    expect(scoreUrgency({ rating: 5, sentiment: "positive", at: hoursAgo(1) }, NOW)).toBe(0);
    expect(scoreUrgency({ rating: 4, sentiment: null, at: hoursAgo(1) }, NOW)).toBe(0);
  });

  it("does not let freshness alone make something urgent", () => {
    // A comment from ten minutes ago with no rating and no analysis yet. The
    // recency bonus must not smuggle it into a queue that means "someone is
    // unhappy" — it means nothing is known about it.
    expect(scoreUrgency({ rating: null, sentiment: null, at: hoursAgo(0.2) }, NOW)).toBe(0);
  });

  it("keeps an old one-star above a fresh three-star", () => {
    // The whole point of the widget: an unanswered furious review from three
    // weeks ago is still an open wound, and today's mild grumble is not.
    const old = scoreUrgency({ rating: 1, sentiment: "negative", at: hoursAgo(21 * 24) }, NOW);
    const fresh = scoreUrgency({ rating: 3, sentiment: "neutral", at: hoursAgo(1) }, NOW);

    expect(old).toBeGreaterThan(fresh);
  });
});

describe("the queue", () => {
  it("drops everything that scores nothing", () => {
    const ranked = rankAttention(
      [row({ rating: 5, sentiment: "positive" }), row({ rating: 1, sentiment: "negative" })],
      NOW,
      4,
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.rating).toBe(1);
  });

  it("returns an empty queue rather than padding it", () => {
    // Nothing waiting is the best possible reading of this card. Filling it
    // with three-star reviews would teach people to ignore it.
    expect(rankAttention([row({ rating: 5, sentiment: "positive" })], NOW, 4)).toEqual([]);
  });

  it("breaks ties by recency", () => {
    const older = row({ rating: 2, sentiment: "negative", at: hoursAgo(50) });
    const newer = row({ rating: 2, sentiment: "negative", at: hoursAgo(49) });

    expect(rankAttention([older, newer], NOW, 4)[0]?.reviewId).toBe(newer.reviewId);
  });

  it("honours the limit", () => {
    const rows = Array.from({ length: 10 }, () => row({ rating: 1, sentiment: "negative" }));

    expect(rankAttention(rows, NOW, 4)).toHaveLength(4);
  });

  it("does not mutate what it was given", () => {
    const rows = [row({ rating: 5 }), row({ rating: 1, sentiment: "negative" })];
    const before = rows.map((entry) => entry.reviewId);

    rankAttention(rows, NOW, 4);

    expect(rows.map((entry) => entry.reviewId)).toEqual(before);
  });
});

/* ------------------------------------------------------------------------ */

let factCounter = 0;

function fact(overrides: Partial<ReviewFact>): ReviewFact {
  factCounter += 1;

  return {
    reviewId: `fact-${factCounter}`,
    at: hoursAgo(4),
    locationId: "branch-1",
    source: "google",
    itemType: "review",
    rating: null,
    sentiment: null,
    sentimentScore: null,
    topics: [],
    themes: [],
    repliedAt: null,
    ...overrides,
  };
}

function facts(current: ReviewFact[], previous: ReviewFact[] = []): DashboardFacts {
  // The ninety-day baseline the reputation score is smoothed toward (W3.3).
  // Both windows together is what a fixture has; a real load reaches further.
  return { current, previous, baseline: [...current, ...previous] };
}

describe("the insight strip", () => {
  it("counts only negative items that nobody answered", () => {
    const insight = composeInsight(
      facts([
        fact({ rating: 1, sentiment: "negative" }),
        fact({ rating: 2, sentiment: "negative", repliedAt: hoursAgo(1) }),
        fact({ rating: 5, sentiment: "positive" }),
      ]),
    );

    // Answered complaints are done, and happy customers are not work.
    expect(insight.waiting).toBe(1);
  });

  /**
   * A22-A3 — the second clause is a subset of the first, in the arithmetic.
   *
   * The strip reads "6 negative reviews are waiting for a reply. 7 of them are
   * about queues." — which is what a real account showed, because the two
   * numbers were counted over different sets: the first over unanswered
   * negatives, the second over *every* negative on the theme. The plan's test
   * for this item is one inequality, and it has to hold for every input rather
   * than for a chosen fixture.
   */
  it("never says more are about a theme than are waiting", () => {
    const insight = composeInsight(
      facts([
        // Three on the theme, and two of them already answered — the exact
        // shape that produced "more of them than there are".
        fact({ sentiment: "negative", themes: ["wait_time"], repliedAt: hoursAgo(2) }),
        fact({ sentiment: "negative", themes: ["wait_time"], repliedAt: hoursAgo(3) }),
        fact({ sentiment: "negative", themes: ["wait_time"] }),
        fact({ sentiment: "negative", themes: ["cleanliness"] }),
        fact({ sentiment: "negative", themes: ["cleanliness"] }),
      ]),
    );

    expect(insight.themeNegatives).toBeLessThanOrEqual(insight.waiting);
    // Not merely capped — the subset is a real count of a real queue.
    expect(insight.theme?.slug).toBe("wait_time");
    expect(insight.themeNegatives).toBe(1);
  });

  it("holds the inequality when the theme is entirely answered", () => {
    // The degenerate case the cap would hide: a theme whose every mention has
    // been dealt with contributes nothing to a sentence about who is waiting.
    const insight = composeInsight(
      facts([
        fact({ sentiment: "negative", themes: ["wait_time"], repliedAt: hoursAgo(2) }),
        fact({ sentiment: "negative", themes: ["wait_time"], repliedAt: hoursAgo(3) }),
        fact({ sentiment: "negative", themes: ["cleanliness"] }),
      ]),
    );

    expect(insight.themeNegatives).toBe(0);
    expect(insight.themeNegatives).toBeLessThanOrEqual(insight.waiting);
  });

  it("does not count a low-rated review nobody has analysed", () => {
    /**
     * The narrowing this item chose, pinned so it is a decision rather than a
     * drift. `waiting` is exactly the queue its own button opens
     * (`?sentiment=negative&reply=unanswered`), and `sentiment` and `rating`
     * are combined with AND in the URL, so "negative *or* one star" could not
     * be linked to. The one-star review with no analysis is the attention
     * queue's job, on the same screen.
     */
    const insight = composeInsight(facts([fact({ rating: 1, sentiment: null })]));

    expect(insight.waiting).toBe(0);
  });

  it("names the negative theme that grew, not the biggest one", () => {
    const insight = composeInsight(
      facts(
        [
          fact({ sentiment: "negative", themes: ["service"] }),
          fact({ sentiment: "negative", themes: ["service"] }),
          fact({ sentiment: "negative", themes: ["service"] }),
          fact({ sentiment: "negative", themes: ["wait_time"] }),
          fact({ sentiment: "negative", themes: ["wait_time"] }),
        ],
        [
          fact({ sentiment: "negative", themes: ["service"] }),
          fact({ sentiment: "negative", themes: ["service"] }),
          fact({ sentiment: "negative", themes: ["service"] }),
        ],
      ),
    );

    // `service` is larger but flat; `wait_time` is new. Reporting the perennial
    // complaint every week is how a strip becomes wallpaper.
    expect(insight.theme?.slug).toBe("wait_time");
    expect(insight.theme?.previous).toBe(0);
  });

  it("will not call a single mention a trend", () => {
    const insight = composeInsight(
      facts([fact({ sentiment: "negative", themes: ["location_access"] })]),
    );

    expect(insight.theme).toBeNull();
  });

  it("ignores themes from positive reviews", () => {
    // "Three people mentioned the coffee" is not something to act on when all
    // three were praising it.
    const insight = composeInsight(
      facts([
        fact({ sentiment: "positive", themes: ["food_quality"] }),
        fact({ sentiment: "positive", themes: ["food_quality"] }),
        fact({ sentiment: "positive", themes: ["food_quality"] }),
      ]),
    );

    expect(insight.theme).toBeNull();
  });

  it("says nothing about a rating it cannot compute", () => {
    const insight = composeInsight(facts([fact({ itemType: "comment", sentiment: "negative" })]));

    expect(insight.rating).toBeNull();
    expect(insight.ratingDelta).toBeNull();
  });

  it("reports the rating and how it moved", () => {
    const insight = composeInsight(
      facts([fact({ rating: 5 }), fact({ rating: 4 })], [fact({ rating: 4 }), fact({ rating: 4 })]),
    );

    expect(insight.rating).toBe(4.5);
    expect(insight.ratingDelta).toBe(0.5);
  });
});
