import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * Measuring analysis quality (P1a-T3).
 *
 * The Definition of Done asks for "comparable TR and EN quality", which is a
 * claim, and claims about a model need a number behind them. This module holds
 * the scoring; ../../scripts/ai-eval.mts runs it against a provider.
 *
 * Scoring lives here rather than in the script so it can be unit-tested with
 * synthetic predictions — a metric that is only ever exercised by a paid API
 * call is a metric nobody re-checks after the first time.
 *
 * Two choices worth defending:
 *
 *   - **Macro-F1 alongside accuracy.** The set is close to balanced, but the
 *     real corpus is not: reviews skew positive. A model that learned to answer
 *     "positive" would score respectably on accuracy and terribly on macro-F1,
 *     and it is macro-F1 that predicts whether the digest surfaces complaints.
 *   - **Themes are scored by recognition, not exact match.** The model picks its own
 *     wording; "slow service" and "wait time" are the same finding. Grading on
 *     vocabulary would measure agreement with whoever wrote the fixture.
 */

export const SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type EvalSentiment = (typeof SENTIMENTS)[number];

const evalCaseSchema = z.object({
  id: z.string(),
  language: z.string(),
  text: z.string(),
  rating: z.number().nullable(),
  sentiment: z.enum(SENTIMENTS),
  hard: z.boolean().optional(),
  themes: z.array(z.string()),
});

const evalFileSchema = z.object({ reviews: z.array(evalCaseSchema).min(1) }).loose();

export type EvalCase = z.infer<typeof evalCaseSchema>;

export type Prediction = {
  sentiment: EvalSentiment;
  language: string;
  topics: string[];
};

/**
 * The bar this has to clear.
 *
 * Set from what the task needs rather than from what a model happens to score:
 * a weekly digest that miscategorises one review in six is still useful; one
 * that miscategorises one in three is not, because an owner who finds two wrong
 * items in a ten-item digest stops trusting the whole thing.
 *
 * `maxLanguageGap` is the "comparable TR and EN" requirement made checkable —
 * a model can be excellent in English and mediocre in Turkish, and averaging
 * the two would hide exactly the failure the launch market cares about.
 */
export const THRESHOLDS = {
  sentimentAccuracy: 0.85,
  macroF1: 0.8,
  languageAccuracy: 0.95,
  themeHitRate: 0.7,
  maxLanguageGap: 0.1,
} as const;

export type ClassMetrics = {
  precision: number;
  recall: number;
  f1: number;
  support: number;
};

export type Metrics = {
  count: number;
  sentimentAccuracy: number;
  macroF1: number;
  languageAccuracy: number;
  themeHitRate: number;
  hardAccuracy: number | null;
  easyAccuracy: number | null;
  perClass: Record<EvalSentiment, ClassMetrics>;
  /** confusion[expected][predicted] */
  confusion: Record<EvalSentiment, Record<EvalSentiment, number>>;
};

export type Scored = {
  case: EvalCase;
  prediction: Prediction;
  sentimentCorrect: boolean;
  languageCorrect: boolean;
  /** 1 when at least one expected theme is reflected in the topics, else 0. */
  themeHitRate: number;
};

/** Reads and validates the labelled set. */
export async function loadEvalSet(path: string): Promise<EvalCase[]> {
  const parsed = evalFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  return parsed.reviews;
}

/**
 * Whether the model found any of the themes we expected.
 *
 * Substring matching in both directions, because the model may be broader
 * ("service quality" for "service") or narrower ("cold soup" for "food"), and
 * both are correct comprehension. Turkish lower-casing is explicit — a default
 * `toLowerCase()` turns "İLGİLİ" into "i̇lgili" and the match silently fails.
 */
export function scoreThemes(expected: string[], predicted: string[]): number {
  if (expected.length === 0) return 1;

  const topics = predicted.map((topic) => topic.toLocaleLowerCase("tr").trim());

  const found = expected.filter((theme) => {
    const needle = theme.toLocaleLowerCase("tr").trim();
    return topics.some((topic) => topic.includes(needle) || needle.includes(topic));
  });

  // Any-of, not all-of: the fixture lists plausible themes for a review, and a
  // model that names one of them correctly understood the review. Requiring all
  // would penalise a concise, accurate answer.
  return found.length > 0 ? 1 : 0;
}

