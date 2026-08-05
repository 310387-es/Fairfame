import type { InsightFact } from "./facts.ts";
import type { RangeWindow } from "../dashboard/range.ts";
import { toCsv, type CsvRow } from "./csv.ts";
import { compareBy, staffMentions, themeTrends, type GroupComparison } from "./trends.ts";

/**
 * What the Insights page exports (P3-T4).
 *
 * The rows are built from the **same functions the page renders from**, not
 * from a second set of queries. An export that disagreed with the screen it was
 * taken from is worse than no export: the whole reason to download this is to
 * put it beside something we do not have, and a number that does not match what
 * the business just read makes both untrustworthy.
 *
 * Everything is left as raw numbers — no locale formatting, no thousands
 * separators, no percent signs. A spreadsheet cannot do arithmetic on "4,6" or
 * on "82%", and arithmetic is what this file is for. Formatting belongs to the
 * page, which has a locale; a CSV does not.
 */

export const EXPORT_KINDS = ["everything", "themes", "locations", "sources", "staff"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export function isExportKind(value: string): value is ExportKind {
  return (EXPORT_KINDS as readonly string[]).includes(value);
}

/** Group rows flattened the same way for locations and sources. */
function groupRows(groups: GroupComparison[], label: (key: string) => string, keyColumn: string) {
  return groups.map<CsvRow>((group) => ({
    [keyColumn]: label(group.key),
    rating: group.rating.value,
    rating_previous: group.rating.previous,
    rating_change: group.rating.delta,
    sentiment: group.sentiment.value,
    sentiment_previous: group.sentiment.previous,
    volume: group.volume.value,
    volume_previous: group.volume.previous,
    // 0–1 rather than a percentage, so a spreadsheet can format it as one.
    replied_share: group.responseRate.value,
  }));
}

/**
 * Everything on the page, as one **long** table.
 *
 * Not four tables stacked with blank lines between them — that is not a valid
 * CSV, and every tool that opens it guesses differently. One row per
 * measurement with a `section` column is a shape a spreadsheet can pivot, which
 * is the whole reason somebody exports rather than reads the screen.
 *
 * The trade is that a long table is worse to *read* than a wide one, which is
 * why the four per-section files still exist. This one is for the person who
 * wants all of it in a pivot.
 */
function everything(
  facts: { current: InsightFact[]; previous: InsightFact[] },
  window: RangeWindow,
  locationName: (id: string) => string,
): CsvRow[] {
  const rows: CsvRow[] = [];

  const measures = (section: string, key: string, group: GroupComparison) => {
    for (const [metric, comparison] of [
      ["rating", group.rating],
      ["sentiment", group.sentiment],
      ["volume", group.volume],
      ["replied_share", group.responseRate],
    ] as const) {
      rows.push({
        section,
        row: key,
        metric,
        value: comparison.value,
        previous: comparison.previous,
        change: comparison.delta,
      });
    }
  };

  for (const group of compareBy(facts.current, facts.previous, (fact) => fact.locationId)) {
    measures("location", locationName(group.key), group);
  }
  for (const group of compareBy(facts.current, facts.previous, (fact) => fact.source)) {
    measures("source", group.key, group);
  }

  for (const theme of themeTrends(facts.current, facts.previous, window, Number.MAX_SAFE_INTEGER)) {
    rows.push({
      section: "theme",
      row: theme.theme,
      metric: "mentions",
      value: theme.count,
      previous: theme.previousCount,
      change: theme.delta,
    });
  }

  for (const person of staffMentions(facts.current, Number.MAX_SAFE_INTEGER).people) {
    rows.push({
      section: "staff",
      row: person.name,
      metric: "mentions",
      value: person.count,
      // A person has no previous-window comparison: names are extracted per
      // review, and a blank is the honest answer rather than a zero.
      previous: null,
      change: null,
    });
  }

  return rows;
}

export function buildExport(
  kind: ExportKind,
  facts: { current: InsightFact[]; previous: InsightFact[] },
  window: RangeWindow,
  locationName: (id: string) => string,
): string {
  switch (kind) {
    case "everything":
      return toCsv(everything(facts, window, locationName));

    case "themes": {
      // No limit, unlike the page: a screen shows the eight that moved, a
      // spreadsheet is where somebody goes looking for the ninth.
      const themes = themeTrends(facts.current, facts.previous, window, Number.MAX_SAFE_INTEGER);

      return toCsv(
        themes.map((theme) => ({
          theme: theme.theme,
          mentions: theme.count,
          mentions_previous: theme.previousCount,
          change_percent: theme.delta,
          positive: theme.positive,
          neutral: theme.neutral,
          negative: theme.negative,
        })),
      );
    }

    case "locations":
      return toCsv(
        groupRows(
          compareBy(facts.current, facts.previous, (fact) => fact.locationId),
          locationName,
          "location",
        ),
      );

    case "sources":
      return toCsv(
        groupRows(
          compareBy(facts.current, facts.previous, (fact) => fact.source),
          (key) => key,
          "source",
        ),
      );

    case "staff": {
      const summary = staffMentions(facts.current, Number.MAX_SAFE_INTEGER);

      return toCsv(
        summary.people.map((person) => ({
          name: person.name,
          mentions: person.count,
          positive: person.positive,
          neutral: person.neutral,
          negative: person.negative,
          average_rating: person.rating,
        })),
      );
    }
  }
}
