import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/connectors/whatsapp/client";
import { flattenWebhook, webhookSchema } from "@/connectors/whatsapp/schemas";
import { getEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import { recordInboundEvents } from "@/messaging/whatsapp-inbound";

/**
 * Meta's webhook for WhatsApp (P1b-T3).
 *
 * Public and unauthenticated by necessity — Meta will not carry a bearer token —
 * so the `X-Hub-Signature-256` HMAC is the only thing standing between this
 * endpoint and anyone who guesses the URL. An unverified body is rejected
 * before it is parsed, let alone acted on.
 *
 * **It answers 200 to almost everything.** Meta retries a non-2xx with
 * escalating backoff and eventually disables the subscription, so a malformed
 * payload or a message type we do not model must not fail the delivery. The one
 * exception is a bad signature, which is a 403: pretending to accept a forged
 * event would hide an attack.
 *
 * Fixture-tested only — see `docs/11` for the two-stage Definition of Done.
 */

const log = childLogger({ module: "webhooks/whatsapp" });

/**
 * Subscription verification.
 *
 * Meta calls this once with a challenge when the webhook is registered, and the
 * response must echo `hub.challenge` verbatim as plain text.
 */
export async function GET(request: Request): Promise<Response> {
  const env = getEnv();
  const url = new URL(request.url);

  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (!env.WHATSAPP_VERIFY_TOKEN) {
    log.warn("WhatsApp webhook verification attempted with no verify token configured");
    return new NextResponse("not configured", { status: 503 });
  }

  if (mode !== "subscribe" || token !== env.WHATSAPP_VERIFY_TOKEN) {
    // Deliberately identical for a wrong mode and a wrong token: telling a
    // prober which half they got right is free information.
    return new NextResponse("forbidden", { status: 403 });
  }

  return new NextResponse(challenge ?? "", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const env = getEnv();

  if (!env.WHATSAPP_APP_SECRET) {
    log.error("WhatsApp webhook received with no app secret configured; rejecting");
    return new NextResponse("not configured", { status: 503 });
  }

  // The raw text, not the parsed object: the HMAC is over the exact bytes Meta
  // sent, and re-serialising JSON would change them.
  const rawBody = await request.text();

  const verified = verifyWebhookSignature({
    rawBody,
    header: request.headers.get("x-hub-signature-256"),
    appSecret: env.WHATSAPP_APP_SECRET,
  });

  if (!verified) {
    log.warn("Rejected a WhatsApp webhook with an invalid signature");
    return new NextResponse("invalid signature", { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Signed but unparseable. Nothing to do, and retrying will not help.
    log.warn("Signed WhatsApp webhook was not valid JSON");
    return NextResponse.json({ received: true });
  }

  const parsed = webhookSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn({ issues: parsed.error.issues.length }, "Unrecognised WhatsApp webhook shape");
    return NextResponse.json({ received: true });
  }

  try {
    const events = flattenWebhook(parsed.data);
    const outcome = await recordInboundEvents(events);

    log.info(
      {
        messages: events.messages.length,
        statuses: events.statuses.length,
        matched: outcome.matched,
        optOuts: outcome.optOuts,
      },
      "WhatsApp webhook processed",
    );
  } catch (error) {
    // Still a 200. A failure on our side must not make Meta retry a message we
    // may have half-recorded, and the log is where this gets noticed.
    log.error({ err: error }, "Failed to process a WhatsApp webhook");
  }

  return NextResponse.json({ received: true });
}
