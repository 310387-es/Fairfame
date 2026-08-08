import { and, eq } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import {
  actionCompletionRecord,
  digestById,
  type CompletionRecord,
  type DigestView,
} from "./queries.ts";
import { digestShareText } from "./share.ts";
import { toShareableDigest, type ShareFormatter, type ShareTranslator } from "./shareable.ts";

/**
 * Everything a screen needs to render one week's briefing.
 *
 * **Why this exists.** `/weekly-plan/[id]` assembled it inline: three sequential
 * reads, a period label, and the shareable text. `/weekly-plan` then wanted to
 * lead with the newest briefing rather than a list of dates — and the only way
 * to do that was a second copy of all of it, in a second file, drifting from the
 * first the moment either changed. The archive shipped with a hero *card*
 * instead precisely because that trade was not worth making; this module is
 * what makes it unnecessary.
 *
 * Split in two on purpose, because the halves have different dependencies:
 *
 *   - `loadDigestBundle` is the **database** half and takes an open `tx`. It
 *     does not call `withTenant` itself, so a caller that is already inside a
 *     transaction — the archive, which is loading its list in one — does not
 *     open a second one. One tenant transaction is one `pg` client, which
 *     allows a single query in flight (P4-T1), and nesting them is how that
 *     turns into a deadlock nobody can reproduce.
 *   - `describeDigest` is the **presentation** half and takes a translator and
 *     a formatter. No database, no request API.
 *
 * Deliberately takes `organizationId` rather than calling `requireActor`: that
 * reaches `next/headers`, and a module in `src/digest` is one import away from
 * the worker that composes digests. The rule this codebase learned in P3-T5 —
 * a worker module must never reach a request API — is easier to keep by never
 * putting one here in the first place.
 */

export type DigestBundle = {
  /** Null when the id is unknown *or* belongs to another organization. */
  digest: DigestView | null;
  /** How the last four briefings' actions went. Null when there is no digest. */
  record: CompletionRecord | null;
  /** For the share text's "what business is this about" line. */
  locationName: string;
};

export async function loadDigestBundle(
  tx: TenantDatabase,
  organizationId: string,
  id: string,
): Promise<DigestBundle> {
  const digest = await digestById(tx, organizationId, id);

  // Sequential, not `Promise.all`: one tenant transaction is one `pg` client,
  // which allows a single query in flight (P4-T1). The record also needs this
  // digest's period to know what to exclude — a briefing must not report on
  // itself, or a fresh one always reads "0 of 3 done".
  const record = digest
    ? await actionCompletionRecord(tx, organizationId, digest.locationId, {
        before: digest.periodStart,
      })
    : null;

  const [location] = digest
    ? await tx
        .select({ name: schema.locations.name })
        .from(schema.locations)
        .where(
          and(
            eq(schema.locations.organizationId, organizationId),
            eq(schema.locations.id, digest.locationId),
          ),
        )
        .limit(1)
    : [];

  return { digest, record, locationName: location?.name ?? "" };
}

/** A period label and, when the week is `ready`, its shareable text. */
export type DigestDescription = {
  /** "27 Jul – 3 Aug 2026", already in the reader's locale. */
  period: string;
  /** Empty for a week that is not `ready` — there is nothing to share yet. */
  shareText: string;
};

export function describeDigest(input: {
  digest: DigestView;
  locationName: string;
  t: ShareTranslator;
  /** A canonical theme key to a word — see `toShareableDigest`. */
  themeLabel: (key: string) => string;
  /**
   * The caller's own `format.dateTime`, so the two surfaces cannot format a
   * date differently.
   *
   * Typed to exactly the three fields this uses rather than to
   * `Intl.DateTimeFormatOptions`: next-intl narrows several of its own option
   * values (`timeZoneName` accepts fewer literals than the DOM lib does), so
   * the wide type does not fit its signature. Narrow is also more honest — this
   * function formats a day, a month and sometimes a year, and nothing else.
   */
  formatDate: (
    value: Date,
    options: { day: "numeric"; month: "short"; year?: "numeric" },
  ) => string;
  formatNumber: (value: number, maximumFractionDigits?: number) => string;
  /** The archive's rows omit the year; the detail page's title carries it. */
  withYear?: boolean;
}): DigestDescription {
  const { digest, locationName, t, formatDate, formatNumber, withYear = true } = input;

  // The stored end is exclusive; a reader counting "28 July – 4 August" as a
  // week would get eight days.
  const inclusiveEnd = new Date(digest.periodEnd.getTime() - 1);
  const period = `${formatDate(digest.periodStart, {
    day: "numeric",
    month: "short",
  })} – ${formatDate(inclusiveEnd, {
    day: "numeric",
    month: "short",
    ...(withYear ? ({ year: "numeric" } as const) : {}),
  })}`;

  /**
   * The shareable text is built on the server and handed to the copy button as
   * a string (W2.1).
   *
   * Not a client-side assembler: `toShareableDigest` needs a translator and a
   * locale-aware formatter, and shipping the payload plus both to the browser
   * to rebuild what the server already has would be the P3-T4 mistake — a
   * formatter across the RSC boundary — with extra bytes.
   */
  const formatter: ShareFormatter = {
    number: (value, maximumFractionDigits) => formatNumber(value, maximumFractionDigits),
  };

  const shareText =
    digest.status === "ready"
      ? digestShareText(
          toShareableDigest({
            digest,
            scopeName: locationName,
            period,
            t,
            themeLabel: input.themeLabel,
            format: formatter,
          }),
        )
      : "";

  return { period, shareText };
}
