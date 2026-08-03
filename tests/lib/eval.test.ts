import { describe, expect, it } from "vitest";
import {
  buildReport,
  computeMetrics,
  loadEvalSet,
  scoreCase,
  scoreThemes,
  THRESHOLDS,
  type EvalCase,
  type EvalSentiment,
  type Prediction,
} from "@/ai/eval";

/**
 * The scoring, not the model (P1a-T3).
 *
 * `pnpm ai:eval` makes 40 real API calls and is a deliberate act. This suite
 * feeds the same scorer synthetic predictions, so a metric that quietly stops
 * measuring what it claims fails here rather than during a model evaluation
 * that someone then trusts.
 */

const path = new URL("../fixtures/eval/reviews.json", import.meta.url).pathname;

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "x",
    language: "tr",
    text: "test",
    rating: 3,
    sentiment: "positive",
    themes: ["servis"],
    ...overrides,
  };
}

function makePrediction(overrides: Partial<Prediction> = {}): Prediction {
  return { sentiment: "positive", language: "tr", topics: ["servis"], ...overrides };
}

/** A run where the model answered every case correctly. */
function perfectRun(cases: EvalCase[]) {
  return cases.map((item) =>
    scoreCase(item, {
      sentiment: item.sentiment,
      language: item.language,
      topics: [...item.themes],
    }),
  );
}

describe("the labelled set", () => {
  it("loads and validates", async () => {
    const cases = await loadEvalSet(path);
    expect(cases.length).toBe(40);
  });

  it("has both languages, matched in size", async () => {
    const cases = await loadEvalSet(path);
    const tr = cases.filter((item) => item.language === "tr");
    const en = cases.filter((item) => item.language === "en");

    // Comparing TR against EN quality is only meaningful if the halves are
    // comparable. Different sizes would make the gap check noise.
    expect(tr.length).toBe(en.length);
    expect(tr.length).toBeGreaterThanOrEqual(20);
  });

  it("balances the sentiment classes identically across languages", async () => {
    const cases = await loadEvalSet(path);

    const distribution = (language: string) => {
      const counts: Record<string, number> = { positive: 0, neutral: 0, negative: 0 };
      for (const item of cases.filter((c) => c.language === language)) {
        counts[item.sentiment] = (counts[item.sentiment] ?? 0) + 1;
      }
      return counts;
    };

    // Otherwise a per-language accuracy difference could come from the class
    // mix rather than from the model.
    expect(distribution("tr")).toEqual(distribution("en"));
  });

  it("gives every case a unique id and non-empty text", async () => {
    const cases = await loadEvalSet(path);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    expect(cases.every((item) => item.text.trim().length > 0)).toBe(true);
  });

  it("includes hard cases in both languages", async () => {
    const cases = await loadEvalSet(path);
    // The set is meant to contain sarcasm and faint praise. If a future edit
    // drops them, a passing score stops meaning much.
    expect(cases.some((item) => item.hard && item.language === "tr")).toBe(true);
    expect(cases.some((item) => item.hard && item.language === "en")).toBe(true);
  });
});

describe("theme scoring", () => {
  it("credits a broader topic than the expected theme", () => {
    expect(scoreThemes(["servis"], ["servis kalitesi"])).toBe(1);
  });

  it("credits a narrower topic than the expected theme", () => {
    expect(scoreThemes(["food"], ["foo"])).toBe(1);
  });

  it("does not credit an unrelated topic", () => {
    expect(scoreThemes(["temizlik"], ["fiyat", "manzara"])).toBe(0);
  });

  it("matches Turkish dotted capitals", () => {
    // A plain toLowerCase() maps "İLGİ" to "i̇lgi" (with a combining dot) and
    // the substring match fails. This is the reason for the explicit locale.
    expect(scoreThemes(["ilgi"], ["İLGİ"])).toBe(1);
  });

  it("scores a case with no expected themes as a hit", () => {
    expect(scoreThemes([], ["anything"])).toBe(1);
  });
});

describe("language scoring", () => {
  it("accepts a region-tagged variant", () => {
    const scored = scoreCase(makeCase({ language: "tr" }), makePrediction({ language: "tr-TR" }));
    expect(scored.languageCorrect).toBe(true);
  });

  it("rejects a different language", () => {
    const scored = scoreCase(makeCase({ language: "tr" }), makePrediction({ language: "en" }));
    expect(scored.languageCorrect).toBe(false);
  });
});

