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
  /** Deep link into the Inbox. */
  link: string;
  /** Where to change what arrives. Not an unsubscribe — this is not marketing. */
  settingsUrl: string;
};

type AlertCopy = {
  subject: (input: ReviewAlertEmailInput) => string;
  greeting: (name: string | null) => string;
  lead: (input: ReviewAlertEmailInput) => string;
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
    greeting: (name) => (name ? `Merhaba ${name},` : "Merhaba,"),
    lead: ({ locationName }) => `${locationName} için yeni bir yorum geldi.`,
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
    greeting: (name) => (name ? `Hi ${name},` : "Hi,"),
    lead: ({ locationName }) => `A new review just came in for ${locationName}.`,
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
  const lead = input.urgent ? copy.urgentLead(input) : copy.lead(input);
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

  return { subject: copy.subject(input), text, html };
}
