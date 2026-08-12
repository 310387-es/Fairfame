import { and, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { Window, RangeWindow } from "../dashboard/range.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { scoreSurvey, SURVEY_TYPES, type SurveyScore, type SurveyType } from "./scoring.ts";

/**
 * Survey scores, for the Insights workspace (P4-T2).
 *
 * `docs/20` asks that scores "feed insights", and this is that feed. It follows
 * the rules `src/analytics/facts.ts` established in P3-T4 rather than inventing
 * its own:
 *
 *   - **The member's location scope is the filter**, passed in as an explicit
 *     list, and an empty list returns nothing rather than everything.
 *   - **Absence is null, never zero** — and for NPS that is not a stylistic
 *     preference. An NPS of 0 is a real result (as many promoters as
 *     detractors), so a quiet fortnight rendered as 0 would show a business a
 *     score it had not earned.
 *   - The arithmetic lives in `./scoring.ts`, not here, so the number on this
 *     card and the number on the survey's own results page cannot disagree.
 *
 * Both instruments are loaded, because a business may run one, the other, or
 * both, and a card that silently showed only NPS would look empty to somebody
 * measuring CSAT.
 */

export type SurveyInsight = {
  type: SurveyType;
  current: SurveyScore;
  /** The same window, immediately before. Null when there is nothing to compare. */
  previous: SurveyScore | null;
};

async function scoresIn(
  tx: TenantDatabase,
  organizationId: string,
  locationIds: string[],
  window: Window,
): Promise<Map<SurveyType, number[]>> {
  const rows = await tx
    .select({ type: schema.surveys.type, score: schema.surveyResponses.score })
    .from(schema.surveyResponses)
    .innerJoin(schema.surveys, eq(schema.surveys.id, schema.surveyResponses.surveyId))
    .where(
      and(
        eq(schema.surveyResponses.organizationId, organizationId),
        inArray(schema.surveyResponses.locationId, locationIds),
        isNotNull(schema.surveyResponses.answeredAt),
        gte(schema.surveyResponses.answeredAt, window.start),
        // Half-open, so a response on the boundary is counted once across two
        // adjacent windows rather than in both.
        lt(schema.surveyResponses.answeredAt, window.end),
      ),
    );

  const byType = new Map<SurveyType, number[]>();
  for (const row of rows) {
    if (row.score === null) continue;
    const list = byType.get(row.type) ?? [];
    list.push(row.score);
    byType.set(row.type, list);
  }

  return byType;
}

/**
 * One entry per instrument that has *any* answer in either window.
 *
 * An instrument nobody has used is absent rather than present-and-empty: a card
 * offering "CSAT — no responses" to a business that has never created a CSAT
 * survey is noise, while the same line for a business whose CSAT went quiet
 * this month is the finding.
 */
export async function loadSurveyInsights(
  tx: TenantDatabase,
  organizationId: string,
  locationIds: string[],
  window: RangeWindow,
): Promise<SurveyInsight[]> {
  // An empty scope means nothing, never everything — the P3-T4 rule.
  if (locationIds.length === 0) return [];

  const current = await scoresIn(tx, organizationId, locationIds, window);
  // `window.previous` rather than a span computed here: a delta needs both
  // sides measured the same way, and `src/dashboard/range.ts` already owns what
  // "the equal-length window immediately before" means. A second definition is
  // how the survey card and the rating card end up comparing different periods.
  const previous = await scoresIn(tx, organizationId, locationIds, window.previous);

  return SURVEY_TYPES.flatMap((type) => {
    const now = current.get(type) ?? [];
    const before = previous.get(type) ?? [];
    if (now.length === 0 && before.length === 0) return [];

    return [
      {
        type,
        current: scoreSurvey(type, now),
        // Null rather than an empty score, so the UI can tell "they were at 42
        // and we have nothing to compare" from "they were at 42 and now have
        // no responses" — different findings, and only the second is a worry.
        previous: before.length === 0 ? null : scoreSurvey(type, before),
      },
    ];
  });
}
