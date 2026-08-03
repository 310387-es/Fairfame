import type { Locale } from "../../i18n/config.ts";

/**
 * The message templates this product sends (P1b-T3).
 *
 * WhatsApp will not let a business start a conversation with free text. Every
 * business-initiated message is a **template that Meta approved in advance**,
 * identified by name and language, with positional variables. That constraint
 * shapes the whole outbound design: copy cannot be composed at send time, and a
 * wording change is a submission with a review queue behind it, not a deploy.
 *
 * So the registry lives here, in code, as the single source of truth for what
 * we have asked Meta to approve. It carries the exact body text alongside the
 * variable list for one reason: when a template is rejected or edited in the
 * Business Manager, the diff has to be visible in a pull request rather than
 * discovered by a customer receiving the wrong sentence.
 *
 * **Nothing here is approved yet.** Approval requires a WhatsApp Business
 * Account, which requires the company. `status` records where each one stands
 * so the go-live suite (T6) has a checklist rather than a guess.
 */

export type TemplateStatus = "draft" | "submitted" | "approved" | "rejected";

export type TemplateDefinition = {
  /** The name registered with Meta. Lower snake case is their constraint. */
  name: string;
  /** What the variables mean, in order. `{{1}}` is `variables[0]`. */
  variables: string[];
  /** The exact body submitted for approval, per language. */
  body: Record<Locale, string>;
  /**
   * Meta's category. `MARKETING` needs opt-in and is billed differently from
   * `UTILITY`; misdeclaring it is a policy violation, not a billing quirk.
   */
  category: "MARKETING" | "UTILITY";
  status: TemplateStatus;
};

/**
 * Review requests.
 *
 * `MARKETING` deliberately, though it is tempting to call a review request a
 * utility message. It is unsolicited, it promotes the business, and Meta's own
 * guidance puts it here — declaring it `UTILITY` to dodge opt-in is precisely
 * the shortcut that gets a number banned.
 *
 * The copy asks for an honest account and never conditions anything on how good
 * the experience was, matching `src/messaging/templates.ts`. Rating-gating is
 * forbidden everywhere, including in a channel where nobody would see it.
 */
export const REVIEW_REQUEST_TEMPLATE: TemplateDefinition = {
  name: "review_request_v1",
  variables: ["customer name", "location name", "review link"],
  category: "MARKETING",
  status: "draft",
  body: {
    tr:
      "Merhaba {{1}}, {{2}} ziyaretiniz için teşekkür ederiz. Deneyiminizi bir dakikada " +
      "paylaşmak isterseniz: {{3}}\n\nGörüşünüz olumlu da olsa olumsuz da olsa bizim için " +
      "aynı derecede değerli. Bu mesajları almak istemiyorsanız STOP yazmanız yeterli.",
    en:
      "Hi {{1}}, thank you for visiting {{2}}. If you have a minute, we would love to hear " +
      "how it went: {{3}}\n\nGood or bad, your feedback is equally useful to us. Reply STOP " +
      "to stop receiving these messages.",
  },
};

/**
 * The weekly Action Digest, delivered to an owner's own number.
 *
 * `UTILITY` and honestly so: the recipient is a subscriber of the product
 * asking for their own data, not a consumer being marketed at. The digest body
 * itself is far too long for a template variable, so this carries the headline
 * and a link rather than the briefing.
 */
export const DIGEST_TEMPLATE: TemplateDefinition = {
  name: "weekly_digest_v1",
  variables: ["location name", "headline", "digest link"],
  category: "UTILITY",
  status: "draft",
  body: {
    tr: "{{1}} için haftalık planınız hazır.\n\n{{2}}\n\nTamamı: {{3}}",
    en: "Your weekly plan for {{1}} is ready.\n\n{{2}}\n\nRead it here: {{3}}",
  },
};

/**
 * A new-review alert.
 *
 * `UTILITY`, same reasoning as the digest: it goes to the business about its own
 * account, not to a consumer.
 */
export const REVIEW_ALERT_TEMPLATE: TemplateDefinition = {
  name: "review_alert_v1",
  variables: ["location name", "rating", "excerpt", "inbox link"],
  category: "UTILITY",
  status: "draft",
  body: {
    tr: "{{1}} için yeni bir yorum geldi ({{2}}★):\n\n“{{3}}”\n\nYanıtlamak için: {{4}}",
    en: "New review for {{1}} ({{2}}★):\n\n“{{3}}”\n\nReply here: {{4}}",
  },
};

export const TEMPLATES = {
  [REVIEW_REQUEST_TEMPLATE.name]: REVIEW_REQUEST_TEMPLATE,
  [DIGEST_TEMPLATE.name]: DIGEST_TEMPLATE,
  [REVIEW_ALERT_TEMPLATE.name]: REVIEW_ALERT_TEMPLATE,
} as const satisfies Record<string, TemplateDefinition>;

export type TemplateName = keyof typeof TEMPLATES;

/**
 * Fills a template's variables, checking the count.
 *
 * A mismatch is caught here rather than by Meta, because their error for it is
 * a generic 400 and the send has already been attempted by then. Variables are
 * also stripped of newlines: WhatsApp rejects a parameter containing one, and
 * a review excerpt very often does.
 */
export function renderTemplate(
  template: TemplateDefinition,
  locale: Locale,
  values: string[],
): { body: string; parameters: string[] } {
  if (values.length !== template.variables.length) {
    throw new Error(
      `Template ${template.name} expects ${template.variables.length} variables ` +
        `(${template.variables.join(", ")}), received ${values.length}.`,
    );
  }

  const parameters = values.map((value) => value.replace(/\s+/g, " ").trim());

  const body = parameters.reduce(
    (text, value, index) => text.replaceAll(`{{${index + 1}}}`, value),
    template.body[locale],
  );

  return { body, parameters };
}

/** Templates still needing Meta approval — the T6 go-live checklist. */
export function pendingTemplates(): TemplateDefinition[] {
  return Object.values(TEMPLATES).filter((template) => template.status !== "approved");
}
