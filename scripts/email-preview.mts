/**
 * Sends one of every outbound email to the dev inbox, so the copy and the
 * layout can be read rather than imagined.
 *
 *   pnpm email:preview            both languages
 *   pnpm email:preview --locale tr
 *
 * Exists because an email is the one surface with no way to look at it. A page
 * is a URL away; a template only renders when the event behind it happens, so
 * reviewing the digest meant waiting a week and reviewing an SLA rollup meant
 * letting deadlines lapse. The result was predictable: a rollup shipped with
 * blank fields and a link to `/reviews?review=undefined`, and nobody saw it
 * because nobody could.
 *
 * Everything below is rendered by the **real** template functions with
 * plausible data — no hand-written HTML — so what lands in the inbox is what
 * the product sends. Nothing is written to the database and no real recipient
 * is involved.
 *
 * **When you add a template, add it here.** This file is the inventory of what
 * the product can put in someone's inbox, and one that quietly stops listing a
 * template is worse than no list at all.
 */
import { createSmtpTransport, type EmailTransport } from "../src/messaging/email.ts";
import {
  renderDigestEmail,
  renderReportEmail,
  renderReviewAlertEmail,
  renderReviewRequestEmail,
  renderRollupEmail,
  renderInvitationEmail,
  renderPasswordResetEmail,
  renderSurveyInviteEmail,
  type RenderedEmail,
} from "../src/messaging/templates.ts";
import { reportCopy } from "../src/reports/copy.ts";
import { renderReportPdf } from "../src/reports/document.ts";
import { completedPeriod } from "../src/reports/period.ts";
import { isLocale, LOCALES, type Locale } from "../src/i18n/config.ts";
import { getEnv } from "../src/lib/env.ts";

const RECIPIENT = "preview@revira.local";
const SETTINGS_URL = "http://localhost:3000/settings#notifications";
const BUSINESS = "Kadıköy Kahve";
const LOCATION = "Kadıköy Şubesi";
/** Fixed, so a preview run is the same document every time. */
const PREVIEW_NOW = new Date("2026-08-05T09:00:00Z");

/**
 * A sample can carry an attachment, because one of them does — the scheduled
 * report is a covering note *and* a PDF, and previewing only the note would
 * miss the half that is actually rendered by a library.
 */
type Sample = {
  label: string;
  render: (locale: Locale) => RenderedEmail;
  attach?: (locale: Locale) => Promise<{ filename: string; contentType: string; content: Buffer }>;
};

/**
 * Turkish sample content throughout, in both language runs.
 *
 * Deliberate: the *chrome* is translated but a review is quoted verbatim in
 * whatever language the customer wrote it, so an English-speaking manager
 * reading a Turkish review is the normal case rather than an edge one. Seeing
 * that mix is most of the point of looking at these at all.
 */
