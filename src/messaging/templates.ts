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
  <body style="margin:0;padding:24px;background:#f6f7fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#10193a;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${escapeHtml(body)}</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:#10193a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;">${escapeHtml(copy.cta)}</a>
      </p>
      <p style="margin:0;font-size:15px;line-height:1.6;white-space:pre-line;">${escapeHtml(copy.signOff(input.businessName))}</p>
      <hr style="border:none;border-top:1px solid #e7eaf3;margin:28px 0 16px;" />
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#666e88;">${escapeHtml(footer)}</p>
      <p style="margin:0;font-size:12px;color:#666e88;">
        <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#666e88;">${escapeHtml(copy.unsubscribe)}</a>
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

  const accent = input.urgent ? "#c42b4c" : "#10193a";

  const html = `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:24px;background:#f6f7fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#10193a;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:${accent};">${escapeHtml(lead)}</p>
      <div style="border-left:3px solid ${accent};padding:4px 0 4px 16px;margin:0 0 24px;">
        <p style="margin:0 0 6px;font-size:13px;color:#666e88;">${escapeHtml([stars, byline].filter(Boolean).join("  "))}</p>
        <p style="margin:0;font-size:15px;line-height:1.6;">${escapeHtml(body)}</p>
      </div>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;">${escapeHtml(copy.cta)}</a>
      </p>
      <hr style="border:none;border-top:1px solid #e7eaf3;margin:28px 0 16px;" />
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#666e88;">${escapeHtml(copy.footer)}</p>
      <p style="margin:0;font-size:12px;color:#666e88;">
        <a href="${escapeHtml(input.settingsUrl)}" style="color:#666e88;">${escapeHtml(copy.settings)}</a>
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
 * `/reviews?review=undefined`. The sender now refuses that shape — and this is
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
  const accent = input.kind === "sla" ? "#c42b4c" : "#10193a";

  const html = `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:24px;background:#f6f7fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#10193a;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 8px;font-size:32px;font-weight:600;color:${accent};">${input.count}</p>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${escapeHtml(lead)}</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;">${escapeHtml(copy.cta)}</a>
      </p>
      <hr style="border:none;border-top:1px solid #e7eaf3;margin:28px 0 16px;" />
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#666e88;">${escapeHtml(copy.footer)}</p>
      <p style="margin:0;font-size:12px;color:#666e88;">
        <a href="${escapeHtml(input.settingsUrl)}" style="color:#666e88;">${escapeHtml(copy.settings)}</a>
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
  /**
   * The three recommendations, each carrying what it rests on (W2.1).
   *
   * The email used to render these as three bare sentences in an `<ol>` while
   * the screen showed a customer's own words and a link to the exact reviews —
   * so the surface most owners actually read was the one that asked to be taken
   * on trust. `quote` and `link` are optional because a digest composed before
   * W1.6 stored no citations, and a sentence without its evidence is still
   * worth sending.
   */
  actions: {
    position: number;
    text: string;
    quote: { text: string; rating: number | null } | null;
    /** The Inbox, pinned to exactly the reviews cited. */
    link: string | null;
    reviewCount: number;
  }[];
  themes: { label: string; count: number; positive: number; negative: number }[];
  /**
   * How last week's three ended up, or null before there is a last week.
   *
   * From the stored payload rather than a live count, and that is the right
   * source *here* specifically: an email is frozen the moment it is sent, so a
   * number read at send time stays true to what it claimed. The screen's
   * equivalent card reads live, because it can.
   */
  priorOutcome: { done: number; total: number } | null;
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