/** "tr-TR" and "TR" both count as "tr". */
function baseLanguage(language: string): string {
  return language.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

export function scoreCase(item: EvalCase, prediction: Prediction): Scored {
  return {
    case: item,
    prediction,
    sentimentCorrect: prediction.sentiment === item.sentiment,
    languageCorrect: baseLanguage(prediction.language) === baseLanguage(item.language),
    themeHitRate: scoreThemes(item.themes, prediction.topics),
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function computeMetrics(scored: Scored[]): Metrics {
  const emptyRow = (): Record<EvalSentiment, number> => ({
    positive: 0,
    neutral: 0,
    negative: 0,
  });

  const confusion: Record<EvalSentiment, Record<EvalSentiment, number>> = {
    positive: emptyRow(),
    neutral: emptyRow(),
    negative: emptyRow(),
  };

  for (const row of scored) {
    confusion[row.case.sentiment][row.prediction.sentiment] += 1;
  }

  const perClass = {} as Record<EvalSentiment, ClassMetrics>;

  for (const label of SENTIMENTS) {
    const truePositive = confusion[label][label];
    const support = SENTIMENTS.reduce((sum, predicted) => sum + confusion[label][predicted], 0);
    const predictedTotal = SENTIMENTS.reduce(
      (sum, expected) => sum + confusion[expected][label],
      0,
    );

    // A class the model never predicted has undefined precision; scoring it 0
    // is the honest reading — the model cannot find that class at all.
    const precision = predictedTotal === 0 ? 0 : truePositive / predictedTotal;
    const recall = support === 0 ? 0 : truePositive / support;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    perClass[label] = { precision, recall, f1, support };
  }

  const hard = scored.filter((row) => row.case.hard);
  const easy = scored.filter((row) => !row.case.hard);

  return {
    count: scored.length,
    sentimentAccuracy: mean(scored.map((row) => (row.sentimentCorrect ? 1 : 0))),
    // Macro, not weighted: every sentiment class counts the same regardless of
    // how many examples it has. See the module note.
    macroF1: mean(SENTIMENTS.map((label) => perClass[label].f1)),
    languageAccuracy: mean(scored.map((row) => (row.languageCorrect ? 1 : 0))),
    themeHitRate: mean(scored.map((row) => row.themeHitRate)),
    hardAccuracy: hard.length ? mean(hard.map((row) => (row.sentimentCorrect ? 1 : 0))) : null,
    easyAccuracy: easy.length ? mean(easy.map((row) => (row.sentimentCorrect ? 1 : 0))) : null,
    perClass,
    confusion,
  };
}

export type Report = {
  overall: Metrics;
  byLanguage: Record<string, Metrics>;
  failures: Scored[];
  passed: boolean;
  violations: string[];
};

/** Metrics overall and per language, plus a pass/fail against THRESHOLDS. */
export function buildReport(scored: Scored[]): Report {
  const languages = [...new Set(scored.map((row) => baseLanguage(row.case.language)))].sort();

  const byLanguage: Record<string, Metrics> = {};
  for (const language of languages) {
    byLanguage[language] = computeMetrics(
      scored.filter((row) => baseLanguage(row.case.language) === language),
    );
  }

  const overall = computeMetrics(scored);
  const violations: string[] = [];

  const check = (label: string, actual: number, floor: number) => {
    if (actual < floor) {
      violations.push(`${label} ${(actual * 100).toFixed(1)}% < ${(floor * 100).toFixed(0)}%`);
    }
  };

  // Per language, not just overall — an average hides a weak Turkish half,
  // which is precisely the failure the launch market would feel first.
  for (const language of languages) {
    const metrics = byLanguage[language];
    if (!metrics) continue;

    check(
      `${language} sentiment accuracy`,
      metrics.sentimentAccuracy,
      THRESHOLDS.sentimentAccuracy,
    );
    check(`${language} macro-F1`, metrics.macroF1, THRESHOLDS.macroF1);
    check(`${language} language detection`, metrics.languageAccuracy, THRESHOLDS.languageAccuracy);
    check(`${language} theme hit rate`, metrics.themeHitRate, THRESHOLDS.themeHitRate);
  }

  const accuracies = languages
    .map((language) => byLanguage[language]?.sentimentAccuracy)
    .filter((value): value is number => value !== undefined);

  if (accuracies.length > 1) {
    const gap = Math.max(...accuracies) - Math.min(...accuracies);
    if (gap > THRESHOLDS.maxLanguageGap) {
      violations.push(
        `cross-language gap ${(gap * 100).toFixed(1)}pp > ` +
          `${(THRESHOLDS.maxLanguageGap * 100).toFixed(0)}pp — quality is not comparable`,
      );
    }
  }

  return {
    overall,
    byLanguage,
    failures: scored.filter((row) => !row.sentimentCorrect || !row.languageCorrect),
    passed: violations.length === 0,
    violations,
  };
}
