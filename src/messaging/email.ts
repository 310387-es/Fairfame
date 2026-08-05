import { createTransport, type Transporter } from "nodemailer";
import { getEnv } from "../lib/env.ts";
import { childLogger } from "../lib/logger.ts";

/**
 * Outbound email, behind one interface.
 *
 * The same seam every other channel will use: WhatsApp and SMS (P1b-T3, and
 * the İYS-connected gateway in T5) implement a sibling of `EmailTransport`, so
 * the campaign code that decides *what* to say never learns *how* it is sent.
 *
 * Three implementations, and which one runs is configuration:
 *   log     — renders and logs, sends nothing. The default, so no test run or
 *             misconfigured environment can put mail on the wire.
 *   smtp    — talks to SMTP_URL. Locally that is the Mailpit container, whose
 *             inbox is at http://localhost:8025. A production ESP swaps in here
 *             with a URL change and no code change.
 *   capture — in-memory, for assertions in tests.
 */

const log = childLogger({ module: "messaging/email" });

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Replies go to the business, not to us. */
  replyTo?: string;
  /** RFC 8058 one-click opt-out, so mail clients can surface unsubscribe. */
  listUnsubscribeUrl?: string;
  /**
   * Files to attach (P3-T5). Deliberately narrow: a filename, a content type
   * and bytes we produced. There is no path variant and there must not be one —
   * a transport that can read a path is a transport that can be asked to attach
   * `/etc/passwd` by anything upstream that builds a message.
   */
  attachments?: { filename: string; contentType: string; content: Buffer }[];
};

export type EmailResult =
  { ok: true; messageId: string | null } | { ok: false; reason: string; retryable: boolean };

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailResult>;
}

function headersFor(message: EmailMessage): Record<string, string> {
  return message.listUnsubscribeUrl
    ? {
        "List-Unsubscribe": `<${message.listUnsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
    : {};
}

/** Renders the message into the log and stops there. */
export function createLogTransport(): EmailTransport {
  return {
    name: "log",
    async send(message: EmailMessage): Promise<EmailResult> {
      log.info(
        {
          to: message.to,
          subject: message.subject,
          body: message.text,
          // Named and sized, never logged: a PDF in a log line is megabytes of
          // base64 nobody will read and a copy of a customer's data in a place
          // it was not meant to live.
          attachments: message.attachments?.map((attachment) => ({
            filename: attachment.filename,
            bytes: attachment.content.length,
          })),
        },
        "Email not sent (log transport)",
      );
      return { ok: true, messageId: null };
    },
  };
}

/** Records everything it is given. Test-only. */
export function createCaptureTransport(): EmailTransport & { readonly sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];

  return {
    name: "capture",
    sent,
    async send(message: EmailMessage): Promise<EmailResult> {
      sent.push(message);
      return { ok: true, messageId: `capture-${sent.length}` };
    },
  };
}

export function createSmtpTransport(url = getEnv().SMTP_URL, from = getEnv().EMAIL_FROM) {
  let transporter: Transporter | undefined;

  return {
    name: "smtp",
    async send(message: EmailMessage): Promise<EmailResult> {
      // Built on first use: constructing a transporter at module load would
      // require SMTP configuration merely to import this file.
      transporter ??= createTransport(url);

      try {
        const info = await transporter.sendMail({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          replyTo: message.replyTo,
          headers: headersFor(message),
          ...(message.attachments
            ? {
                attachments: message.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  contentType: attachment.contentType,
                  content: attachment.content,
                })),
              }
            : {}),
        });

        return { ok: true, messageId: info.messageId ?? null };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown SMTP failure.";
        // 4xx SMTP replies are transient, 5xx are permanent. Anything without a
        // code (a socket error, a DNS failure) is treated as transient.
        const code = (error as { responseCode?: number }).responseCode;
        const retryable = code === undefined || code < 500;

        log.warn({ to: message.to, code, err: error }, "SMTP send failed");
        return { ok: false, reason, retryable };
      }
    },
  } satisfies EmailTransport;
}

let configured: EmailTransport | undefined;

/** The transport this environment is configured to use. Cached. */
export function getEmailTransport(): EmailTransport {
  configured ??= getEnv().EMAIL_TRANSPORT === "smtp" ? createSmtpTransport() : createLogTransport();
  return configured;
}

/** Swaps the transport for a test, and restores it with `null`. */
export function setEmailTransportForTesting(transport: EmailTransport | null): void {
  configured = transport ?? undefined;
}