/**
 * **The palette here is literal hex, and it must still be the brand's.**
 *
 * Email clients do not support custom properties, so `var(--ink-800)` is not
 * available and every colour has to be written out — the same exemption
 * `src/widgets/theme.ts` has, for the same reason. What is *not* exempt is
 * which colours they are.
 *
 * Until 7 Aug 2026 these were Tailwind's stock defaults: `#6b7280` for muted
 * text, `#111827` for ink, `#e5e7eb` for hairlines — and, in the digest,
 * **`#4f46e5` for links, which is Tailwind's indigo-600 and not Fairfame's
 * `#3d5af1`**. Two different indigos in one email, four pixels of hue apart,
 * neither obviously wrong on its own. That is what a hand-copied palette looks
 * like after a few months.
 *
 * Muted text is `--ink-350` (#666e88) rather than the `--ink-400` (#6b7391)
 * that the app uses for the same role, and that is deliberate: several of these
 * blocks sit on `--surface-sunken` rather than white, where `--ink-400` is
 * **4.37:1** and illegal (docs/15, the contrast table). `--ink-350` clears AA on
 * both — 5.06:1 on white, 4.73:1 on the tint — so one value is safe wherever a
 * template puts it, which is worth more here than matching the app exactly.
 * A template has no layout engine to check it with.
 *
 * `tests/lib/email-palette.test.ts` pins every hex in this file to a token in
 * `globals.css`, so the next colour typed by hand fails rather than ships.
 */

/**
 * **This copy is hardcoded, and that is how it drifted.**
 *
 * W3.3 settled that the 0-100 figure is called **Reputation score** everywhere
 * — one number, one name — and renamed it across the app, the digest screen and
 * the public sample, all of which read `digest.pulse` from the message
 * catalogue. This map does not, so the email kept saying "Reputation pulse" /
 * "İtibar nabzı" for four days: the product's own headline feature, arriving in
 * somebody's inbox under a name that appears nowhere else in it.
 *
 * It survived because an email is the one surface with no way to look at it —
 * a template only renders when the event behind it happens, which is exactly
 * why `pnpm email:preview` exists. It was found by running it.
 *
 * The hardcoding itself stays: these templates are sent from the worker, which
 * has no `next-intl` request context. But **a copy change in the app now means
 * grepping here too**, and the identifier is still `pulse` on purpose — the
 * code name did not move (docs/21 §1, same rule that keeps `src/digest` against
 * a `/weekly-plan` route). Only the words a customer reads did.
 */
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
  /** The link under each action — "See the 3 reviews behind this". */
  evidence: (count: number) => string;
  /** Follow-through on the previous briefing, above the new one. */
  priorOutcome: (done: number, total: number) => string;
  pulseLabel: string;
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
      delta ? `İtibar puanı: ${score}/100 (${delta})` : `İtibar puanı: ${score}/100`,
    pulseNone: "İtibar puanı: henüz hesaplanamadı",
    deltaUp: (value) => `geçen haftaya göre +${value}`,
    deltaDown: (value) => `geçen haftaya göre ${value}`,
    deltaFlat: "geçen haftayla aynı",
    reviewCount: (count) => `${count} yorum`,
    actionsTitle: "Bu hafta yapılacak üç şey",
    evidence: (count) => (count === 1 ? "Dayandığı yorumu gör" : `Dayandığı ${count} yorumu gör`),
    priorOutcome: (done, total) =>
      `Geçen haftanın ${total} eyleminin ${done} tanesini tamamladınız.`,
    pulseLabel: "İtibar puanı",
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
      delta ? `Reputation score: ${score}/100 (${delta})` : `Reputation score: ${score}/100`,
    pulseNone: "Reputation score: not enough data yet",
    deltaUp: (value) => `+${value} on last week`,
    deltaDown: (value) => `${value} on last week`,
    deltaFlat: "level with last week",
    reviewCount: (count) => (count === 1 ? "1 review" : `${count} reviews`),
    actionsTitle: "Three things to do this week",
    evidence: (count) =>
      count === 1 ? "See the review behind this" : `See the ${count} reviews behind this`,
    priorOutcome: (done, total) => `You completed ${done} of last week's ${total} actions.`,
    pulseLabel: "Reputation score",
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