describe("metrics", () => {
  it("scores a perfect run at 100%", async () => {
    const metrics = computeMetrics(perfectRun(await loadEvalSet(path)));

    expect(metrics.sentimentAccuracy).toBe(1);
    expect(metrics.macroF1).toBe(1);
    expect(metrics.languageAccuracy).toBe(1);
    expect(metrics.themeHitRate).toBe(1);
  });

  it("punishes a model that always answers positive", async () => {
    const cases = await loadEvalSet(path);
    const scored = cases.map((item) =>
      scoreCase(item, { sentiment: "positive", language: item.language, topics: item.themes }),
    );

    const metrics = computeMetrics(scored);

    // This is the whole reason macro-F1 is reported: accuracy stays
    // respectable-looking while the model is useless for finding complaints.
    expect(metrics.sentimentAccuracy).toBeCloseTo(14 / 40, 5);
    expect(metrics.macroF1).toBeLessThan(0.2);
    expect(metrics.perClass.negative.recall).toBe(0);
    expect(metrics.perClass.negative.f1).toBe(0);
  });

  it("records the confusion matrix in expected-by-predicted order", () => {
    const scored = [
      scoreCase(makeCase({ sentiment: "negative" }), makePrediction({ sentiment: "neutral" })),
      scoreCase(makeCase({ sentiment: "negative" }), makePrediction({ sentiment: "negative" })),
    ];

    const metrics = computeMetrics(scored);

    expect(metrics.confusion.negative.neutral).toBe(1);
    expect(metrics.confusion.negative.negative).toBe(1);
    expect(metrics.confusion.neutral.negative).toBe(0);
  });

  it("separates hard cases from easy ones", () => {
    const scored = [
      scoreCase(makeCase({ hard: true }), makePrediction({ sentiment: "negative" })),
      scoreCase(makeCase({ hard: false }), makePrediction()),
    ];

    const metrics = computeMetrics(scored);

    expect(metrics.hardAccuracy).toBe(0);
    expect(metrics.easyAccuracy).toBe(1);
  });
});

describe("the report", () => {
  it("passes a perfect run", async () => {
    const report = buildReport(perfectRun(await loadEvalSet(path)));

    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
    expect(Object.keys(report.byLanguage).sort()).toEqual(["en", "tr"]);
  });

  it("fails when one language lags, even if the average looks fine", async () => {
    const cases = await loadEvalSet(path);

    // English perfect, Turkish wrong half the time. Overall accuracy is 75%,
    // which some averaged threshold might wave through; the launch market's
    // language being broken is exactly what must not pass.
    const scored = cases.map((item, index) => {
      const wrong: EvalSentiment = item.sentiment === "positive" ? "negative" : "positive";
      const shouldFail = item.language === "tr" && index % 2 === 0;

      return scoreCase(item, {
        sentiment: shouldFail ? wrong : item.sentiment,
        language: item.language,
        topics: item.themes,
      });
    });

    const report = buildReport(scored);

    expect(report.passed).toBe(false);
    expect(report.byLanguage.en?.sentimentAccuracy).toBe(1);
    expect(report.violations.some((v) => v.startsWith("tr "))).toBe(true);
    expect(report.violations.some((v) => v.includes("not comparable"))).toBe(true);
  });

  it("flags a cross-language gap on its own", async () => {
    const cases = await loadEvalSet(path);

    // Both halves clear the absolute thresholds; only the gap between them
    // fails. Without maxLanguageGap this run would be reported as passing.
    let trMisses = 0;
    const scored = cases.map((item) => {
      const missable = item.language === "tr" && trMisses < 3;
      if (missable) trMisses += 1;

      return scoreCase(item, {
        sentiment: missable
          ? item.sentiment === "positive"
            ? "negative"
            : "positive"
          : item.sentiment,
        language: item.language,
        topics: item.themes,
      });
    });

    const report = buildReport(scored);
    const tr = report.byLanguage.tr;

    expect(tr?.sentimentAccuracy).toBeGreaterThanOrEqual(THRESHOLDS.sentimentAccuracy);
    expect(report.violations.some((v) => v.includes("not comparable"))).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("lists misclassified cases so a failure can be inspected", () => {
    const scored = [
      scoreCase(makeCase({ id: "a" }), makePrediction({ sentiment: "negative" })),
      scoreCase(makeCase({ id: "b" }), makePrediction()),
    ];

    const report = buildReport(scored);

    expect(report.failures.map((row) => row.case.id)).toEqual(["a"]);
  });
});
