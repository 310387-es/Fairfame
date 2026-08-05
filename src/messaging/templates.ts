import type { Locale } from "../i18n/config.ts";

/**
 * Outbound message copy, in the recipient's language.
 *
 * Deliberately not next-intl: these strings are rendered by background jobs and
 * route handlers for a *recipient's* locale, which has nothing to do with the
 * locale of whoever triggered the send. Keeping them as plain data also lets
 * the compliance-relevant parts — the reason-for-receipt line and the opt-out
 * link — be asserted directly in tests.
 *
 * The copy asks for an honest account, in both languages, and never conditions
 * anything on how good the experience was. Rating-gating is illegal under
 * platform policy and pointless under ours; the wording reflects that.
 */

export type ReviewRequestEmailInput = {
  locale: Locale;
  /** Null when we only ever had an email address. */
  contactName: string | null;
  businessName: string;
  locationName: string;
  /** The tracked short link — /r/{token}. */
  link: string;
  unsubscribeUrl: string;
  /** Per-campaign copy overrides, if the owner wrote their own. */
  overrides?: { subject?: string | undefined; body?: string | undefined };
};

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

type Copy = {
  subject: (input: ReviewRequestEmailInput) => string;
  greeting: (name: string | null) => string;
  body: (input: ReviewRequestEmailInput) => string;
  cta: string;
  signOff: (business: string) => string;
  /** Why this message arrived, and how to stop it. Required, not optional. */
  footer: (business: string) => string;
  unsubscribe: string;
};

const COPY: Record<Locale, Copy> = {
  tr: {
    subject: ({ locationName }) => `${locationName} deneyiminizi paylaşır mısınız?`,
    greeting: (name) => (name ? `Merhaba ${name},` : "Merhaba,"),
    body: ({ locationName }) =>
      `${locationName} ziyaretiniz için teşekkür ederiz. Bir dakikanızı ayırıp deneyiminizi ` +
      `anlatırsanız çok memnun oluruz. Görüşünüz olumlu da olsa olumsuz da olsa bizim için ` +
      `aynı derecede değerli.`,
    cta: "Deneyiminizi paylaşın",
    signOff: (business) => `Teşekkürler,\n${business}`,
    footer: (business) =>
      `Bu e-postayı, ${business} görüşünüzü sorduğu için aldınız. Kişisel verileriniz yalnızca ` +
      `bu talep için işlenir (KVKK).`,
    unsubscribe: "Bu e-postaları almayı bırakmak için tıklayın",
  },
  en: {
    subject: ({ locationName }) => `How was your visit to ${locationName}?`,
    greeting: (name) => (name ? `Hi ${name},` : "Hi,"),
    body: ({ locationName }) =>
      `Thank you for visiting ${locationName}. If you have a minute, we would love to hear how ` +
      `it went. Good or bad, your feedback is equally useful to us.`,
    cta: "Share your experience",
    signOff: (business) => `Thank you,\n${business}`,
    footer: (business) =>
      `You received this because ${business} asked for your feedback. Your details are processed ` +
      `only for this request.`,
    unsubscribe: "Unsubscribe from these emails",
  },
};

/** Minimal, deliberate escaping — recipient names and business names are user input. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderReviewRequestEmail(input: ReviewRequestEmailInput): RenderedEmail {
  const copy = COPY[input.locale];
  const greeting = copy.greeting(input.contactName);
  // An owner's own words replace the body, never the footer: the
  // reason-for-receipt line and the opt-out link are not theirs to remove.
  const body = input.overrides?.body?.trim() || copy.body(input);
  const subject = input.overrides?.subject?.trim() || copy.subject(input);
  const footer = copy.footer(input.businessName);

  const text = [
    greeting,
    "",
    body,
    "",
    input.link,
    "",
    copy.signOff(input.businessName),
    "",
    "—",
    footer,
    `${copy.unsubscribe}: ${input.unsubscribeUrl}`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${escapeHtml(body)}</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;">${escapeHtml(copy.cta)}</a>
      </p>
      <p style="margin:0;font-size:15px;line-height:1.6;white-space:pre-line;">${escapeHtml(copy.signOff(input.businessName))}</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 16px;" />
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#6b7280;">${escapeHtml(footer)}</p>
      <p style="margin:0;font-size:12px;color:#6b7280;">
        <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#6b7280;">${escapeHtml(copy.unsubscribe)}</a>
      </p>
    </div>
  </body>
</html>`;

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// New-review alerts (P1a-T5)
// ---------------------------------------------------------------------------

/**
 * Notification email for a new review.
 *
 * A different animal from the request email above, and the difference is legal
 * as much as editorial: that one goes to a *customer* and therefore carries a
 * KVKK reason-for-receipt line and a mandatory opt-out. This one goes to a
 * *team member about their own business*, so the footer points at their
 * notification settings instead. Conflating the two would either spam a
 * customer without consent or bury an owner's alert under compliance text
 * meant for someone else.
 *
 * The review's own words are escaped and excerpted, never rendered as markup —
 * review text is untrusted input here exactly as it is in a prompt.
 */
