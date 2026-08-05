import type { Locale } from "../i18n/config.ts";
import { slugify } from "../seo/slug.ts";

/**
 * The report's words (P3-T5).
 *
 * **Not `next-intl`, and that is deliberate.** This runs in the BullMQ worker,
 * which has no request, no locale context and no `getTranslations` — the same
 * situation `src/messaging/templates.ts` is in, and it solves it the same way:
 * a plain record per locale, keyed by the recipient's own language.
 *
 * Keeping it out of `messages/*.json` also keeps `pnpm check:i18n` honest. That
 * check fails on a key nothing references, and these would be referenced only
 * through a lookup it cannot see — so they would either be reported as dead or
 * force the check to be loosened for everything.
 *
 * Dates are formatted here rather than passed in because the period is a
 * property of the report, not of the caller, and `Intl` is available in a
 * worker exactly as it is in a request.
 */

type ReportCopy = {
  cadence: Record<"weekly" | "monthly", string>;
  column: {
    location: string;
    source: string;
    theme: string;
    rating: string;
    sentiment: string;
    volume: string;
    replied: string;
    mentions: string;
    change: string;
  };
  byLocation: string;
  bySource: string;
  themes: string;
  themeNew: string;
  empty: string;
  periodLabel: (start: Date, end: Date) => string;
  footer: (generatedAt: Date) => string;
  pageLabel: (page: number, total: number) => string;
  filename: (scope: string, start: Date) => string;
};

/** The window is `[start, end)`; the label names the last day *inside* it. */
function inclusiveEnd(end: Date): Date {
  return new Date(end.getTime() - 1);
}

function build(
  locale: Locale,
  words: Omit<ReportCopy, "periodLabel" | "footer" | "pageLabel" | "filename">,
  extra: {
    generated: (date: string) => string;
    page: (page: number, total: number) => string;
  },
): ReportCopy {
  const date = (value: Date) =>
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(value);

  return {
    ...words,
    periodLabel: (start, end) => `${date(start)} – ${date(inclusiveEnd(end))}`,
    footer: (generatedAt) => extra.generated(date(generatedAt)),
    pageLabel: extra.page,
    /**
     * ASCII only, and dated.
     *
     * A filename crosses a mail server, a file system and whatever the
     * recipient's phone does with attachments; `Kadıköy raporu.pdf` survives
     * none of those reliably. The date is what stops a folder of downloads
     * becoming `report.pdf (4)`.
     *
     * `slugify` rather than a local `normalize("NFD")`, and the difference is
     * visible: NFD decomposes `ö` but not `ı`, so the hand-rolled version
     * produced `kad-koy-kahve` — seen in Mailpit. `src/seo/slug.ts` already
     * transliterates the six Turkish letters that do not decompose, and is
     * tested for exactly this.
     */
    filename: (scope, start) =>
      `revira-${slugify(scope).slice(0, 48).replace(/-+$/, "") || "report"}-${start
        .toISOString()
        .slice(0, 10)}.pdf`,
  };
}

const COPY: Record<Locale, ReportCopy> = {
  tr: build(
    "tr",
    {
      cadence: { weekly: "haftalık rapor", monthly: "aylık rapor" },
      column: {
        location: "Şube",
        source: "Kaynak",
        theme: "Tema",
        rating: "Puan",
        sentiment: "Duygu",
        volume: "Yorum",
        replied: "Yanıtlanan",
        mentions: "Bahsetme",
        change: "Değişim",
      },
      byLocation: "Şubeye göre",
      bySource: "Kaynağa göre",
      themes: "Ne değişti",
      themeNew: "yeni",
      empty: "Bu dönemde veri yok.",
    },
    {
      generated: (date) => `Revira · ${date} tarihinde oluşturuldu`,
      page: (page, total) => `${page} / ${total}`,
    },
  ),
  en: build(
    "en",
    {
      cadence: { weekly: "weekly report", monthly: "monthly report" },
      column: {
        location: "Branch",
        source: "Source",
        theme: "Theme",
        rating: "Rating",
        sentiment: "Sentiment",
        volume: "Reviews",
        replied: "Replied",
        mentions: "Mentions",
        change: "Change",
      },
      byLocation: "By branch",
      bySource: "By source",
      themes: "What changed",
      themeNew: "new",
      empty: "Nothing in this period.",
    },
    {
      generated: (date) => `Revira · generated ${date}`,
      page: (page, total) => `${page} of ${total}`,
    },
  ),
};

export function reportCopy(locale: Locale): ReportCopy {
  return COPY[locale];
}
