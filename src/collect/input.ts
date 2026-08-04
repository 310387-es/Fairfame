import { z } from "zod";
import { LOCALES } from "../i18n/config.ts";

/**
 * Every input that crosses into the collection module, validated in one place.
 *
 * Two audiences with very different trust levels: an authenticated owner
 * creating a campaign, and an anonymous visitor posting a review from a QR
 * code. The second is the reason the submission schema is strict about
 * lengths — it is the only unauthenticated write path in the product.
 */

/** Channels a send can actually go out on today. */
export const SENDABLE_CHANNELS = ["email"] as const;

/**
 * `link` is the QR / short-link campaign: nothing is sent, people arrive on
 * their own. `sms` and `whatsapp` exist in the enum but are refused until
 * their connectors and the İYS gate land (P1b-T3/T5).
 */
export const createCampaignSchema = z
  .object({
    locationId: z.uuid(),
    name: z.string().trim().min(1, "A campaign name is required.").max(120),
    channel: z.enum(["email", "link"]).default("email"),
    destination: z.enum(["firstparty", "external"]).default("firstparty"),
    destinationUrl: z
      .string()
      .trim()
      .max(2_048)
      .nullish()
      .transform((value) => (value == null || value === "" ? null : value)),
    locale: z.enum(LOCALES).nullish().default(null),
    subject: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .transform((value) => (value == null || value === "" ? null : value)),
    body: z
      .string()
      .trim()
      .max(2_000)
      .nullish()
      .transform((value) => (value == null || value === "" ? null : value)),
  })
  .superRefine((value, ctx) => {
    if (value.destination !== "external") return;

    if (!value.destinationUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["destinationUrl"],
        message: "An external campaign needs the platform URL to send people to.",
      });
      return;
    }

    // Anything but http(s) in a link we email to customers is a phishing
    // vector, so the scheme is allow-listed rather than merely parsed.
    const parsed = z.url().safeParse(value.destinationUrl);
    if (!parsed.success || !/^https?:\/\//i.test(value.destinationUrl)) {
      ctx.addIssue({
        code: "custom",
        path: ["destinationUrl"],
        message: "The destination must be an http(s) URL.",
      });
    }
  });

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export function parseCreateCampaign(formData: FormData) {
  return createCampaignSchema.safeParse({
    locationId: formData.get("locationId"),
    name: formData.get("name"),
    channel: formData.get("channel") ?? undefined,
    destination: formData.get("destination") ?? undefined,
    destinationUrl: formData.get("destinationUrl"),
    locale: formData.get("locale") || null,
    subject: formData.get("subject"),
    body: formData.get("body"),
  });
}

export const recipientSchema = z.object({
  email: z.email({ message: "That is not a valid email address." }).max(254),
  name: z
    .string()
    .trim()
    .max(120)
    .nullish()
    .transform((value) => (value == null || value === "" ? null : value)),
});

export type Recipient = z.infer<typeof recipientSchema>;

/** One send should not be able to become a mailing blast by accident. */
export const MAX_RECIPIENTS_PER_SEND = 200;

export const sendRequestsSchema = z.object({
  campaignId: z.uuid(),
  recipients: z.array(recipientSchema).min(1).max(MAX_RECIPIENTS_PER_SEND),
});

/**
 * Turns a pasted block of addresses into recipients.
 *
 * Accepts newline-, comma- and semicolon-separated lists, and the
 * `Name <email@example.com>` form people paste out of their mail client.
 * Invalid entries are returned rather than dropped: silently ignoring a
 * mistyped address means an owner believes they asked someone they did not.
 */
export function parseRecipientList(raw: string): { recipients: Recipient[]; invalid: string[] } {
  const recipients: Recipient[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(/[\n,;]+/)) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;

    const angled = /^(.*?)<([^>]+)>$/.exec(trimmed);
    const candidate = {
      email: (angled?.[2] ?? trimmed).trim(),
      name: angled?.[1]?.trim().replace(/^["']|["']$/g, "") || null,
    };

    const parsed = recipientSchema.safeParse(candidate);
    if (!parsed.success) {
      invalid.push(trimmed);
      continue;
    }

    const key = parsed.data.email.toLowerCase();
    // Asking the same person twice in one send is never intended.
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push({ ...parsed.data, email: key });
  }

  return { recipients, invalid };
}

/** The version of the KVKK notice shown on the hosted page, stored with consent. */
export const KVKK_NOTICE_VERSION = "2026-08-kvkk-v1";

/**
 * A submission from the public page.
 *
 * Contact details are optional — a walk-in leaving a rating owes us nothing.
 * When they *are* supplied we are processing identifiable personal data beyond
 * the review itself, so the KVKK acknowledgement becomes mandatory. That
 * conditional is the whole point of the refinement below.
 */
export const publicSubmissionSchema = z
  .object({
    slug: z.string().trim().min(1).max(64),
    /** Present when the visitor arrived from a request link. */
    requestToken: z
      .string()
      .trim()
      .max(64)
      .nullish()
      .transform((value) => (value == null || value === "" ? null : value)),
    rating: z.coerce.number().int().min(1).max(5),
    comment: z.string().trim().max(5_000).default(""),
    authorName: z
      .string()
      .trim()
      .max(120)
      .nullish()
      .transform((value) => (value == null || value === "" ? null : value)),
    email: z
      .email()
      .max(254)
      .nullish()
      .transform((value) =>
        value == null || value === "" ? null : (value?.toLowerCase() ?? null),
      ),
    kvkkAccepted: z.boolean().default(false),
    /**
     * A **separate** İYS permission to be sent commercial messages (P1b-T5).
     *
     * Its own field, defaulting to false, and never inferred from
     * `kvkkAccepted`. Turkish law treats the two as different permissions:
     * agreeing that a business may process your data in order to publish your
     * review is not agreeing to be marketed to, and İYS requires the second to
     * have been asked for plainly and on its own. Deriving one from the other
     * would be the exact over-claim the registry exists to prevent.
     *
     * Optional in every case — a review is never conditional on accepting
     * marketing, which is also why there is no refinement tying it to `email`.
     */
    iysAccepted: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.email && !value.kvkkAccepted) {
      ctx.addIssue({
        code: "custom",
        path: ["kvkkAccepted"],
        message: "Leaving contact details requires accepting the privacy notice.",
      });
    }
  });

export type PublicSubmissionInput = z.infer<typeof publicSubmissionSchema>;