export type ReviewAlertEmailInput = {
  locale: Locale;
  recipientName: string | null;
  businessName: string;
  locationName: string;
  source: string;
  rating: number | null;
  authorName: string | null;
  excerpt: string | null;
  urgent: boolean;
  /**
   * Why this landed: the review just arrived, or a teammate handed it over.
   *
   * The body is identical — same review, same quote, same stars — but the first
   * line is not, and getting it wrong is worse than it sounds: "a new review
   * just came in" about a review that arrived last Tuesday and was assigned to
   * you this morning is simply false.
   */
  reason?: "arrived" | "assigned";
  /** Deep link into the Inbox. */
  link: string;
  /** Where to change what arrives. Not an unsubscribe — this is not marketing. */
  settingsUrl: string;
};

type AlertCopy = {
  subject: (input: ReviewAlertEmailInput) => string;
  assignedSubject: (input: ReviewAlertEmailInput) => string;
  greeting: (name: string | null) => string;
  lead: (input: ReviewAlertEmailInput) => string;
  assignedLead: (input: ReviewAlertEmailInput) => string;
  urgentLead: (input: ReviewAlertEmailInput) => string;
  byline: (author: string | null, source: string) => string;
  cta: string;
  footer: string;
  settings: string;
  noText: string;
};

const ALERT_COPY: Record<Locale, AlertCopy> = {
  tr: {
    subject: ({ locationName, rating, urgent }) =>
      urgent
        ? `Dikkat: ${locationName} için ${rating ? `${rating} yıldızlı ` : ""}olumsuz yorum`
        : `${locationName} için yeni yorum${rating ? ` (${rating} yıldız)` : ""}`,
    assignedSubject: ({ locationName }) => `${locationName} için bir yorum size atandı`,
    greeting: (name) => (name ? `Merhaba ${name},` : "Merhaba,"),
    lead: ({ locationName }) => `${locationName} için yeni bir yorum geldi.`,
    assignedLead: ({ locationName }) =>
      `Bir ekip arkadaşınız ${locationName} şubesindeki bu yorumu size atadı.`,
    urgentLead: ({ locationName }) =>
      `${locationName} için olumsuz bir yorum geldi. Hızlı bir yanıt genellikle en çok burada işe yarar.`,
    byline: (author, source) => `${author ?? "Anonim"} · ${source}`,
    cta: "Yorumu görüntüle",
    footer: "Bu bildirimi ekip üyesi olduğunuz için aldınız.",
    settings: "Bildirim tercihlerinizi değiştirin",
    noText: "(Yorum metni yok — yalnızca puan verilmiş.)",
  },
  en: {
    subject: ({ locationName, rating, urgent }) =>
      urgent
        ? `Heads up: negative review${rating ? ` (${rating}★)` : ""} for ${locationName}`
        : `New review for ${locationName}${rating ? ` (${rating}★)` : ""}`,
    assignedSubject: ({ locationName }) => `A review at ${locationName} was assigned to you`,
    greeting: (name) => (name ? `Hi ${name},` : "Hi,"),
    lead: ({ locationName }) => `A new review just came in for ${locationName}.`,
    assignedLead: ({ locationName }) => `A teammate assigned you this review at ${locationName}.`,
    urgentLead: ({ locationName }) =>
      `A negative review just came in for ${locationName}. A quick reply usually matters most here.`,
    byline: (author, source) => `${author ?? "Anonymous"} · ${source}`,
    cta: "Open the review",
    footer: "You received this because you are a member of this team.",
    settings: "Change your notification preferences",
    noText: "(No review text — a rating only.)",
  },
};

