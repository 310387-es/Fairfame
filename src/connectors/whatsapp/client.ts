import { createHmac, timingSafeEqual } from "node:crypto";
import type { Locale } from "../../i18n/config.ts";
import { RateLimitError } from "../throttle.ts";
import { ConnectorError } from "../types.ts";
import { errorSchema, sendResponseSchema } from "./schemas.ts";
import { renderTemplate, type TemplateDefinition } from "./templates.ts";

/**
 * The WhatsApp Cloud API client (P1b-T3).
 *
 * Fixture-tested only. A WhatsApp Business Account, a verified number and an
 * approved template are all gated on the company existing, so this is written
 * against Meta's documented contract and pinned with recorded payloads — see
 * the two-stage Definition of Done in `docs/11`.
 *
 * Everything funnels through `request()` so authentication, throttling and
 * error classification happen once. Classification carries most of the weight:
 * Meta answers with HTTP 400 for a great many different situations, and the
 * difference between "this template is not approved yet" and "this number
 * blocked you" is the difference between an operator task and a dead end.
 */

export const WHATSAPP_PROVIDER = "whatsapp";

export type WhatsAppFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type WhatsAppClientOptions = {
  /** Meta's permanent or system-user access token for this WABA. */
  accessToken: string;
  /** The phone number id that sends — not the display number. */
  phoneNumberId: string;
  baseUrl?: string;
  fetchImpl?: WhatsAppFetch;
};

const DEFAULT_BASE_URL = "https://graph.facebook.com/v21.0";

/**
 * Meta error codes worth branching on.
 *
 * Only the ones whose handling actually differs. Everything else is a generic
 * failure, because inventing behaviour for a code we have never seen is how a
 * connector acquires branches nobody can justify.
 */
const ERROR_CODES = {
  /** Rate limited. Meta uses this for both throughput and pair limits. */
  rate_limit: [4, 80007, 130429, 131048],
  /** The recipient cannot receive: not on WhatsApp, or blocked us. */
  undeliverable: [131026, 131047, 131051],
  /** Template problems — missing, unapproved, or paused for quality. */
  template: [132000, 132001, 132005, 132007, 132012, 132015, 132016],
  /** Auth: expired token, revoked permission, wrong number id. */
  auth: [190, 200, 10, 33],
} as const;

export type ErrorKind = keyof typeof ERROR_CODES | "unknown";

/**
 * Maps a Meta error code to how we should react.
 *
 * The keys of `ERROR_CODES` *are* the returned kinds — typed as such, because
 * an earlier version keyed the table in camelCase and compared the result
 * against snake_case. Nothing failed to compile; a WhatsApp rate limit simply
 * never triggered backoff and came back as a generic failure.
 */
function classify(code: number | undefined): ErrorKind {
  if (code === undefined) return "unknown";

  for (const kind of Object.keys(ERROR_CODES) as (keyof typeof ERROR_CODES)[]) {
    if ((ERROR_CODES[kind] as readonly number[]).includes(code)) return kind;
  }
  return "unknown";
}

export type SendResult =
  | { ok: true; messageId: string; waId: string | null }
  | { ok: false; reason: string; retryable: boolean; kind: ErrorKind };

export type WhatsAppClient = {
  sendTemplate(input: {
    to: string;
    template: TemplateDefinition;
    locale: Locale;
    values: string[];
  }): Promise<SendResult>;
  /**
   * Free-form text. **Only legal inside the 24-hour customer service window** —
   * the gate in `src/compliance/gate.ts` is what proves that, not this method.
   */
  sendText(input: { to: string; body: string }): Promise<SendResult>;
  markRead(messageId: string): Promise<void>;
};

