import { and, avg, count, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { getEnv } from "../lib/env.ts";
import { childLogger } from "../lib/logger.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import {
  createFixtureSource,
  createNoSource,
  type CompetitorReading,
  type CompetitorRef,
  type CompetitorSource,
} from "./source.ts";

/**
 * Us against them (P3-T6).
 *
 * The comparison itself is trivial arithmetic. What this module is really for
 * is making sure the two halves are **comparable and labelled**, because the
 * ways a benchmark lies are all about the second:
 *
 *   - A competitor's listing shows a **lifetime** rating and a **lifetime**
 *     review count. Our side of the table must therefore be lifetime too — a
 *     30-day average against their all-time one is not a comparison, and it is
 *     the mistake that makes a business think they have overtaken somebody.
 *     The Insights range deliberately does not apply here, and the copy says so.
 *   - A figure from a fixture must never be presentable as measured. Every row
 *     carries the source that produced it, and `unverified` is true unless
 *     every reading came from a real adapter.
 */

const log = childLogger({ module: "competitors/benchmark" });

let source: CompetitorSource | null = null;

/**
 * Chooses the adapter from the environment, once.
 *
 * `fixtures` in development so the framework can be built and seen; `none`
 * everywhere else until a real adapter exists, so a production deployment
 * cannot quietly serve invented numbers.
 */
export function getCompetitorSource(): CompetitorSource {
  if (source) return source;

  const configured = getEnv().COMPETITOR_SOURCE;
  source = configured === "fixtures" ? createFixtureSource() : createNoSource();

  if (source.name === "fixtures") {
    log.warn(
      "COMPETITOR_SOURCE=fixtures — competitor figures are invented and every surface that " +
        "shows them says so. A real adapter arrives with the connectors at go-live.",
    );
  }

  return source;
}

/** Test seam. Production never calls this. */
export function setCompetitorSource(next: CompetitorSource | null): void {
  source = next;
}

export type BenchmarkRow = {
  competitorId: string;
  name: string;
  provider: string;
  /** Their lifetime figures, or nulls when the source could not read them. */
  theirRating: number | null;
  theirReviews: number | null;
  /** Which adapter produced their figures. `"fixtures"` is never real. */
  source: string;
  /** Positive when we are ahead. Null unless both sides have a rating. */
  ratingGap: number | null;
};

export type Benchmark = {
  /** Our lifetime rating for the same scope, on the same basis as theirs. */
  ourRating: number | null;
  ourReviews: number;
  rows: BenchmarkRow[];
  /**
   * True when any figure on the table came from something other than a real
   * listing. The UI must not render the table without saying so.
   */
  unverified: boolean;
  /** The adapter in force, for the notice. */
  sourceName: string;
};

/**
 * Our side of the comparison: **lifetime**, not the selected range.
 *
 * Deliberately its own query rather than the Insights facts, which are windowed
 * — see the module header. A DM is excluded for the same reason it is excluded
 * everywhere public: private correspondence is not part of a reputation anyone
 * can look up.
 */
async function ourFigures(
  tx: TenantDatabase,
  organizationId: string,
  locationIds: string[],
): Promise<{ rating: number | null; reviews: number }> {
  if (locationIds.length === 0) return { rating: null, reviews: 0 };

  const [row] = await tx
    .select({ average: avg(schema.reviews.rating), total: count() })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        inArray(schema.reviews.locationId, locationIds),
        ne(schema.reviews.itemType, "dm"),
        isNotNull(schema.reviews.rating),
      ),
    );

  const average = row?.average == null ? null : Number(row.average);

  return {
    rating: average === null || Number.isNaN(average) ? null : Math.round(average * 100) / 100,
    reviews: row?.total ?? 0,
  };
}

/**
 * The benchmark for a scope.
 *
 * Readings are fetched per competitor and **nothing is written back** — see
 * `source.ts`. A competitor whose reading fails is still listed, with nulls: a
 * row that vanished would look like a competitor that was removed.
 */
export async function loadBenchmark(
  tx: TenantDatabase,
  organizationId: string,
  locationIds: string[],
): Promise<Benchmark> {
  const adapter = getCompetitorSource();

  const competitors = await tx
    .select({
      id: schema.competitors.id,
      name: schema.competitors.name,
      provider: schema.competitors.provider,
      externalRef: schema.competitors.externalRef,
    })
    .from(schema.competitors)
    .where(
      and(
        eq(schema.competitors.organizationId, organizationId),
        eq(schema.competitors.enabled, true),
      ),
    )
    .orderBy(sql`lower(${schema.competitors.name})`);

  const ours = await ourFigures(tx, organizationId, locationIds);

  const readings = await Promise.all(
    competitors.map(async (competitor): Promise<[CompetitorRef, CompetitorReading | null]> => [
      competitor,
      await adapter.read(competitor),
    ]),
  );

  const rows = readings.map(([competitor, reading]) => ({
    competitorId: competitor.id,
    name: competitor.name,
    provider: competitor.provider,
    theirRating: reading?.rating ?? null,
    theirReviews: reading?.reviewCount ?? null,
    source: reading?.source ?? adapter.name,
    ratingGap:
      ours.rating !== null && reading?.rating != null
        ? Math.round((ours.rating - reading.rating) * 100) / 100
        : null,
  }));

  return {
    ourRating: ours.rating,
    ourReviews: ours.reviews,
    rows,
    // Unverified unless the adapter reads real listings. Stated as a property
    // of the data, not inferred by the UI from the source's name.
    unverified: !adapter.isReal,
    sourceName: adapter.name,
  };
}