export function renderReviewAlertEmail(input: ReviewAlertEmailInput): RenderedEmail {
  const copy = ALERT_COPY[input.locale];
  const greeting = copy.greeting(input.recipientName);
  const assigned = input.reason === "assigned";
  // An assignment says so even when the review is a bad one: "this is yours" is
  // the more useful first line, and the urgency still shows in the styling.
  const lead = assigned
    ? copy.assignedLead(input)
    : input.urgent
      ? copy.urgentLead(input)
      : copy.lead(input);
  const byline = copy.byline(input.authorName, input.source);
  const body = input.excerpt ?? copy.noText;
  const stars =
    input.rating === null ? "" : `${"★".repeat(input.rating)}${"☆".repeat(5 - input.rating)}`;

  const text = [
    greeting,
    "",
    lead,
    "",
    [stars, byline].filter(Boolean).join("  "),
    body,
    "",
    input.link,
    "",
    "—",
    copy.footer,
    `${copy.settings}: ${input.settingsUrl}`,
  ].join("\n");

  const accent = input.urgent ? "#b91c1c" : "#111827";

  const html = `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:${accent};">${escapeHtml(lead)}</p>
      <div style="border-left:3px solid ${accent};padding:4px 0 4px 16px;margin:0 0 24px;">
        <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">${escapeHtml([stars, byline].filter(Boolean).join("  "))}</p>
        <p style="margin:0;font-size:15px;line-height:1.6;">${escapeHtml(body)}</p>
      </div>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;">${escapeHtml(copy.cta)}</a>
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 16px;" />
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#6b7280;">${escapeHtml(copy.footer)}</p>
      <p style="margin:0;font-size:12px;color:#6b7280;">
        <a href="${escapeHtml(input.settingsUrl)}" style="color:#6b7280;">${escapeHtml(copy.settings)}</a>
      </p>
    </div>
  </body>
</html>`;

  return { subject: assigned ? copy.assignedSubject(input) : copy.subject(input), text, html };
}

// ---------------------------------------------------------------------------
// Rollup alerts — an email about a pile rather than a review
// ---------------------------------------------------------------------------

/**
 * The alert that says "you are behind", not "look at this review".
 *
 * It exists because the review-alert template above could not honestly render
 * one and was doing it anyway: a rollup payload carries a count and a location
 * and nothing else, so every field came out blank and the button linked to
 * `/inbox?review=undefined`. The sender now refuses that shape — and this is
 * what it refuses *into*, so someone who asked to be emailed about a backlog is
 * told about the backlog rather than being quietly dropped.
 *
 * Deliberately a different shape from the review alert, not a variant of it.
 * There is no quote to show, no stars, no author; what matters is a number and
 * a way into the queue it describes. Bending the other template around an
 * absent review is exactly how the broken version happened.
 */
export type RollupEmailInput = {
  locale: Locale;
  recipientName: string | null;
  businessName: string;
  locationName: string;
  count: number;
  /** Which pile: a lapsed-deadline backlog, or work just handed over. */
  kind: "sla" | "assignment";
  /** Into the filtered inbox that holds them — never a single review. */
  link: string;
  settingsUrl: string;
};

type RollupCopy = {
  subject: (input: RollupEmailInput) => string;
  greeting: (name: string | null) => string;
  lead: (input: RollupEmailInput) => string;
  cta: string;
  footer: string;
  settings: string;
};

const ROLLUP_COPY: Record<Locale, RollupCopy> = {
  tr: {
    subject: ({ locationName, count, kind }) =>
      kind === "sla"
        ? `${locationName}: süresi geçen ${count} yorum`
        : `Size ${count} yorum atandı`,
    greeting: (name) => (name ? `Merhaba ${name},` : "Merhaba,"),
    lead: ({ locationName, count, kind }) =>
      kind === "sla"
        ? `${locationName} şubesinde yanıt süresi dolan ${count} yorum var. Tek tek bildirim yerine tek bir özet gönderiyoruz.`
        : `Bir ekip arkadaşınız ${locationName} şubesinden ${count} yorumu size atadı.`,
    cta: "Sıraya git",
    footer: "Bu bildirimi ekip üyesi olduğunuz için aldınız.",
    settings: "Bildirim tercihlerinizi değiştirin",
  },
  en: {
    subject: ({ locationName, count, kind }) =>
      kind === "sla"
        ? `${locationName}: ${count} reviews past their deadline`
        : `${count} reviews assigned to you`,
    greeting: (name) => (name ? `Hi ${name},` : "Hi,"),
    lead: ({ locationName, count, kind }) =>
      kind === "sla"
        ? `${count} reviews at ${locationName} are past the time you gave yourselves to reply. This is one summary instead of ${count} separate alerts.`
        : `A teammate assigned you ${count} reviews at ${locationName}.`,
    cta: "Open the queue",
    footer: "You received this because you are a member of this team.",
    settings: "Change your notification preferences",
  },
};

