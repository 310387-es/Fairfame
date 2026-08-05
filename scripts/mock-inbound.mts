/**
 * Posts a WhatsApp webhook to this deployment, as Meta would.
 *
 *   pnpm mock:inbound --phone +905321112233 --text "merhaba"
 *   pnpm mock:inbound --phone +905321112233 --status read --id wamid.mock-…
 *
 * **The point is that it is not a back door.** It builds Meta's own envelope,
 * signs it with `WHATSAPP_APP_SECRET` exactly as Meta does, and POSTs it to the
 * real `/api/webhooks/whatsapp` — so the signature check, the Zod schema, the
 * contact lookup, the opt-out branch and the dedup index are all exercised. A
 * developer-only endpoint that skipped them would prove the *inbox* works while
 * leaving the path a customer's message actually takes untested.
 *
 * That closes P4-T3's round trip: `CONNECTOR_WHATSAPP_MODE=mock` lets an
 * outbound reply be accepted without a WhatsApp Business Account, and this
 * brings the customer's side back. Neither reaches a phone, and both say so.
 */

import { createHmac } from "node:crypto";
import { getEnv } from "../src/lib/env.ts";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const env = getEnv();

if (!env.WHATSAPP_APP_SECRET) {
  console.error(
    "WHATSAPP_APP_SECRET is not set. The webhook rejects an unsigned body with 503, which is\n" +
      "correct — set any value locally and this script will sign with it.",
  );
  process.exit(1);
}

const phone = flag("phone");
if (!phone) {
  console.error('Usage: pnpm mock:inbound --phone +905321112233 [--text "merhaba"]');
  console.error("       pnpm mock:inbound --phone … --status read --id wamid.mock-…");
  process.exit(1);
}

const baseUrl = flag("url") ?? "http://localhost:3000";
const text = flag("text") ?? "Merhaba, bir sorum var.";
const status = flag("status");
const statusId = flag("id");
const timestamp = String(Math.floor(Date.now() / 1_000));

/** Digits only with the country code, which is what Meta puts in `from`. */
const waId = phone.replace(/\D/g, "");

const value = status
  ? {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: waId, phone_number_id: "mock-phone-number-id" },
      statuses: [
        {
          id: statusId ?? "",
          status,
          timestamp,
          recipient_id: waId,
        },
      ],
    }
  : {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: waId, phone_number_id: "mock-phone-number-id" },
      contacts: [{ wa_id: waId, profile: { name: "Mock Customer" } }],
      messages: [
        {
          from: waId,
          // Prefixed so it can never be confused with a real `wamid`, and
          // unique so a second run is a second message rather than a
          // redelivery — re-run with the same id to exercise the dedup index.
          id: flag("id") ?? `wamid.mock-in-${Date.now()}`,
          timestamp,
          type: "text",
          text: { body: text },
        },
      ],
    };

const payload = {
  object: "whatsapp_business_account",
  entry: [{ id: "mock-waba-id", changes: [{ field: "messages", value }] }],
};

// The HMAC is over the exact bytes, so the body is serialised once and both
// signed and sent — re-serialising would change them and fail verification.
const rawBody = JSON.stringify(payload);
const signature = createHmac("sha256", env.WHATSAPP_APP_SECRET)
  .update(rawBody, "utf8")
  .digest("hex");

const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/webhooks/whatsapp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-hub-signature-256": `sha256=${signature}`,
  },
  body: rawBody,
});

console.log(`${response.status} ${response.statusText} — ${await response.text()}`);

if (!response.ok) process.exitCode = 1;
else if (status) console.log(`Receipt "${status}" delivered for ${statusId ?? "(no id)"}.`);
else console.log(`Inbound message from ${phone} delivered. Check /messages.`);
