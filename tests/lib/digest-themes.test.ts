import { describe, expect, it } from "vitest";
import en from "@/i18n/messages/en.json";
import tr from "@/i18n/messages/tr.json";
import { formatChange } from "@/digest/change-text";
import { clusterThemes, type WindowReview } from "@/digest/metrics";
import { THEME_KEYS, THEME_NAMES, themeLabel } from "@/reviews/taxonomy";

/**
 * The canonical taxonomy, in the digest.
 *
 * **W3.2 never reached the Action Digest** — the feature it mattered most for.
 * The clusters built by `clusterThemes` become the theme cards in the briefing,
 * the `theme` on every action, the words in the weekly email and the labels on
 * the public sample page, and all of it read `review_insights.topics`: the
 * free-text tail, in whatever language the customer happened to write.
 *
 * Two consequences, both visible before this suite existed. A business whose
 * customers write in two languages had "bekleme süresi" under one action and
 * "waiting time" under the next — the same complaint, counted twice, competing
 * for the same three slots. And the public marketing page showed a Turkish tag
 * under an English action.
 */

function review(overrides: Partial<WindowReview> = {}): WindowReview {
  return {
    id: crypto.randomUUID(),
    rating: 3,
    text: "Bir yorum.",
    language: "tr",
    postedAt: new Date("2026-07-20T10:00:00Z"),
    sentiment: "negative",
    sentimentScore: -0.5,
    topics: [],
    themes: [],
    embedding: null,
    hasReply: false,
    ...overrides,
  };
}

describe("clustering prefers the canonical vocabulary", () => {
  it("folds one complaint written in two languages into one theme", () => {
    // The defect, exactly: the same problem, phrased by a Turkish customer and
    // an English one. Without canonical themes these are two clusters, and a
    // briefing with three slots spends two of them saying one thing.
    const clusters = clusterThemes([
      review({ topics: ["bekleme süresi"], themes: ["wait_time"] }),
      review({ topics: ["waiting time"], themes: ["wait_time"] }),
      review({ topics: ["bekleme"], themes: ["wait_time"] }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.label).toBe("wait_time");
    expect(clusters[0]?.reviewCount).toBe(3);
  });

  it("needs no embedding to do it", () => {
    // Canonical keys are a closed vocabulary, so stage one's exact-slug pass
    // does all the work and the semantic merge never sees them. That is what
    // lets the pipeline stop paying for vectors on the canonical half.
    const clusters = clusterThemes(
      [review({ topics: ["a"], themes: ["staff"] }), review({ topics: ["b"], themes: ["staff"] })],
      { labelVectors: new Map() },
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.label).toBe("staff");
  });

  it("falls back to the free tags, because the column has no backfill", () => {
    // `review_insights.themes` shipped with no backfill, so most rows on a real
    // account still have none. Requiring canonical would empty the digest for
    // them — the briefing has to keep working while re-analysis catches up.
    const clusters = clusterThemes([
      review({ topics: ["otopark"] }),
      review({ topics: ["otopark"] }),
    ]);

    expect(clusters[0]?.label).toBe("otopark");
    expect(clusters[0]?.reviewCount).toBe(2);
  });

  it("does not mix a review's canonical themes with its own free tags", () => {
    // Per review, not per corpus: a row analysed under the taxonomy contributes
    // its canonical themes and nothing else, or one review would be counted
    // under two names for the same thing.
    const clusters = clusterThemes([review({ topics: ["personel"], themes: ["staff"] })]);

    expect(clusters.map((cluster) => cluster.label)).toEqual(["staff"]);
  });
});

describe("a theme key never reaches a reader as a key", () => {
  it("has a name for every canonical theme, in both languages", () => {
    for (const key of THEME_KEYS) {
      expect(en.themes[key], `en.themes.${key}`).toBeTruthy();
      expect(tr.themes[key], `tr.themes.${key}`).toBeTruthy();
    }
  });

  /**
   * The email carries its own copy of these names and has to, because it is
   * rendered in the background worker from plain data with no request context.
   * A copy is only safe if drift fails — the same argument, and the same shape,
   * as `tests/lib/email-palette.test.ts`.
   */
  it("keeps the email's copy identical to the catalogue the screens read", () => {
    for (const key of THEME_KEYS) {
      expect(THEME_NAMES[key].en, `THEME_NAMES.${key}.en`).toBe(en.themes[key]);
      expect(THEME_NAMES[key].tr, `THEME_NAMES.${key}.tr`).toBe(tr.themes[key]);
    }
  });

  it("carries no key the taxonomy does not define, and misses none", () => {
    expect(Object.keys(THEME_NAMES).sort()).toEqual([...THEME_KEYS].sort());
  });

  it("shows a free tag as the customer wrote it", () => {
    const t = (key: keyof typeof en.themes) => en.themes[key];

    expect(themeLabel("wait_time", t)).toBe(en.themes.wait_time);
    // Not a canonical key, so it is not the taxonomy's to rename.
    expect(themeLabel("bekleme süresi", t)).toBe("bekleme süresi");
  });
});

/**
 * The leak the suites above did not catch, found by looking at the page.
 *
 * Every theme *label* was translated and the briefing still printed
 * `food_quality is up, 2 → 5 reviews` under "What changed" — a different code
 * path, in `formatChange`, reading the same key out of `change.detail`. On the
 * public marketing page, in English, under a heading a prospect reads.
 *
 * `formatChange` now *requires* a labeller rather than defaulting to the raw
 * string, so the compiler names every surface instead of leaving it to whoever
 * remembers. These cases pin the three sentences it can produce.
 */
describe("the change sentences", () => {
  const t = (key: string, values: Record<string, string>) =>
    `${key}:${Object.values(values).join(",")}`;
  const label = (key: string) => (key === "food_quality" ? "Food" : key);

  it("labels a rising theme", () => {
    const text = formatChange(
      {
        kind: "theme",
        direction: 1,
        detail: { status: "rising", label: "food_quality", from: 2, to: 5 },
      },
      t,
      label,
    );

    expect(text).toContain("Food");
    expect(text).not.toContain("food_quality");
  });

  it("labels a falling theme", () => {
    const text = formatChange(
      {
        kind: "theme",
        direction: -1,
        detail: { status: "falling", label: "food_quality", from: 5, to: 2 },
      },
      t,
      label,
    );

    expect(text).not.toContain("food_quality");
  });

  it("labels a theme that is new this week", () => {
    const text = formatChange(
      { kind: "theme", direction: 1, detail: { status: "new", label: "food_quality", count: 3 } },
      t,
      label,
    );

    expect(text).toContain("Food");
    expect(text).not.toContain("food_quality");
  });
});