export function renderRollupEmail(input: RollupEmailInput): RenderedEmail {
  const copy = ROLLUP_COPY[input.locale];
  const greeting = copy.greeting(input.recipientName);
  const lead = copy.lead(input);

  const text = [
    greeting,
    "",
    lead,
    "",
    input.link,
    "",
    "—",
    copy.footer,
    `${copy.settings}: ${input.settingsUrl}`,
  ].join("\n");

  // A lapsed promise is the one that warrants the alarm colour; a handoff is
  // ordinary work and is styled as such.
  const accent = input.kind === "sla" ? "#b91c1c" : "#111827";

  const html = `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 8px;font-size:32px;font-weight:600;color:${accent};">${input.count}</p>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${escapeHtml(lead)}</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;">${escapeHtml(copy.cta)}</a>
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 16px;" />
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#6b7280;">${escapeHtml(copy.footer)}</p>
      <p style="margin:0;font-size:12px;color:#6b7280;">
        <a href="${escapeHtml(input.settingsUrl)}" style="color:#6b7280;">${escapeHtml(copy.settings)}</a>
      </p>
    </div>
  </body>
</html>`;

  return { subject: copy.subject(input), text, html };
}

// ---------------------------------------------------------------------------
// The weekly Action Digest (D1 — docs/14-digest-surfaces.md)
// ---------------------------------------------------------------------------

/**
 * The weekly briefing, as an email.
 *
 * This is the digest's primary surface, not a notification that one exists.
 * A "your digest is ready, click here" email would be a link with a stamp on
 * it: the whole point of a briefing composed once a week is that it can be read
 * where it arrives, on a phone, without signing in. So the actions, the pulse
 * and the themes are all in the body, and the link goes to the archive for the
 * parts that are interactive — marking an action done, the reply drafts.
 *
 * Order follows `components/digest/digest-view.tsx`, deliberately: someone who
 * reads the email and then opens the page should find the same things in the
 * same sequence. It is not the same *implementation* — an HTML email cannot
 * reuse React components that assume Tailwind, and every attempt to share one
 * ends with a renderer that serves neither.
 *
 * Everything interpolated here is escaped. The headline, summary, actions and
 * theme labels are model output derived from review text, which is untrusted
 * input in an email exactly as it is in a prompt.
 */
export type DigestEmailInput = {
  locale: Locale;
  recipientName: string | null;
  businessName: string;
  locationName: string;
  periodStart: Date;
  /** Exclusive — the copy prints the day before, since a reader means "through". */
  periodEnd: Date;
  pulseScore: number | null;
  pulseDelta: number | null;
  reviewCount: number;
  headline: string;
  summary: string;
  actions: { position: number; text: string }[];
  themes: { label: string; count: number; positive: number; negative: number }[];
  /**
   * New-review emails this person asked us to hold for the digest. Stated
   * rather than silently folded in: they chose a calmer inbox, not a quieter
   * week, and the count is how the digest keeps that promise honest.
   */
  heldCount: number;
  /** The archive entry for this digest. */
  link: string;
  settingsUrl: string;
};

type DigestCopy = {
  subject: (input: DigestEmailInput & { period: string }) => string;
  greeting: (name: string | null) => string;
  lead: (input: DigestEmailInput & { period: string }) => string;
  quietLead: (input: DigestEmailInput & { period: string }) => string;
  quietBody: string;
  pulse: (score: string, delta: string | null) => string;
  pulseNone: string;
  deltaUp: (value: string) => string;
  deltaDown: (value: string) => string;
  deltaFlat: string;
  reviewCount: (count: number) => string;
  actionsTitle: string;
  themesTitle: string;
  themeLine: (label: string, count: number, positive: number, negative: number) => string;
  held: (count: number) => string;
  cta: string;
  footer: string;
  settings: string;
};