export function createWhatsAppClient(options: WhatsAppClientOptions): WhatsAppClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const endpoint = `${baseUrl}/${encodeURIComponent(options.phoneNumberId)}/messages`;

  async function post(body: unknown): Promise<SendResult> {
    let response: Response;

    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // A transport failure is always worth another attempt — nothing was
      // necessarily delivered, and nothing was necessarily not.
      return {
        ok: false,
        kind: "unknown",
        retryable: true,
        reason: `Could not reach the WhatsApp API: ${error instanceof Error ? error.message : "unknown"}`,
      };
    }

    const payload: unknown = await response.json().catch(() => ({}));

    if (!response.ok) {
      const parsed = errorSchema.safeParse(payload);
      const code = parsed.success ? parsed.data.error.code : undefined;
      const kind = classify(code);
      const message = parsed.success ? (parsed.data.error.message ?? "") : "";

      if (kind === "rate_limit" || response.status === 429) {
        // Surfaced as the shared throttle error so the connector backoff in
        // `src/connectors/throttle.ts` handles it like any other provider.
        throw new RateLimitError(
          WHATSAPP_PROVIDER,
          retryAfterMs(response),
          `WhatsApp rate limit reached: ${message}`,
        );
      }

      return {
        ok: false,
        kind,
        // An unapproved template and a blocked recipient will fail identically
        // forever; a 5xx will not.
        retryable: kind === "unknown" && response.status >= 500,
        reason: describe(kind, code, message),
      };
    }

    const parsed = sendResponseSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        kind: "unknown",
        retryable: false,
        reason: "The WhatsApp API returned a success without a message id.",
      };
    }

    return {
      ok: true,
      messageId: parsed.data.messages[0]!.id,
      waId: parsed.data.contacts?.[0]?.wa_id ?? null,
    };
  }

  return {
    async sendTemplate({ to, template, locale, values }) {
      const { parameters } = renderTemplate(template, locale, values);

      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "template",
        template: {
          name: template.name,
          // Meta's locale codes are underscore-separated, not BCP 47.
          language: { code: locale === "tr" ? "tr" : "en" },
          components: [
            {
              type: "body",
              parameters: parameters.map((text) => ({ type: "text", text })),
            },
          ],
        },
      });
    },

    async sendText({ to, body }) {
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        // Link previews off: a review link rendering as a card in a support
        // reply is noise, and the preview fetch leaks the recipient's activity.
        text: { body, preview_url: false },
      });
    },

    async markRead(messageId: string) {
      // Best effort. A read receipt that fails changes nothing a customer sees.
      await post({ messaging_product: "whatsapp", status: "read", message_id: messageId }).catch(
        () => undefined,
      );
    },
  };
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  // Meta rarely sends Retry-After on this endpoint; a minute is their documented
  // guidance for throughput limits.
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 60_000;
}

function describe(kind: ErrorKind, code: number | undefined, message: string): string {
  switch (kind) {
    case "auth":
      return (
        `WhatsApp rejected the credentials (code ${code}). The access token may have expired or ` +
        `the app's permissions were revoked; re-authorize the WhatsApp Business Account.`
      );
    case "template":
      return (
        `WhatsApp rejected the template (code ${code}). It is most likely not approved yet, ` +
        `paused for quality, or missing in this language. See src/connectors/whatsapp/templates.ts.`
      );
    case "undeliverable":
      return `That number cannot receive WhatsApp messages (code ${code}).`;
    default:
      return `WhatsApp send failed${code === undefined ? "" : ` (code ${code})`}: ${message}`;
  }
}

/**
 * Verifies Meta's `X-Hub-Signature-256` header.
 *
 * The webhook endpoint is public, so this is the only thing standing between
 * Meta's events and anyone who guesses the URL. Compared in constant time —
 * a plain `===` on an HMAC leaks the correct prefix through timing, which is
 * enough to forge one byte at a time.
 */
export function verifyWebhookSignature(input: {
  rawBody: string;
  header: string | null;
  appSecret: string;
}): boolean {
  if (!input.header?.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", input.appSecret).update(input.rawBody, "utf8").digest();
  const received = Buffer.from(input.header.slice("sha256=".length), "hex");

  // timingSafeEqual throws on a length mismatch, which is itself a signal —
  // check it first rather than letting the throw become a 500.
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}

/** Digits only, with the country code — what Meta expects in `to`. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;

  // A Turkish number written as 05XX… locally needs the country code; leaving
  // it off silently sends to whatever country the WABA is registered in.
  if (digits.startsWith("0") && digits.length === 11) return `90${digits.slice(1)}`;
  return digits;
}

export { ConnectorError };
