import { formatChange, type ChangeTranslator } from "./change-text.ts";
import type { DigestView } from "./queries.ts";
import type { ShareableDigest } from "./share.ts";

/**
 * A stored digest, rendered into the reader's language for export (W2.1).
 *
 * The seam between "what a week said", which lives in the payload, and "how it
 * is written", which lives in `next-intl` and `Intl`. Both the PDF and the
 * shareable text take their content from here, so the file an owner prints and
 * the message they paste into WhatsApp cannot disagree about the same week.
 *
 * It deliberately mirrors `components/digest/digest-view.tsx` section for
 * section — headline, pulse, the three actions with their evidence, what
 * changed, the themes. Somebody who exports the page and then looks at the page
 * should find the same things in the same order. What it does *not* carry is
 * the interactive half: the reply drafts and the social post are assets to act
 * on in the app, not part of a briefing you hand to somebody.
 */

/**
 * Only what this module asks of `next-intl`, enumerated.
 *
 * The keys are spelled out for the reason `ChangeTranslator` spells its six
 * out: a translator typed `(key: string) => string` would accept `t` from any
 * namespace, and the first missing key would surface as a rendered `digest.foo`
 * inside a PDF somebody had already printed. Values widen to `string | number`
 * — `evidence` and `themeCount` are plurals — which still leaves this
 * assignable to `ChangeTranslator` below.
 */
export type ShareTranslator = (
  key:
    | Parameters<ChangeTranslator>[0]
    | "briefingLabel"
    | "quietWeek"
    | "quietWeekBody"
    | "pulse"
    | "reviewCount"
    | "deltaUp"
    | "deltaDown"
    | "deltaFlat"
    | "actionsTitle"
    | "evidence"
    | "doneLabel"
    | "dismissedLabel"
    | "changesTitle"
    | "themesTitle"
    | "themeCount",
  values?: Record<string, string | number>,
) => string;

export type ShareFormatter = {
  /** A score to at most one decimal, in the reader's locale. */
  number: (value: number, maximumFractionDigits: number) => string;
};

/**
 * Stars as characters, the way the action card and the email both show them.
 *
 * Measured with fontkit against the committed Inter faces: `★` and `☆` are both
 * present, so this survives the trip into a PDF. Empty for an unrated review —
 * a DM has no stars, and five hollow ones read as zero rather than as absent.
 */
function stars(rating: number | null): string {
  if (rating === null) return "";
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  return `${"★".repeat(filled)}${"☆".repeat(5 - filled)} `;
}

export function toShareableDigest(input: {
  digest: DigestView;
  scopeName: string;
  /** "27 Temmuz – 2 Ağustos 2026", built by the caller from its own formatter. */
  period: string;
  t: ShareTranslator;
  /**
   * A theme key to a word, in the reader's language.
   *
   * Passed in rather than resolved here, for the same reason `t` and `format`
   * are: this module is the seam between what a week *said* and how it is
   * *written*, and it must not acquire a locale of its own. Since W3.2 reached
   * the digest, `theme.label` is a canonical key like `wait_time` wherever the
   * reviews were analysed under the taxonomy — so a caller that forgets this
   * prints the identifier into a PDF.
   */
  themeLabel: (key: string) => string;
  format: ShareFormatter;
}): ShareableDigest {
  const { digest, t, themeLabel, format } = input;
  const payload = digest.payload;

  // The quotes the payload already carries, by review id — the same map the
  // screen builds, so an exported quote is the text the model was shown.
  const quoteById = new Map(
    (payload?.themes ?? []).flatMap((theme) =>
      theme.quotes.map((quote) => [quote.reviewId, quote] as const),
    ),
  );

  const delta = digest.pulseDelta;
  const direction = delta === null ? null : delta > 0 ? "up" : delta < 0 ? "down" : "flat";

  return {
    scopeName: input.scopeName,
    period: input.period,
    eyebrow: t("briefingLabel"),
    // A thin or quiet week has no composed headline, and the refusal is the
    // news (W1.6). Exporting an empty string would produce a blank cover.
    headline: payload?.headline || t("quietWeek"),
    summary: payload?.summary ?? "",
    pulse: {
      label: t("pulse"),
      value: digest.pulseScore === null ? null : format.number(digest.pulseScore, 1),
      meta: t("reviewCount", { count: digest.reviewCount }),
      delta:
        delta === null
          ? null
          : direction === "flat"
            ? t("deltaFlat")
            : t(direction === "up" ? "deltaUp" : "deltaDown", {
                value: format.number(Math.abs(delta), 1),
              }),
      direction,
    },
    actionsTitle: t("actionsTitle"),
    actions: digest.actions.map((action) => {
      const evidence = action.evidence as { themeSlug?: string; reviewIds?: string[] } | null;
      const reviewIds = Array.isArray(evidence?.reviewIds) ? evidence.reviewIds : [];
      const quote = reviewIds.map((id) => quoteById.get(id)).find((found) => found !== undefined);

      const meta = [
        evidence?.themeSlug
          ? t("evidence", { count: reviewIds.length, theme: evidence.themeSlug })
          : null,
        // The status travels with the export: a plan handed to a manager that
        // does not say what has already been done invites it being done twice.
        action.status === "done"
          ? t("doneLabel")
          : action.status === "dismissed"
            ? t("dismissedLabel")
            : null,
      ].filter((part): part is string => Boolean(part));

      return {
        position: action.position,
        text: action.text,
        quote: quote ? `${stars(quote.rating)}“${quote.text}”` : null,
        meta: meta.length > 0 ? meta.join(" · ") : null,
      };
    }),
    actionsEmpty: t("quietWeekBody"),
    changesTitle: t("changesTitle"),
    changes: (payload?.changes ?? []).map((change, index) => ({
      key: `${change.kind}-${index}`,
      text: formatChange(change, t, themeLabel),
      direction: change.direction > 0 ? "up" : change.direction < 0 ? "down" : "flat",
    })),
    themesTitle: t("themesTitle"),
    themes: (payload?.themes ?? []).map((theme) => ({
      key: theme.label,
      label: themeLabel(theme.label),
      meta: t("themeCount", { count: theme.count }),
    })),
    footer: input.scopeName,
  };
}