const DIGEST_COPY: Record<Locale, DigestCopy> = {
  tr: {
    subject: ({ locationName, period }) => `${locationName} · haftalık özet (${period})`,
    greeting: (name) => (name ? `Merhaba ${name},` : "Merhaba,"),
    lead: ({ locationName, period }) => `${locationName} için ${period} haftasının özeti.`,
    quietLead: ({ locationName, period }) => `${locationName} için ${period} haftası sessiz geçti.`,
    quietBody:
      "Bu hafta yeni yorum gelmedi. Yapılacak bir şey yok — bir sonraki özet yeni yorumlar geldiğinde daha dolu olacak.",
    pulse: (score, delta) =>
      delta ? `İtibar nabzı: ${score}/100 (${delta})` : `İtibar nabzı: ${score}/100`,
    pulseNone: "İtibar nabzı: henüz hesaplanamadı",
    deltaUp: (value) => `geçen haftaya göre +${value}`,
    deltaDown: (value) => `geçen haftaya göre ${value}`,
    deltaFlat: "geçen haftayla aynı",
    reviewCount: (count) => `${count} yorum`,
    actionsTitle: "Bu hafta yapılacak üç şey",
    themesTitle: "Öne çıkan konular",
    themeLine: (label, count, positive, negative) =>
      `${label} — ${count} yorum (${positive} olumlu, ${negative} olumsuz)`,
    held: (count) =>
      count === 1
        ? "Ayrıca bu hafta, özette toplanmasını istediğiniz 1 yeni yorum bildirimi var."
        : `Ayrıca bu hafta, özette toplanmasını istediğiniz ${count} yeni yorum bildirimi var.`,
    cta: "Özetin tamamını aç",
    footer: "Bu özeti ekip üyesi olduğunuz ve haftalık gönderimi seçtiğiniz için aldınız.",
    settings: "Bildirim tercihlerinizi değiştirin",
  },
  en: {
    subject: ({ locationName, period }) => `${locationName} · your week (${period})`,
    greeting: (name) => (name ? `Hi ${name},` : "Hi,"),
    lead: ({ locationName, period }) => `Here is the week of ${period} at ${locationName}.`,
    quietLead: ({ locationName, period }) => `A quiet week of ${period} at ${locationName}.`,
    quietBody:
      "No new reviews came in this week. Nothing to do — the next digest will have more to say once reviews start arriving again.",
    pulse: (score, delta) =>
      delta ? `Reputation pulse: ${score}/100 (${delta})` : `Reputation pulse: ${score}/100`,
    pulseNone: "Reputation pulse: not enough data yet",
    deltaUp: (value) => `+${value} on last week`,
    deltaDown: (value) => `${value} on last week`,
    deltaFlat: "level with last week",
    reviewCount: (count) => (count === 1 ? "1 review" : `${count} reviews`),
    actionsTitle: "Three things to do this week",
    themesTitle: "What customers talked about",
    themeLine: (label, count, positive, negative) =>
      `${label} — ${count} ${count === 1 ? "review" : "reviews"} (${positive} positive, ${negative} negative)`,
    held: (count) =>
      count === 1
        ? "Also this week: 1 new-review alert you asked us to hold for the digest."
        : `Also this week: ${count} new-review alerts you asked us to hold for the digest.`,
    cta: "Open the full digest",
    footer: "You received this because you are on this team and chose weekly delivery.",
    settings: "Change your notification preferences",
  },
};

/**
 * The window as a reader would say it — "28 Jul – 3 Aug".
 *
 * `periodEnd` is exclusive in the database because that is the only way to
 * express a half-open window without off-by-one arithmetic in every query. A
 * person reading "28 July – 4 August" for a seven-day week would count eight
 * days, so the printed end is the day before.
 */
function formatPeriod(input: DigestEmailInput): string {
  const inclusiveEnd = new Date(input.periodEnd.getTime() - 1);
  const format = new Intl.DateTimeFormat(input.locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

  return `${format.format(input.periodStart)} – ${format.format(inclusiveEnd)}`;
}

function formatDelta(copy: DigestCopy, delta: number | null, locale: Locale): string | null {
  if (delta === null) return null;

  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) return copy.deltaFlat;

  const value = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(rounded);
  return rounded > 0 ? copy.deltaUp(value) : copy.deltaDown(value);
}

