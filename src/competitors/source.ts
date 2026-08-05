import { createHash } from "node:crypto";

/**
 * Where a competitor's public numbers come from (P3-T6).
 *
 * **The seam, and the whole point of the task.** `docs/19` asks for the
 * framework now and live data at go-live, so this is written as one interface
 * with a fixture implementation behind it — the same shape as the İYS gateway
 * in `src/compliance/iys-gateway.ts`, and for the same reason: the thing that
 * cannot be built yet should be one swap, not a rewrite.
 *
 * Three rules, all of which exist because the numbers are currently invented:
 *
 *   1. **Every reading says where it came from.** `source` is on the type, not
 *      in a config file, so nothing downstream can render a figure without
 *      being able to say whether it is real. `iys_uploaded_via` is in this
 *      codebase for the same lesson.
 *   2. **Nothing is written to the database.** Readings are fetched when the
 *      page is rendered and discarded. Invented rows outlive the flag that
 *      produced them; a year on, nobody remembers which figures were real.
 *   3. **`none` refuses.** A deployment that has not chosen a source gets no
 *      benchmark rather than a plausible one, which is the correct default and
 *      is why the live adapter's absence is visible instead of papered over.
 *
 * What a public listing can actually give us is a **rating and a review count**.
 * Sentiment is not obtainable — it needs the competitor's review *text*, which
 * no platform hands over for somebody else's business. The benchmark therefore
 * compares rating and volume, and says so, rather than carrying a sentiment
 * column that would be null forever. See the note in `docs/19`.
 */

export type CompetitorReading = {
  /** Mean rating on the listing, or null when the source could not read one. */
  rating: number | null;
  /** Total reviews the listing shows. Not a per-period figure. */
  reviewCount: number | null;
  /**
   * Which adapter produced this, verbatim, so a caller can distinguish an
   * invented number from a measured one. `"fixtures"` is never real.
   */
  source: string;
  /** When it was read. Fixtures answer instantly; a live adapter may cache. */
  capturedAt: Date;
};

export type CompetitorRef = {
  id: string;
  name: string;
  provider: string;
  externalRef: string;
};

export interface CompetitorSource {
  /** `"fixtures"`, or the provider a live adapter speaks to. */
  readonly name: string;
  /** True only for an adapter that read a real listing. */
  readonly isReal: boolean;
  read(competitor: CompetitorRef): Promise<CompetitorReading | null>;
}

/**
 * Invented numbers, derived from the competitor's own id.
 *
 * **Deterministic on purpose.** A random figure would move every time the page
 * rendered, which reads as live data and is the single most misleading thing a
 * fixture can do. Hashing the id means the same competitor shows the same
 * numbers forever — obviously static once you look twice, which is what a
 * fixture should be.
 *
 * The range is deliberately ordinary: 3.4–4.8 stars and 40–1,200 reviews. A
 * fixture that always made the competitor worse would let somebody demo a
 * flattering comparison and call it a feature.
 */
export function createFixtureSource(): CompetitorSource {
  return {
    name: "fixtures",
    isReal: false,
    async read(competitor: CompetitorRef): Promise<CompetitorReading> {
      const digest = createHash("sha256").update(competitor.id).digest();

      return {
        // 3.4 → 4.8 in tenths.
        rating: Math.round((3.4 + (digest[0]! % 15) / 10) * 10) / 10,
        reviewCount: 40 + (((digest[1]! << 8) | digest[2]!) % 1_160),
        source: "fixtures",
        capturedAt: new Date(),
      };
    },
  };
}

/**
 * Refuses, and says so by returning nothing.
 *
 * The default when no source is configured. A benchmark with no data is a
 * benchmark a business can see is not working; a benchmark with plausible data
 * from nowhere is one they will quote at a supplier.
 */
export function createNoSource(): CompetitorSource {
  return {
    name: "none",
    isReal: false,
    async read(): Promise<null> {
      return null;
    },
  };
}