/**
 * One recommendation, with what it rests on.
 *
 * A table rather than a div, because Outlook's word-processor rendering engine
 * ignores most box model CSS on a `<div>` but honours a table cell — the
 * numbered column beside the text is the kind of layout that silently collapses
 * into a stack everywhere it is not a table.
 *
 * The quote is set apart with a left border and italics, the same treatment it
 * gets on screen, and it is **the customer's words verbatim** — which is
 * untrusted input arriving in somebody's mail client, so it is escaped like
 * everything else here.
 */
function renderActionCard(action: DigestEmailInput["actions"][number], copy: DigestCopy): string {
  const evidence = action.link
    ? `<p style="margin:8px 0 0;font-size:13px;line-height:1.5;">
              <a href="${escapeHtml(action.link)}" style="color:#3d5af1;text-decoration:none;">${escapeHtml(copy.evidence(action.reviewCount))} →</a>
            </p>`
    : "";

  const quote = action.quote
    ? // The rule is `--ink-300` (#8b93ac), not the `--line` (#e7eaf3) used
      // elsewhere: this one sits on the card's own `--surface-sunken` rather
      // than on white, and against that a hairline was invisible — the quote
      // read as an unattributed second sentence.
      `<p style="margin:10px 0 0;padding:0 0 0 12px;border-left:3px solid #8b93ac;font-size:14px;line-height:1.55;color:#3a4260;font-style:italic;">
              ${escapeHtml(stars(action.quote.rating))}${escapeHtml(`“${action.quote.text}”`)}
            </p>`
    : "";

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 12px;background:#f5f7fa;border-radius:10px;">
        <tr>
          <td width="34" valign="top" style="padding:16px 0 16px 16px;">
            <div style="width:24px;height:24px;border-radius:12px;background:#eef1fe;color:#3d5af1;font-size:13px;font-weight:700;line-height:24px;text-align:center;">${action.position}</div>
          </td>
          <td valign="top" style="padding:16px 16px 16px 10px;">
            <p style="margin:0;font-size:15px;line-height:1.5;font-weight:600;color:#10193a;">${escapeHtml(action.text)}</p>
            ${quote}
            ${evidence}
          </td>
        </tr>
      </table>`;
}

/**
 * A rating as filled and empty stars, with a trailing space.
 *
 * `★★☆☆☆` rather than "2/5" because it is read at a glance next to a quote, and
 * because it is the one piece of the on-screen card an email can reproduce
 * exactly. Empty for an unrated review — a DM or a comment has no stars, and
 * five hollow ones would read as zero rather than as absent.
 */
function stars(rating: number | null): string {
  if (rating === null) return "";
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  return `${"★".repeat(filled)}${"☆".repeat(5 - filled)} `;
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

  /**
   * The pulse as a figure, not a sentence.
   *
   * It was a 14px grey line reading "Reputation pulse: 86/100 (+5.2 on last
   * week)" — a number the screen gives a dial to, buried in the one paragraph a
   * reader skips. An email cannot draw a dial, but it can make the number the
   * size of a number. The delta keeps its colour from its direction, and the
   * review count sits under it as the sample the score is drawn from.
   */
  const deltaText = formatDelta(copy, input.pulseDelta, input.locale);
  const deltaColour =
    input.pulseDelta === null || Math.round(input.pulseDelta * 10) === 0
      ? "#666e88"
      : input.pulseDelta > 0
        ? "#0b7d57"
        : "#c42b4c";

  const pulseBlock =
    input.pulseScore === null
      ? `<div style="background:#f6f7fb;border-radius:10px;padding:14px 16px;margin:0 0 24px;">
        <p style="margin:0;font-size:14px;color:#666e88;">${escapeHtml(copy.pulseNone)}</p>
      </div>`
      : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px;background:#f6f7fb;border-radius:10px;">
        <tr>
          <td valign="middle" style="padding:16px;">
            <p style="margin:0;font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#666e88;">${escapeHtml(copy.pulseLabel)}</p>
            <p style="margin:2px 0 0;font-size:15px;color:#666e88;">${escapeHtml(copy.reviewCount(input.reviewCount))}</p>
          </td>
          <td valign="middle" align="right" style="padding:16px;">
            <p style="margin:0;font-size:30px;line-height:1.1;font-weight:700;color:#10193a;">${escapeHtml(
              new Intl.NumberFormat(input.locale, { maximumFractionDigits: 0 }).format(
                input.pulseScore,
              ),
            )}<span style="font-size:15px;font-weight:400;color:#666e88;">/100</span></p>
            ${deltaText ? `<p style="margin:2px 0 0;font-size:13px;color:${deltaColour};">${escapeHtml(deltaText)}</p>` : ""}
          </td>
        </tr>
      </table>`;

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
          // The plain-text part carries the evidence too. It is what a screen
          // reader in text mode gets, and what survives a client that refuses
          // HTML — dropping the quote there would make the accessible version
          // the one that asks to be taken on trust.
          ...input.actions.flatMap((action) => [
            `${action.position}. ${action.text}`,
            ...(action.quote ? [`   "${action.quote.text}"`] : []),
            ...(action.link ? [`   ${copy.evidence(action.reviewCount)}: ${action.link}`] : []),
          ]),
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
    ...(input.priorOutcome
      ? ["", copy.priorOutcome(input.priorOutcome.done, input.priorOutcome.total)]
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
  <body style="margin:0;padding:24px;background:#f6f7fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#10193a;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;">${escapeHtml(lead)}</p>

      ${
        quiet
          ? `<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#666e88;">${escapeHtml(copy.quietBody)}</p>`
          : `<p style="margin:0 0 10px;font-size:19px;line-height:1.4;font-weight:600;">${escapeHtml(input.headline)}</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;">${escapeHtml(input.summary)}</p>`
      }

      ${pulseBlock}
${
  input.actions.length > 0
    ? `
      <p style="margin:0 0 12px;font-size:15px;font-weight:600;">${escapeHtml(copy.actionsTitle)}</p>
      ${input.actions.map((action) => renderActionCard(action, copy)).join("\n      ")}`
    : ""
}${
    input.priorOutcome
      ? `
      <p style="margin:0 0 24px;font-size:14px;line-height:1.5;color:#666e88;">${escapeHtml(
        copy.priorOutcome(input.priorOutcome.done, input.priorOutcome.total),
      )}</p>`
      : ""
  }${
    themes.length > 0
      ? `
      <p style="margin:0 0 10px;font-size:15px;font-weight:600;">${escapeHtml(copy.themesTitle)}</p>
      <ul style="margin:0 0 24px;padding-left:20px;font-size:15px;line-height:1.6;color:#3a4260;">
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
      <p style="margin:0 0 24px;font-size:14px;line-height:1.5;color:#666e88;">${escapeHtml(copy.held(input.heldCount))}</p>`
      : ""
  }
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:#10193a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;">${escapeHtml(copy.cta)}</a>
      </p>

      <hr style="border:none;border-top:1px solid #e7eaf3;margin:28px 0 16px;" />
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#666e88;">${escapeHtml(copy.footer)}</p>
      <p style="margin:0;font-size:12px;color:#666e88;">
        <a href="${escapeHtml(input.settingsUrl)}" style="color:#666e88;">${escapeHtml(copy.settings)}</a>
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
  <body style="margin:0;padding:24px;background:#f6f7fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#10193a;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;">${escapeHtml(lead)}</p>
      <p style="margin:0 0 24px;font-size:14px;color:#666e88;">${escapeHtml(copy.attached(input.attachmentName))}</p>
${
  quiet
    ? ""
    : `
      <div style="background:#f6f7fb;border-radius:8px;padding:14px 16px;margin:0 0 24px;">
        <p style="margin:0 0 8px;font-size:14px;font-weight:600;">${escapeHtml(copy.figures)}</p>
        ${figures
          .map(
            (line) =>
              `<p style="margin:0 0 4px;font-size:14px;color:#3a4260;">${escapeHtml(line)}</p>`,
          )
          .join("\n        ")}
      </div>`
}
      <p style="margin:0 0 28px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:#3d5af1;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(copy.cta)}</a>
      </p>

      <hr style="border:none;border-top:1px solid #e7eaf3;margin:0 0 16px;">
      <p style="margin:0 0 6px;font-size:12px;color:#666e88;">${escapeHtml(copy.footer)}</p>
      <p style="margin:0;font-size:12px;color:#666e88;">
        <a href="${escapeHtml(input.settingsUrl)}" style="color:#666e88;">${escapeHtml(copy.settings)}</a>
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
  <body style="margin:0;padding:24px;background:#f6f7fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#10193a;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px;font-size:18px;line-height:1.5;font-weight:600;">${escapeHtml(question)}</p>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${escapeHtml(body)}</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:#3d5af1;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(copy.cta)}</a>
      </p>
      <p style="margin:0;font-size:15px;line-height:1.6;white-space:pre-line;">${escapeHtml(copy.signOff(input.businessName))}</p>
      <hr style="border:none;border-top:1px solid #e7eaf3;margin:28px 0 16px;" />
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#666e88;">${escapeHtml(footer)}</p>
      <p style="margin:0;font-size:12px;color:#666e88;">
        <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#666e88;">${escapeHtml(copy.unsubscribe)}</a>
      </p>
    </div>
  </body>
</html>`;

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Team invitation (W1.9)
// ---------------------------------------------------------------------------

export type InvitationEmailInput = {
  locale: Locale;
  /** Who is asking, so the recipient knows why this landed. */
  inviterName: string;
  businessName: string;
  /** In the recipient's language, already translated by the caller. */
  roleLabel: string;
  link: string;
  expiresAt: Date;
};

const INVITE_COPY: Record<
  Locale,
  {
    subject: (input: InvitationEmailInput) => string;
    lead: (input: InvitationEmailInput) => string;
    role: (input: InvitationEmailInput) => string;
    cta: string;
    expiry: (input: InvitationEmailInput) => string;
    ignore: string;
  }
> = {
  tr: {
    subject: (input) => `${input.businessName} sizi ekibine davet ediyor`,
    lead: (input) =>
      `${input.inviterName}, ${input.businessName} hesabında sizinle çalışmak istiyor.`,
    role: (input) => `Rolünüz: ${input.roleLabel}.`,
    cta: "Daveti kabul et",
    expiry: (input) =>
      `Bu davet ${input.expiresAt.toLocaleDateString("tr-TR", { day: "numeric", month: "long" })} tarihine kadar geçerli.`,
    ignore: "Bunu beklemiyorduysanız, bu e-postayı yok sayabilirsiniz.",
  },
  en: {
    subject: (input) => `${input.businessName} invited you to their team`,
    lead: (input) =>
      `${input.inviterName} would like you to work with them on ${input.businessName}.`,
    role: (input) => `Your role: ${input.roleLabel}.`,
    cta: "Accept invitation",
    expiry: (input) =>
      `This invitation is good until ${input.expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}.`,
    ignore: "If you were not expecting this, you can ignore this email.",
  },
};

/**
 * The email that makes a team a team (W1.9).
 *
 * **No unsubscribe footer, deliberately.** Every other template in this file
 * carries one because it is a *commercial* message to a customer and Turkish
 * law says so. This is a one-off, person-to-person request to join a workspace
 * — closer to a password reset than to marketing — and there is no ongoing
 * subscription to opt out of. Offering one would imply a list they are on.
 *
 * It also never goes through `checkSendAllowed`: the consent gate governs
 * messages to *customers*, and demanding an İYS permission before a business
 * can invite its own manager is a misreading of the regime. That classification
 * is asserted in `tests/lib/outbound-consent.test.ts` rather than left implied.
 */
export function renderInvitationEmail(input: InvitationEmailInput): RenderedEmail {
  const copy = INVITE_COPY[input.locale];

  const text = [
    copy.lead(input),
    copy.role(input),
    "",
    input.link,
    "",
    copy.expiry(input),
    copy.ignore,
  ].join("\n");

  const html = `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:24px;background:#f6f7fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#10193a;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:18px;line-height:1.5;font-weight:600;">${escapeHtml(copy.lead(input))}</p>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${escapeHtml(copy.role(input))}</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:#3d5af1;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(copy.cta)}</a>
      </p>
      <hr style="border:none;border-top:1px solid #e7eaf3;margin:28px 0 16px;" />
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#666e88;">${escapeHtml(copy.expiry(input))}</p>
      <p style="margin:0;font-size:12px;line-height:1.5;color:#666e88;">${escapeHtml(copy.ignore)}</p>
    </div>
  </body>
</html>`;

  return { subject: copy.subject(input), text, html };
}

// ---------------------------------------------------------------------------
// Password reset (W1.9b)
// ---------------------------------------------------------------------------

export type PasswordResetEmailInput = {
  locale: Locale;
  /** What to call them. Falls back to the address when there is no name. */
  name: string;
  link: string;
  /** How long the link is good for, in minutes — stated, not implied. */
  expiresInMinutes: number;
};

const RESET_COPY: Record<
  Locale,
  {
    subject: string;
    lead: (input: PasswordResetEmailInput) => string;
    cta: string;
    expiry: (input: PasswordResetEmailInput) => string;
    ignore: string;
  }
> = {
  tr: {
    subject: "Fairfame parolanızı sıfırlayın",
    lead: (input) =>
      `Merhaba ${input.name}, yeni bir parola belirlemek için aşağıdaki bağlantıyı kullanın.`,
    cta: "Yeni parola belirle",
    expiry: (input) => `Bu bağlantı ${input.expiresInMinutes} dakika geçerli.`,
    ignore: "Bu isteği siz yapmadıysanız hiçbir şey yapmanıza gerek yok — parolanız değişmedi.",
  },
  en: {
    subject: "Reset your Fairfame password",
    lead: (input) => `Hello ${input.name}, use the link below to set a new password.`,
    cta: "Set a new password",
    expiry: (input) => `This link is good for ${input.expiresInMinutes} minutes.`,
    ignore: "If you did not ask for this, there is nothing to do — your password has not changed.",
  },
};

/**
 * The way back into an account (W1.9b).
 *
 * **The one email whose absence locks somebody out permanently.** Until this,
 * `emailAndPassword` had no `sendResetPassword` callback, so BetterAuth refused
 * the endpoint outright with `RESET_PASSWORD_DISABLED` — a teammate invited in
 * W1.9 who forgot their twelve-character password had no route back in, and
 * neither did the person who invited them.
 *
 * No unsubscribe footer and no consent gate, for the same reason as the
 * invitation: this is a transactional reply to something the recipient just
 * asked for. It is the clearest case in the product of a message that is not
 * marketing.
 *
 * **It says what to do if you did not ask.** A password-reset email is also
 * what somebody sees when a stranger types their address into a login form, and
 * "your password has not changed" is the sentence that stops that being
 * alarming.
 */
export function renderPasswordResetEmail(input: PasswordResetEmailInput): RenderedEmail {
  const copy = RESET_COPY[input.locale];

  const text = [copy.lead(input), "", input.link, "", copy.expiry(input), copy.ignore].join("\n");

  const html = `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:24px;background:#f6f7fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#10193a;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${escapeHtml(copy.lead(input))}</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:#3d5af1;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(copy.cta)}</a>
      </p>
      <hr style="border:none;border-top:1px solid #e7eaf3;margin:28px 0 16px;" />
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#666e88;">${escapeHtml(copy.expiry(input))}</p>
      <p style="margin:0;font-size:12px;line-height:1.5;color:#666e88;">${escapeHtml(copy.ignore)}</p>
    </div>
  </body>
</html>`;

  return { subject: copy.subject, text, html };
}

// ---------------------------------------------------------------------------
// Address verification (P5-T4)
// ---------------------------------------------------------------------------

export type VerifyEmailEmailInput = {
  locale: Locale;
  /** What to call them. Falls back to the address when there is no name. */
  name: string;
  link: string;
  /** How long the link is good for, in hours — stated, not implied. */
  expiresInHours: number;
};

const VERIFY_COPY: Record<
  Locale,
  {
    subject: string;
    lead: (input: VerifyEmailEmailInput) => string;
    /** What confirming unlocks. The reason to bother, said plainly. */
    why: string;
    cta: string;
    expiry: (input: VerifyEmailEmailInput) => string;
    ignore: string;
  }
> = {
  tr: {
    subject: "Fairfame e-posta adresinizi doğrulayın",
    lead: (input) =>
      `Merhaba ${input.name}, Fairfame hesabınızı bu adresle açtınız. Adresin size ait ` +
      `olduğunu doğrulamak için aşağıdaki bağlantıya tıklayın.`,
    why:
      "Doğrulamadan da Fairfame'i kullanmaya devam edebilirsiniz. Yalnızca başkalarına " +
      "gönderim yapan işlemler — yorum daveti, toplu gönderim ve ekip daveti — adres " +
      "doğrulanana kadar bekler.",
    cta: "Adresimi doğrula",
    expiry: (input) => `Bu bağlantı ${input.expiresInHours} saat geçerli.`,
    ignore: "Bu hesabı siz açmadıysanız hiçbir şey yapmanıza gerek yok.",
  },
  en: {
    subject: "Verify your Fairfame email address",
    lead: (input) =>
      `Hello ${input.name}, your Fairfame account was opened with this address. ` +
      `Use the link below to confirm it is yours.`,
    why:
      "You can keep using Fairfame without confirming. Only the things that write to " +
      "other people — review invitations, broadcasts and team invitations — wait until " +
      "the address is verified.",
    cta: "Verify my address",
    expiry: (input) => `This link is good for ${input.expiresInHours} hours.`,
    ignore: "If you did not open this account, there is nothing to do.",
  },
};

/**
 * Proving the address (P5-T4).
 *
 * **It says what verifying is *for*, which is the whole reason it gets opened.**
 * The product does not stand in the doorway demanding this — `src/auth/config.ts`
 * keeps `requireEmailVerification: false` so the first session is unblocked —
 * and an email that asks for a click without saying why is one somebody
 * reasonably ignores. What it actually unlocks is naming: review invitations,
 * broadcasts and team invitations, the three things that put mail in somebody
 * else's inbox. A reader who has no plans to send anything can ignore this
 * safely, and the copy tells them so rather than implying an ultimatum.
 *
 * No unsubscribe footer and no consent gate, on the same grounds as the reset
 * and the invitation: this is a transactional reply to an account that has just
 * been created, not a list anybody is on. `marketing_email_consent` is a
 * different question and is deliberately not consulted — declining a newsletter
 * must never be able to strand somebody with an unverifiable address.
 *
 * **The address is never printed in the body.** It is already in the To: line,
 * and repeating an address back at whoever received it is the shape a phishing
 * template takes.
 */
export function renderVerifyEmailEmail(input: VerifyEmailEmailInput): RenderedEmail {
  const copy = VERIFY_COPY[input.locale];

  const text = [
    copy.lead(input),
    "",
    input.link,
    "",
    copy.why,
    "",
    copy.expiry(input),
    copy.ignore,
  ].join("\n");

  const html = `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:24px;background:#f6f7fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#10193a;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${escapeHtml(copy.lead(input))}</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background:#3d5af1;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(copy.cta)}</a>
      </p>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#10193a;">${escapeHtml(copy.why)}</p>
      <hr style="border:none;border-top:1px solid #e7eaf3;margin:28px 0 16px;" />
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#666e88;">${escapeHtml(copy.expiry(input))}</p>
      <p style="margin:0;font-size:12px;line-height:1.5;color:#666e88;">${escapeHtml(copy.ignore)}</p>
    </div>
  </body>
</html>`;

  return { subject: copy.subject, text, html };
}