const SAMPLES: Sample[] = [
  {
    label: "1 · Review request (to a customer)",
    render: (locale) =>
      renderReviewRequestEmail({
        locale,
        contactName: "Ayşe Kaya",
        businessName: BUSINESS,
        locationName: LOCATION,
        link: "http://localhost:3000/r/abc123def456ghi789jklm",
        unsubscribeUrl: "http://localhost:3000/u/abc123def456ghi789jklm",
      }),
  },
  {
    // Two samples, because the instrument changes the default question and that
    // question is the whole message. One preview would leave half the template
    // unlooked-at, which is the failure this script exists to prevent.
    label: "1b · Survey invitation — NPS",
    render: (locale) =>
      renderSurveyInviteEmail({
        locale,
        contactName: "Ayşe Kaya",
        businessName: BUSINESS,
        locationName: LOCATION,
        type: "nps",
        question: null,
        link: "http://localhost:3000/s/abc123def456ghi789jklm",
        unsubscribeUrl: "http://localhost:3000/u/abc123def456ghi789jklm",
      }),
  },
  {
    label: "1c · Survey invitation — CSAT, with the business's own question",
    render: (locale) =>
      renderSurveyInviteEmail({
        locale,
        contactName: null,
        businessName: BUSINESS,
        locationName: LOCATION,
        type: "csat",
        question: "Kadıköy şubemizdeki servis hızından ne kadar memnun kaldınız?",
        link: "http://localhost:3000/s/abc123def456ghi789jklm",
        unsubscribeUrl: "http://localhost:3000/u/abc123def456ghi789jklm",
      }),
  },
  {
    label: "2 · New review — ordinary",
    render: (locale) =>
      renderReviewAlertEmail({
        locale,
        recipientName: "Mehmet",
        businessName: BUSINESS,
        locationName: LOCATION,
        source: "google",
        rating: 5,
        authorName: "Ayşe K.",
        excerpt: "Kahvesi harikaydı, personel çok ilgiliydi. Kesinlikle tekrar geleceğim.",
        urgent: false,
        reason: "arrived",
        link: "http://localhost:3000/reviews?review=demo-1",
        settingsUrl: SETTINGS_URL,
      }),
  },
  {
    label: "3 · New review — urgent (negative)",
    render: (locale) =>
      renderReviewAlertEmail({
        locale,
        recipientName: "Mehmet",
        businessName: BUSINESS,
        locationName: LOCATION,
        source: "google",
        rating: 1,
        authorName: "Anonim",
        excerpt: "Servis çok yavaştı, yarım saat bekledik ve kimse ilgilenmedi.",
        urgent: true,
        reason: "arrived",
        link: "http://localhost:3000/reviews?review=demo-2",
        settingsUrl: SETTINGS_URL,
      }),
  },
  {
    // Worth opening next to #2: same review, same stars, same quote. Only the
    // subject and the first line differ, and that difference is the whole
    // point — this one did not "just come in".
    label: "4 · Review assigned to you",
    render: (locale) =>
      renderReviewAlertEmail({
        locale,
        recipientName: "Mehmet",
        businessName: BUSINESS,
        locationName: LOCATION,
        source: "instagram",
        rating: 4,
        authorName: "burcu.travels",
        excerpt: "Manzarası çok güzel, tatlıları da denemeye değer.",
        urgent: false,
        reason: "assigned",
        link: "http://localhost:3000/reviews?review=demo-3",
        settingsUrl: SETTINGS_URL,
      }),
  },
  {
    label: "5 · Rollup — overdue backlog (SLA)",
    render: (locale) =>
      renderRollupEmail({
        locale,
        recipientName: "Mehmet",
        businessName: BUSINESS,
        locationName: LOCATION,
        count: 23,
        kind: "sla",
        link: "http://localhost:3000/reviews?overdue=1",
        settingsUrl: SETTINGS_URL,
      }),
  },
  {
    label: "6 · Rollup — bulk assignment",
    render: (locale) =>
      renderRollupEmail({
        locale,
        recipientName: "Mehmet",
        businessName: BUSINESS,
        locationName: LOCATION,
        count: 12,
        kind: "assignment",
        link: "http://localhost:3000/reviews?assignee=me",
        settingsUrl: SETTINGS_URL,
      }),
  },
  {
    label: "7 · Weekly Action Digest",
    render: (locale) =>
      renderDigestEmail({
        locale,
        recipientName: "Mehmet",
        businessName: BUSINESS,
        locationName: LOCATION,
        periodStart: new Date("2026-07-27T00:00:00Z"),
        // Exclusive, so the copy prints through the 2nd. Not an off-by-one.
        periodEnd: new Date("2026-08-03T00:00:00Z"),
        // The pulse is a 0–100 score, not a star average. This fixture said 4.3
        // and the template prints "/100", so every preview of the product's
        // hero email has read "İtibar nabzı: 4/100" — a catastrophe, in the one
        // place the email is ever looked at (W2.1).
        pulseScore: 86.2,
        pulseDelta: 5.2,
        reviewCount: 31,
        headline: "Servis hızı bu hafta tek başına en çok şikâyet edilen konu.",
        summary:
          "Puan ortalaması yükseldi ama olumsuz yorumların çoğu aynı şeyi söylüyor: yoğun " +
          "saatlerde bekleme süresi. Kahve ve personel övgü almaya devam ediyor.",
        // Each with its evidence, as the pipeline now stores it: a customer's
        // own words and a link to exactly the reviews behind the sentence.
        actions: [
          {
            position: 1,
            text: "Hafta içi 12:00–14:00 arasında bir kişi daha görevlendirin.",
            quote: {
              text: "Öğlen 12'de girdik, siparişi almaları yirmi dakika sürdü. Yemek güzeldi ama bir daha o saatte gelmem.",
              rating: 2,
            },
            reviewCount: 4,
            link: "http://localhost:3000/reviews?location=demo&reviews=r1,r2,r3,r4",
          },
          {
            position: 2,
            text: "Bekleyen 4 olumsuz yoruma bugün yanıt verin.",
            quote: {
              text: "Şikâyetimi yazdım, kimse dönmedi. En azından bir cevap beklerdim.",
              rating: 1,
            },
            reviewCount: 4,
            link: "http://localhost:3000/reviews?location=demo&reviews=r5,r6,r7,r8",
          },
          {
            // No citation: a digest composed before W1.6 stored none, and the
            // sentence is still worth sending. The card must degrade, not vanish.
            position: 3,
            text: "Otopark yönlendirmesini kapı girişine ekleyin.",
            quote: null,
            reviewCount: 0,
            link: null,
          },
        ],
        themes: [
          { label: "Servis hızı", count: 11, positive: 2, negative: 9 },
          { label: "Kahve kalitesi", count: 9, positive: 9, negative: 0 },
          { label: "Otopark", count: 5, positive: 1, negative: 4 },
        ],
        priorOutcome: { done: 2, total: 3 },
        heldCount: 6,
        link: "http://localhost:3000/weekly-plan/demo",
        settingsUrl: SETTINGS_URL,
      }),
  },
  {
    /**
     * The one sample with an attachment, and the reason the preview grew the
     * ability to carry one. The covering note is a template like any other; the
     * PDF beside it is rendered by a library, embeds its own fonts, and is the
     * half most likely to be wrong in a way only looking at it reveals — the
     * built-in font turns "Kadıköy Şubesi" into "Kad1köy ^ubesi".
     */
    label: "8 · Scheduled report (PDF attached)",
    render: (locale) => {
      const copy = reportCopy(locale);
      const period = completedPeriod("weekly", PREVIEW_NOW);

      return renderReportEmail({
        locale,
        recipientName: "Mehmet",
        scopeName: `${BUSINESS} — ${LOCATION}`,
        period: copy.periodLabel(period.start, period.end),
        cadence: "weekly",
        reviewCount: 31,
        averageRating: locale === "tr" ? "4,3" : "4.3",
        repliedShare: locale === "tr" ? "%82" : "82%",
        link: "http://localhost:3000/analytics",
        settingsUrl: "http://localhost:3000/analytics",
        attachmentName: copy.filename(`${BUSINESS} ${LOCATION}`, period.start),
      });
    },
    attach: async (locale) => {
      const copy = reportCopy(locale);
      const period = completedPeriod("weekly", PREVIEW_NOW);
      const number = (value: number, digits: number) =>
        new Intl.NumberFormat(locale, {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }).format(value);
      // Formatted the way the pipeline formats it, so the preview cannot show a
      // shape the product does not produce — Turkish writes %82, not 82%.
      const percent = (value: number) =>
        new Intl.NumberFormat(locale, { style: "percent" }).format(value);

      const content = await renderReportPdf({
        title: `${BUSINESS} — ${LOCATION}`,
        subtitle: `${copy.periodLabel(period.start, period.end)} · ${copy.cadence.weekly}`,
        metrics: [
          { label: copy.column.volume, value: number(31, 0), delta: "+7", direction: "up" },
          { label: copy.column.rating, value: number(4.3, 1), delta: "+0,4", direction: "up" },
          // A positive share, not the retired −1…1 mean. This fixture said
          // `0.38` long after `breakdown()` stopped producing that scale, so
          // the preview showed a plausible-looking number from a metric the
          // product no longer has — which is worse than showing nothing.
          { label: copy.column.sentiment, value: percent(0.72), delta: null, direction: null },
          {
            label: copy.column.replied,
            value: percent(0.82),
            delta: `−${percent(0.03)}`,
            direction: "down",
          },
        ],
        tables: [
          {
            title: copy.byLocation,
            columns: [
              copy.column.location,
              copy.column.rating,
              copy.column.sentiment,
              copy.column.volume,
              copy.column.replied,
            ],
            rows: [
              {
                key: "kadikoy",
                label: LOCATION,
                cells: [number(4.3, 1), percent(0.72), number(31, 0), percent(0.82)],
              },
              {
                key: "sisli",
                label: "Şişli Şubesi",
                cells: [null, null, number(0, 0), null],
              },
            ],
            empty: copy.empty,
          },
          {
            title: copy.themes,
            columns: [copy.column.theme, copy.column.mentions, copy.column.change],
            rows: [
              { key: "servis", label: "servis hızı", cells: [number(11, 0), "+120%"] },
              { key: "kahve", label: "kahve kalitesi", cells: [number(9, 0), "+12%"] },
              { key: "otopark", label: "otopark", cells: [number(5, 0), copy.themeNew] },
            ],
            empty: copy.empty,
          },
        ],
        footer: copy.footer(PREVIEW_NOW),
        pageLabel: copy.pageLabel,
      });

      return {
        filename: copy.filename(`${BUSINESS} ${LOCATION}`, period.start),
        contentType: "application/pdf",
        content,
      };
    },
  },
  {
    /**
     * The one email in the product sent to somebody who is not a customer and
     * not yet a colleague (W1.9). It carries no unsubscribe footer, which is
     * the thing worth *looking* at rather than taking on trust — every other
     * template here has one, and a missing footer is invisible in code review.
     */
    label: "9 · Team invitation",
    render: (locale) =>
      renderInvitationEmail({
        locale,
        inviterName: "Ömer Eş",
        businessName: BUSINESS,
        roleLabel: locale === "tr" ? "Yönetici" : "Admin",
        link: "http://localhost:3000/invite/6f1c2f2a-0b2e-4a55-9a3e-8b2d1f4c9e77",
        expiresAt: new Date(PREVIEW_NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
      }),
  },
  {
    /**
     * The one email whose absence locks somebody out for good (W1.9b). Worth
     * previewing for the sentence at the bottom rather than the button: this is
     * also what a person sees when a stranger types their address into a login
     * form, and "your password has not changed" is what stops that being
     * alarming.
     */
    label: "10 · Password reset",
    render: (locale) =>
      renderPasswordResetEmail({
        locale,
        name: "Ömer Eş",
        link: "http://localhost:3000/api/auth/reset-password/preview-token?callbackURL=%2Freset-password",
        expiresInMinutes: 60,
      }),
  },
];

/** `--locale tr` narrows the run; absent means both. */
function requestedLocales(): readonly Locale[] {
  const index = process.argv.indexOf("--locale");
  if (index === -1) return LOCALES;

  const value = process.argv[index + 1];
  if (!isLocale(value)) {
    console.error(`--locale must be one of: ${LOCALES.join(", ")}`);
    process.exit(1);
  }
  return [value];
}

/**
 * Refuses to run against anything but a local mail catcher.
 *
 * This sends fourteen messages to a made-up address. Against a real SMTP relay
 * that is fourteen bounces and a reputation hit, and the failure mode of a
 * preview tool pointed at production is exactly the kind nobody expects until
 * it happens.
 */
function assertSafeTransport(): void {
  const env = getEnv();

  if (env.EMAIL_TRANSPORT !== "smtp") {
    console.error(
      `EMAIL_TRANSPORT is "${env.EMAIL_TRANSPORT}". Set it to "smtp" so the messages reach Mailpit.`,
    );
    process.exit(1);
  }

  const host = new URL(env.SMTP_URL).hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "mail") {
    console.error(`Refusing to send previews through a non-local SMTP host: ${host}`);
    process.exit(1);
  }
}

assertSafeTransport();

const locales = requestedLocales();
const transport: EmailTransport = createSmtpTransport();
let sent = 0;
let failed = 0;

for (const sample of SAMPLES) {
  for (const locale of locales) {
    const message = sample.render(locale);

    const attachments = sample.attach ? [await sample.attach(locale)] : undefined;

    const outcome = await transport.send({
      to: RECIPIENT,
      // The label rides in the subject so the inbox reads as an ordered
      // checklist rather than a pile of similar-looking alerts.
      subject: `[${locale.toUpperCase()}] ${sample.label} — ${message.subject}`,
      text: message.text,
      html: message.html,
      ...(attachments ? { attachments } : {}),
    });

    if (outcome.ok) {
      sent += 1;
      console.log(`sent    [${locale}] ${sample.label}`);
    } else {
      failed += 1;
      console.error(`FAILED  [${locale}] ${sample.label}: ${outcome.reason}`);
    }
  }
}

console.log(`\n${sent} sent${failed > 0 ? `, ${failed} failed` : ""}. Open http://localhost:8025`);
process.exitCode = failed > 0 ? 1 : 0;