export function renderDigestEmail(input: DigestEmailInput): RenderedEmail {
  const copy = DIGEST_COPY[input.locale];
  const period = formatPeriod(input);
  const withPeriod = { ...input, period };
  const greeting = copy.greeting(input.recipientName);

  // A week with no reviews still sends, and says so in one line. Skipping it
  // would make silence ambiguous — a quiet week and a broken pipeline would
  // look identical from the recipient's inbox.
  const quiet = input.reviewCount === 0;
  const lead = quiet ? copy.quietLead(withPeriod) : copy.lead(withPeriod);

  const pulseLine =
    input.pulseScore === null
      ? copy.pulseNone
      : copy.pulse(
          new Intl.NumberFormat(input.locale, { maximumFractionDigits: 0 }).format(
            input.pulseScore,
          ),
          formatDelta(copy, input.pulseDelta, input.locale),
        );

  const themes = input.themes.slice(0, 3);

  const text = [
    greeting,
    "",
    lead,
    "",
    quiet ? copy.quietBody : input.headline,
    ...(quiet ? [] : ["", input.summary]),
    "",
    `${pulseLine} · ${copy.reviewCount(input.reviewCount)}`,
    ...(input.actions.length > 0
      ? [
          "",
          copy.actionsTitle,
          ...input.actions.map((action) => `${action.position}. ${action.text}`),
        ]
      : []),
    ...(themes.length > 0
      ? [
          "",
          copy.themesTitle,
          ...themes.map(
            (theme) =>
              `· ${copy.themeLine(theme.label, theme.count, theme.positive, theme.negative)}`,
          ),
        ]
      : []),
    ...(input.heldCount > 0 ? ["", copy.held(input.heldCount)] : []),
    "",
    input.link,
    "",
    "—",
    copy.footer,
    `${copy.settings}: ${input.settingsUrl}`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;">${escapeHtml(lead)}</p>

      ${
        quiet
          ? `<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#6b7280;">${escapeHtml(copy.quietBody)}</p>`
          : `<p style="margin:0 0 10px;font-size:19px;line-height:1.4;font-weight:600;">${escapeHtml(input.headline)}</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;">${escapeHtml(input.summary)}</p>`
      }

      <div style="background:#f6f7f9;border-radius:8px;padding:14px 16px;margin:0 0 24px;">
        <p style="margin:0;font-size:14px;color:#374151;">${escapeHtml(pulseLine)}</p>
        <p style="margin:4px 0 0;font-size:13px;color:#6b7280;">${escapeHtml(copy.reviewCount(input.reviewCount))}</p>
      </div>
${
  input.actions.length > 0
    ? `
      <p style="margin:0 0 10px;font-size:15px;font-weight:600;">${escapeHtml(copy.actionsTitle)}</p>
      <ol style="margin:0 0 24px;padding-left:20px;font-size:15px;line-height:1.6;">
        ${input.actions
          .map((action) => `<li style="margin:0 0 8px;">${escapeHtml(action.text)}</li>`)
          .join("\n        ")}
      </ol>`
    : ""
}${
    themes.length > 0
      ? `
      <p style="margin:0 0 10px;font-size:15px;font-weight:600;">${escapeHtml(copy.themesTitle)}</p>
      <ul style="margin:0 0 24px;padding-left:20px;font-size:15px;line-height:1.6;color:#374151;">
        ${themes
          .map(
            (theme) =>
              `<li style="margin:0 0 6px;">${escapeHtml(
                copy.themeLine(theme.label, theme.count, theme.positive, theme.negative),
              )}</li>`,
          )
          .join("\n        ")}
      </ul>`
      : ""
  }${
    input.heldCount > 0
      ? `
      <p style="margin:0 0 24px;font-size:14px;line-height:1.5;color:#6b7280;">${escapeHtml(copy.held(input.heldCount))}</p>`
      : ""
  }
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;">${escapeHtml(copy.cta)}</a>
      </p>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 16px;" />
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#6b7280;">${escapeHtml(copy.footer)}</p>
      <p style="margin:0;font-size:12px;color:#6b7280;">
        <a href="${escapeHtml(input.settingsUrl)}" style="color:#6b7280;">${escapeHtml(copy.settings)}</a>
      </p>
    </div>
  </body>
</html>`;

  return { subject: copy.subject(withPeriod), text, html };
}

// ---------------------------------------------------------------------------
// Scheduled report (P3-T5)
// ---------------------------------------------------------------------------

export type ReportEmailInput = {
  locale: Locale;
  recipientName: string | null;
  /** "Kadıköy Kahve — Kadıköy Şubesi", or the organization for an org-wide one. */
  scopeName: string;
  /** "1–7 August 2026", already formatted in the recipient's locale. */
  period: string;
  cadence: "weekly" | "monthly";
  /** Headline figures, preformatted. Null where there was nothing to measure. */
  reviewCount: number;
  averageRating: string | null;
  repliedShare: string | null;
  /** Where to read the same numbers in the app. */
  link: string;
  settingsUrl: string;
  /** What the PDF is called, so the body and the attachment agree. */
  attachmentName: string;
};

type ReportCopy = {
  subject: (input: ReportEmailInput) => string;
  greeting: (name: string | null) => string;
  lead: (input: ReportEmailInput) => string;
  quiet: (input: ReportEmailInput) => string;
  attached: (filename: string) => string;
  figures: string;
  reviews: (count: number) => string;
  rating: (value: string) => string;
  replied: (value: string) => string;
  none: string;
  cta: string;
  footer: string;
  settings: string;
};

/**
 * The email is a covering note, not a second report.
 *
 * Everything worth reading is in the PDF, so the body says what arrived, what
 * period it covers, and the two or three numbers that decide whether the
 * recipient opens the attachment at all. A mail client that hides attachments —
 * or a recipient reading on a phone — still gets something true.
 */
const REPORT_COPY: Record<Locale, ReportCopy> = {
  tr: {
    subject: ({ scopeName, period }) => `${scopeName} raporu · ${period}`,
    greeting: (name) => (name ? `Merhaba ${name},` : "Merhaba,"),
    lead: ({ scopeName, period, cadence }) =>
      `${scopeName} için ${cadence === "weekly" ? "haftalık" : "aylık"} rapor hazır. ` +
      `${period} dönemini kapsıyor.`,
    quiet: ({ period }) =>
      `${period} döneminde hiç yorum gelmedi. Rapor yine de ekte — sessizlik de bir bilgidir.`,
    attached: (filename) => `PDF ekte: ${filename}`,
    figures: "Özet",
    reviews: (count) => `${count} yorum`,
    rating: (value) => `Ortalama puan ${value} / 5`,
    replied: (value) => `Yanıtlanan ${value}`,
    none: "—",
    cta: "İçgörüleri aç",
    footer: "Bu e-postayı, bu raporu düzenli almayı seçtiğiniz için aldınız.",
    settings: "Rapor planınızı değiştirin",
  },
  en: {
    subject: ({ scopeName, period }) => `${scopeName} report · ${period}`,
    greeting: (name) => (name ? `Hi ${name},` : "Hi,"),
    lead: ({ scopeName, period, cadence }) =>
      `Your ${cadence} report for ${scopeName} is ready. It covers ${period}.`,
    quiet: ({ period }) =>
      `No reviews came in during ${period}. The report is attached anyway — a quiet period is ` +
      `information too.`,
    attached: (filename) => `PDF attached: ${filename}`,
    figures: "At a glance",
    reviews: (count) => `${count} reviews`,
    rating: (value) => `Average rating ${value} / 5`,
    replied: (value) => `Replied ${value}`,
    none: "—",
    cta: "Open Insights",
    footer: "You received this because you asked for this report on a schedule.",
    settings: "Change your report schedule",
  },
};

export function renderReportEmail(input: ReportEmailInput): RenderedEmail {
  const copy = REPORT_COPY[input.locale];
  const greeting = copy.greeting(input.recipientName);
  const quiet = input.reviewCount === 0;
  const lead = quiet ? copy.quiet(input) : copy.lead(input);

  const figures = [
    copy.reviews(input.reviewCount),
    input.averageRating ? copy.rating(input.averageRating) : null,
    input.repliedShare ? copy.replied(input.repliedShare) : null,
  ].filter((line): line is string => line !== null);

  const text = [
    greeting,
    "",
    lead,
    "",
    copy.attached(input.attachmentName),
    ...(quiet ? [] : ["", copy.figures, ...figures.map((line) => `· ${line}`)]),
    "",
    input.link,
    "",
    "—",
    copy.footer,
    `${copy.settings}: ${input.settingsUrl}`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;">${escapeHtml(lead)}</p>
      <p style="margin:0 0 24px;font-size:14px;color:#6b7280;">${escapeHtml(copy.attached(input.attachmentName))}</p>
${
  quiet
    ? ""
    : `
      <div style="background:#f6f7f9;border-radius:8px;padding:14px 16px;margin:0 0 24px;">
        <p style="margin:0 0 8px;font-size:14px;font-weight:600;">${escapeHtml(copy.figures)}</p>
        ${figures
          .map(
            (line) =>
              `<p style="margin:0 0 4px;font-size:14px;color:#374151;">${escapeHtml(line)}</p>`,
          )
          .join("\n        ")}
      </div>`
}
      <p style="margin:0 0 28px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:#3d5af1;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(copy.cta)}</a>
      </p>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 16px;">
      <p style="margin:0 0 6px;font-size:12px;color:#6b7280;">${escapeHtml(copy.footer)}</p>
      <p style="margin:0;font-size:12px;color:#6b7280;">
        <a href="${escapeHtml(input.settingsUrl)}" style="color:#6b7280;">${escapeHtml(copy.settings)}</a>
      </p>
    </div>
  </body>
</html>`;

  return { subject: copy.subject(input), text, html };
}

// ---------------------------------------------------------------------------
// Survey invitations (P4-T2)
// ---------------------------------------------------------------------------

/**
 * The invitation to answer an NPS or CSAT survey.
 *
 * A customer-facing message, so it belongs to the same family as the review
 * request at the top of this file rather than to the team alerts: a KVKK
 * reason-for-receipt line and a one-click opt-out are mandatory, and an owner's
 * copy override replaces the body but never the footer.
 *
 * The copy asks the question and nothing else. It does not promise a reward, it
 * does not say what a good answer looks like, and it never mentions leaving a
 * public review — where a review is invited is decided *after* the answer, by
 * `src/surveys/outcome.ts`, identically for everybody. A subject line hinting
 * that happy customers should go to Google would be rating-gating conducted by
 * email.
 */
export type SurveyInviteEmailInput = {
  locale: Locale;
  contactName: string | null;
  businessName: string;
  locationName: string;
  type: "nps" | "csat";
  /** The business's own question, if it wrote one. */
  question: string | null;
  /** The tracked link — /s/{token}. */
  link: string;
  unsubscribeUrl: string;
  overrides?: { subject?: string | undefined; body?: string | undefined };
};

type SurveyCopy = {
  subject: (input: SurveyInviteEmailInput) => string;
  greeting: (name: string | null) => string;
  /** The default question, per instrument. Overridden by the business's own. */
  question: Record<"nps" | "csat", (input: SurveyInviteEmailInput) => string>;
  body: (input: SurveyInviteEmailInput) => string;
  cta: string;
  signOff: (business: string) => string;
  footer: (business: string) => string;
  unsubscribe: string;
};

const SURVEY_COPY: Record<Locale, SurveyCopy> = {
  tr: {
    subject: ({ locationName }) => `${locationName} hakkında tek bir soru`,
    greeting: (name) => (name ? `Merhaba ${name},` : "Merhaba,"),
    question: {
      nps: ({ businessName }) =>
        `${businessName} işletmesini bir arkadaşınıza tavsiye etme ihtimaliniz nedir?`,
      csat: ({ locationName }) => `${locationName} ziyaretinizden ne kadar memnun kaldınız?`,
    },
    body: () =>
      "Yanıtlamak bir dakikanızı bile almaz ve bize gerçekten yardımcı olur. " +
      "Puanınız ne olursa olsun bizim için aynı derecede değerli.",
    cta: "Yanıtlayın",
    signOff: (business) => `Teşekkürler,\n${business}`,
    footer: (business) =>
      `Bu e-postayı, ${business} görüşünüzü sorduğu için aldınız. Kişisel verileriniz yalnızca ` +
      `bu anket için işlenir (KVKK).`,
    unsubscribe: "Bu e-postaları almayı bırakmak için tıklayın",
  },
  en: {
    subject: ({ locationName }) => `One question about ${locationName}`,
    greeting: (name) => (name ? `Hi ${name},` : "Hi,"),
    question: {
      nps: ({ businessName }) => `How likely are you to recommend ${businessName} to a friend?`,
      csat: ({ locationName }) => `How satisfied were you with your visit to ${locationName}?`,
    },
    body: () =>
      "It takes less than a minute and it genuinely helps us. Whatever you score us, " +
      "your answer is equally useful.",
    cta: "Answer",
    signOff: (business) => `Thank you,\n${business}`,
    footer: (business) =>
      `You received this because ${business} asked for your feedback. Your details are processed ` +
      `only for this survey.`,
    unsubscribe: "Unsubscribe from these emails",
  },
};

export function renderSurveyInviteEmail(input: SurveyInviteEmailInput): RenderedEmail {
  const copy = SURVEY_COPY[input.locale];
  const greeting = copy.greeting(input.contactName);
  const question = input.question?.trim() || copy.question[input.type](input);
  const body = input.overrides?.body?.trim() || copy.body(input);
  const subject = input.overrides?.subject?.trim() || copy.subject(input);
  const footer = copy.footer(input.businessName);

  const text = [
    greeting,
    "",
    question,
    "",
    body,
    "",
    input.link,
    "",
    copy.signOff(input.businessName),
    "",
    "—",
    footer,
    `${copy.unsubscribe}: ${input.unsubscribeUrl}`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px;font-size:18px;line-height:1.5;font-weight:600;">${escapeHtml(question)}</p>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${escapeHtml(body)}</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:#3d5af1;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(copy.cta)}</a>
      </p>
      <p style="margin:0;font-size:15px;line-height:1.6;white-space:pre-line;">${escapeHtml(copy.signOff(input.businessName))}</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 16px;" />
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#6b7280;">${escapeHtml(footer)}</p>
      <p style="margin:0;font-size:12px;color:#6b7280;">
        <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#6b7280;">${escapeHtml(copy.unsubscribe)}</a>
      </p>
    </div>
  </body>
</html>`;

  return { subject, text, html };
}
